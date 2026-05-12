/**
 * POST /api/assistant/chat — SSE-streamed agent turn.
 *
 * Plan tasks: B-2 (endpoint), B-3 (model allowlist), B-5 (token cap), B-6 (SSE),
 * B-8 (fallback message on Anthropic failure), B-9 (telemetry — NO chat content).
 */

import type { Request, Response } from "express";
import { ALLOWED_MODELS, config } from "../config.js";
import { runAgent, type ChatMessage } from "../agent/agent.js";
import { tokenBudget } from "../middleware/token-budget.js";

interface ChatRequestBody {
  messages?: ChatMessage[];
  model?: string;
}

const FALLBACK_MESSAGE =
  "I can't reach the language model right now. The wiki itself is available — " +
  "try the sidebar navigation, or visit ASI Create at https://create.singularitynet.io/.";

function writeEvent(res: Response, type: string, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function logTelemetry(entry: Record<string, unknown>): void {
  // Plan B-9 / I-7: log envelope only — NO message content. Aggregate metrics only.
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

export async function chatRoute(req: Request, res: Response): Promise<void> {
  const body = req.body as ChatRequestBody | undefined;
  const messages = body?.messages ?? [];
  const requestedModel = body?.model ?? config.defaultModel;

  // Validation
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }
  if (messages[messages.length - 1]?.role !== "user") {
    res.status(400).json({ error: "last message must be from user" });
    return;
  }
  if (!ALLOWED_MODELS.has(requestedModel)) {
    res.status(400).json({ error: `model ${requestedModel} not allowed` });
    return;
  }

  // Token budget enforcement — server-side belt-and-suspenders. Nginx rate-limits
  // request count; this caps conversation length (plan B-5).
  const isSignedIn = Boolean(req.cookies?._hyperon_session);
  const tokenCap = isSignedIn
    ? config.maxConversationTokensAuth
    : config.maxConversationTokensAnon;
  const budget = tokenBudget(messages);
  if (budget.estimatedTokens > tokenCap) {
    res.status(413).json({
      error: `conversation exceeds ${tokenCap} token cap; truncate older turns and retry`,
      estimated_tokens: budget.estimatedTokens,
    });
    return;
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Nginx: disable response buffering on SSE
  res.flushHeaders?.();

  const startedAt = Date.now();
  const turnId = `t_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  let toolCalls = 0;
  let assistantChars = 0;
  type Status = "ok" | "timeout" | "error";
  let status: Status = "ok";
  const setStatus = (s: Status) => {
    status = s;
  };

  // Hard wall-clock budget (plan I-5).
  const abortCtrl = new AbortController();
  const timeoutHandle = setTimeout(() => {
    setStatus("timeout");
    abortCtrl.abort();
  }, config.agentTimeoutMs);

  // Detach if the client disconnects mid-stream. Note: must be res.on("close"),
  // not req.on("close") — in Node 20+ req fires "close" as soon as the request
  // body has been fully consumed by upstream middleware (express.json), not
  // when the socket actually closes. res "close" fires on real disconnect.
  res.on("close", () => {
    if (!res.writableEnded) abortCtrl.abort();
  });

  try {
    const stream = runAgent({
      messages,
      model: requestedModel,
      signal: abortCtrl.signal,
    });
    for await (const message of stream) {
      // The SDK emits a heterogeneous union; we translate a few interesting cases.
      // Anything else passes through as a generic "raw" event for client-side debug.
      switch (message.type) {
        case "assistant": {
          // Assistant message blocks. content is an array of blocks (text|tool_use|...).
          const content = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                (block as { type?: string }).type === "text"
              ) {
                const text = (block as { text?: string }).text ?? "";
                if (text) {
                  assistantChars += text.length;
                  writeEvent(res, "delta", { text });
                }
              } else if (
                block &&
                typeof block === "object" &&
                (block as { type?: string }).type === "tool_use"
              ) {
                const name = (block as { name?: string }).name ?? "unknown";
                toolCalls += 1;
                writeEvent(res, "tool_use", { name });
              }
            }
          }
          break;
        }
        case "result": {
          // Final result event. SDK includes total tokens; we forward a "done".
          writeEvent(res, "done", { turn_id: turnId });
          break;
        }
        default: {
          // Other event types (init, system, etc.) — emit nothing to client; useful
          // hooks for future telemetry.
          break;
        }
      }
    }
  } catch (err: unknown) {
    if ((status as Status) !== "timeout") setStatus("error");
    if (!res.writableEnded) {
      writeEvent(res, "delta", { text: FALLBACK_MESSAGE });
      writeEvent(res, "done", { turn_id: turnId, fallback: true });
    }
    // Surface to the structured log for debugging; never user-facing.
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack?.split("\n").slice(0, 6).join(" | ") : undefined;
    const errCause = err instanceof Error && (err as Error & { cause?: unknown }).cause
      ? String((err as Error & { cause?: unknown }).cause)
      : undefined;
    process.stderr.write(
      `${JSON.stringify({ level: "error", turn_id: turnId, error: errMsg, stack: errStack, cause: errCause })}\n`,
    );
  } finally {
    clearTimeout(timeoutHandle);
    res.end();
    logTelemetry({
      turn_id: turnId,
      model: requestedModel,
      message_count: messages.length,
      tool_calls: toolCalls,
      assistant_chars: assistantChars,
      latency_ms: Date.now() - startedAt,
      status,
      auth_tier: isSignedIn ? "signed_in" : "anonymous",
      estimated_input_tokens: budget.estimatedTokens,
    });
  }
}
