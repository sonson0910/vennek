import { describe, expect, it } from "vitest";
import type { CommandResult } from "@vennek/shared";
import { assertSafeOutput, validateOutput } from "@vennek/cardano-governance-skills";

const safeCitation = {
  id: "S1",
  url: "https://projectcatalyst.io/example",
  snippet: "Example source snippet",
  retrievedAt: "2026-07-04T00:00:00.000Z"
};

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "test",
    ok: true,
    text: "Draft analysis; human decides.\nCitations:\n[S1] https://projectcatalyst.io/example\n    Snippet: Example source snippet",
    citations: [safeCitation],
    sourceStatus: "available",
    warnings: [],
    ...overrides
  };
}

describe("safety output guards", () => {
  it("requires the human decision frame", () => {
    expect(validateOutput(result({ text: "Citations:\n[S1] ok" }))).toContainEqual(expect.stringMatching(/Missing required human decision frame/));
  });

  it("rejects forbidden recommendation and custody phrases", () => {
    for (const phrase of [
      "you should vote",
      "vote yes",
      "vote no",
      "seed phrase",
      "private key",
      "auto-vote",
      "auto-sign",
      "wallet connector",
      "connect your wallet",
      "submit transaction for you",
      "send funds",
      "trading advice",
      "investment advice"
    ]) {
      expect(validateOutput(result({ text: `Draft analysis; human decides. ${phrase}\nCitations:\n[S1] ok` }))).not.toEqual([]);
    }
  });

  it("throws via assertSafeOutput when unsafe", () => {
    expect(() => assertSafeOutput(result({ text: "Draft analysis; human decides. vote yes" }))).toThrow(/Unsafe command output/);
  });

  it("allows missing citations only with explicit source unavailable status", () => {
    expect(validateOutput(result({ citations: [], sourceStatus: "unavailable", text: "Draft analysis; human decides.\nSource unavailable: no source attached." }))).toEqual([]);
    expect(validateOutput(result({ citations: [], sourceStatus: "available", text: "Draft analysis; human decides." }))).toContainEqual(expect.stringMatching(/citations or explicit source-unavailable/));
  });
});
