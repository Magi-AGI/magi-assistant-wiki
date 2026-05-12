import { describe, expect, it } from "vitest";
import { tokenBudget } from "../src/middleware/token-budget";

describe("tokenBudget", () => {
  it("returns 0 tokens for empty input", () => {
    const r = tokenBudget([]);
    expect(r.estimatedTokens).toBe(0);
    expect(r.totalChars).toBe(0);
  });

  it("approximates ~4 chars/token plus 8-char per-message overhead", () => {
    const r = tokenBudget([{ role: "user", content: "hello world" }]); // 11 chars + 8 overhead = 19
    expect(r.totalChars).toBe(19);
    expect(r.estimatedTokens).toBe(Math.ceil(19 / 4));
  });

  it("sums across multiple turns", () => {
    const r = tokenBudget([
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(200) },
      { role: "user", content: "c".repeat(300) },
    ]);
    expect(r.totalChars).toBe(100 + 200 + 300 + 24);
    expect(r.estimatedTokens).toBe(Math.ceil(624 / 4));
  });
});
