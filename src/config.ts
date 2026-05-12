/** Process-wide configuration loaded from environment. */

import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer; got "${v}"`);
  return n;
}

/** Allowlisted models per plan B-3. Reject anything else. */
export const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
]);

export const config = {
  // Anthropic API
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  // hyperon-wiki MCP subprocess auth
  mcpApiKey: process.env.MCP_API_KEY ?? "",
  mcpRole: process.env.MCP_ROLE ?? "user",
  mcpUsername: process.env.MCP_USERNAME ?? "",
  mcpPassword: process.env.MCP_PASSWORD ?? "",
  deckoApiBaseUrl: process.env.DECKO_API_BASE_URL ?? "https://wiki.hyperon.dev/api/mcp",

  // Server
  port: intEnv("PORT", 8766),

  // Defaults
  defaultModel: process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6",

  // Limits
  maxConversationTokensAuth: intEnv("MAX_CONVERSATION_TOKENS_AUTH", 16_000),
  maxConversationTokensAnon: intEnv("MAX_CONVERSATION_TOKENS_ANON", 6_000),
  agentTimeoutMs: intEnv("AGENT_TIMEOUT_MS", 30_000),

  // Logging
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

export function validateMcpAuth(): void {
  if (!config.mcpApiKey && !config.mcpUsername) {
    throw new Error(
      "MCP authentication missing: set MCP_API_KEY+MCP_ROLE or MCP_USERNAME+MCP_PASSWORD",
    );
  }
}
