/**
 * Cheap token-budget estimator for conversation-cap enforcement (plan B-5).
 *
 * We approximate at ~4 chars/token, which is accurate enough for a coarse cap.
 * The real budget is server-side defense; the user-facing UX is "you exceeded
 * the cap, truncate and retry" — being a few % off is fine.
 */

import type { ChatMessage } from "../agent/agent.js";

const CHARS_PER_TOKEN = 4;

export interface BudgetReport {
  estimatedTokens: number;
  totalChars: number;
}

export function tokenBudget(messages: readonly ChatMessage[]): BudgetReport {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += m.content.length;
    // Add small overhead per message for role/turn boundary tokens.
    totalChars += 8;
  }
  return {
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    totalChars,
  };
}
