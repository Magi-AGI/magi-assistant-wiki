/**
 * Claude Agent SDK wiring: spawn the hyperon-wiki-mcp stdio subprocess,
 * configure the tool allowlist, and stream a turn.
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
 * Server name is "hyperon-wiki" — must match the key under mcpServers below.
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

/** Convert a conversation history into a single prompt for the SDK's query(). */
function formatPrompt(messages: ChatMessage[]): string {
  // The Agent SDK's query() takes a single prompt string per call (stateless V1
  // per plan I-4 — no session ID, no conversation memory on the agent side).
  // We render the prior conversation as a transcript so the model sees context.
  if (messages.length === 1 && messages[0].role === "user") {
    return messages[0].content;
  }
  const lines: string[] = [];
  for (const m of messages) {
    const tag = m.role === "user" ? "User" : "Assistant";
    lines.push(`${tag}: ${m.content}`);
  }
  // Trailing newline + cue so the SDK knows where the user's latest turn ends.
  if (messages[messages.length - 1]?.role !== "user") {
    throw new Error("Last message must be from user");
  }
  return lines.join("\n\n");
}

function buildOptions(model: string, signal?: AbortSignal): Options {
  return {
    model,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ALLOWED_TOOLS,
    permissionMode: "bypassPermissions", // server-side; no interactive approvals
    abortController: signal ? (toAbortController(signal) as AbortController) : undefined,
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: "hyperon-wiki-mcp",
        args: [],
        env: buildMcpEnv(),
      },
    },
  };
}

function buildMcpEnv(): Record<string, string> {
  const env: Record<string, string> = {
    DECKO_API_BASE_URL: config.deckoApiBaseUrl,
  };
  if (config.mcpApiKey) {
    env.MCP_API_KEY = config.mcpApiKey;
    env.MCP_ROLE = config.mcpRole;
  } else if (config.mcpUsername) {
    env.MCP_USERNAME = config.mcpUsername;
    env.MCP_PASSWORD = config.mcpPassword;
  }
  // PATH must propagate so hyperon-wiki-mcp can find Ruby/bundler on the deploy host.
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

function toAbortController(signal: AbortSignal): AbortController {
  // The SDK wants an AbortController, not a signal. Forward an external signal
  // onto a fresh controller so the SDK can call .abort() and we can too.
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
  const sdkOptions = buildOptions(model, opts.signal);

  for await (const message of query({ prompt, options: sdkOptions })) {
    yield message;
  }
}
