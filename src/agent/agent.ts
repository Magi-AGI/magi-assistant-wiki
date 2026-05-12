/**
 * Claude Agent SDK wiring: connect to the hyperon-wiki MCP server over HTTP
 * (existing hyperon-mcp-http.service on the EC2 host), with a JWT fetched per
 * turn from /api/mcp/auth using the service-account credentials.
 *
 * Plan tasks covered: B-4 (tool allowlist), B-6 (streaming), B-8 (error path).
 * Plan invariants: I-3 (agent→MCP only via published server), I-6 (funnel intent
 * preserved by SYSTEM_PROMPT), I-10 (PLN No-Go — assistant does not claim inference).
 */

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "./prompt.js";

/**
 * V1 tool allowlist (plan B-4). The agent is a public reader — no write tools,
 * no admin tools. The MCP server prefix is added by the SDK when it lists MCP
 * tools to Claude (`mcp__<server-name>__<tool>`).
 *
 * Server name is "hyperon-wiki" — must match both the key under mcpServers
 * below and the serverInfo.name advertised by the upstream MCP server.
 */
const MCP_SERVER_NAME = "hyperon-wiki";
const ALLOWED_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__search_cards`,
  `mcp__${MCP_SERVER_NAME}__get_card`,
  `mcp__${MCP_SERVER_NAME}__list_children`,
  `mcp__${MCP_SERVER_NAME}__get_relationships`,
];

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RunAgentOptions {
  /** Conversation history; the last entry MUST be a user turn. */
  messages: ChatMessage[];
  /** Optional model override; rejected by route layer if not allowlisted. */
  model?: string;
  /** Abort signal for hard wall-clock budget (plan I-5: 30s default). */
  signal?: AbortSignal;
}

interface AuthResponse {
  token: string;
  expires_at: number;
  role?: string;
}

// In-process JWT cache. Decko issues 1h tokens; we refresh when <5 min remain.
// Per-process cache is fine for V1 — a single instance serves all turns.
let cachedToken: { token: string; expiresAtMs: number } | null = null;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

async function fetchMcpToken(): Promise<string> {
  if (config.mcpApiKey) return config.mcpApiKey;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + REFRESH_SKEW_MS) {
    return cachedToken.token;
  }

  if (!config.mcpUsername || !config.mcpPassword) {
    throw new Error("MCP auth not configured: set MCP_USERNAME + MCP_PASSWORD or MCP_API_KEY");
  }

  const res = await fetch(config.mcpAuthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: config.mcpUsername,
      password: config.mcpPassword,
      role: config.mcpRole,
    }),
  });
  if (!res.ok) {
    throw new Error(`MCP auth failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as AuthResponse;
  cachedToken = { token: body.token, expiresAtMs: body.expires_at * 1000 };
  return body.token;
}

function formatPrompt(messages: ChatMessage[]): string {
  // The Agent SDK's query() takes a single prompt string per call (stateless V1
  // per plan I-4 — no session ID, no conversation memory on the agent side).
  // We render the prior conversation as a transcript so the model sees context.
  if (messages.length === 1 && messages[0].role === "user") {
    return messages[0].content;
  }
  if (messages[messages.length - 1]?.role !== "user") {
    throw new Error("Last message must be from user");
  }
  const lines: string[] = [];
  for (const m of messages) {
    const tag = m.role === "user" ? "User" : "Assistant";
    lines.push(`${tag}: ${m.content}`);
  }
  return lines.join("\n\n");
}

function buildOptions(model: string, token: string, signal?: AbortSignal): Options {
  return {
    model,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ALLOWED_TOOLS,
    permissionMode: "bypassPermissions", // server-side; no interactive approvals
    abortController: signal ? (toAbortController(signal) as AbortController) : undefined,
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

function toAbortController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl;
}

/**
 * Stream a single agent turn. Yields SDKMessage objects as they arrive.
 *
 * Caller (the SSE route) is responsible for translating these into client-facing
 * SSE events: assistant deltas → {type:"delta",text:...}, tool calls →
 * {type:"tool_use",name:...}, final → {type:"done"}.
 */
export async function* runAgent(
  opts: RunAgentOptions,
): AsyncGenerator<SDKMessage, void, unknown> {
  const model = opts.model ?? config.defaultModel;
  const prompt = formatPrompt(opts.messages);
  const token = await fetchMcpToken();
  const sdkOptions = buildOptions(model, token, opts.signal);

  for await (const message of query({ prompt, options: sdkOptions })) {
    yield message;
  }
}
