import { describe, expect, it } from "vitest";
import { compareCommand, proposalCommand, sourcesCommand, voteDraftCommand } from "@vennek/cardano-governance-skills";
import { validateOutput } from "@vennek/cardano-governance-skills";

describe("governance commands", () => {
  it("/proposal returns grounded proposal analysis with citations and no stance", async () => {
    const result = await proposalCommand("catalyst-review-workbench");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Draft analysis; human decides.");
    expect(result.text).toContain("Problem:");
    expect(result.text).toContain("Citations:");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.text).not.toMatch(/you should vote|vote yes|vote no/i);
    expect(validateOutput(result)).toEqual([]);
  });

  it("/compare uses a fixed rubric and cites both documents", async () => {
    const result = await compareCommand("catalyst-review-workbench", "drep-rationale-kit");
    expect(result.text).toContain("Impact:");
    expect(result.text).toContain("Feasibility:");
    expect(result.text).toContain("Budget/resources:");
    expect(result.text).toContain("Evidence quality:");
    expect(result.text).toContain("Risk:");
    expect(result.citations.some((citation) => citation.id.startsWith("CRW"))).toBe(true);
    expect(result.citations.some((citation) => citation.id.startsWith("DRK"))).toBe(true);
    expect(validateOutput(result)).toEqual([]);
  });

  it("/vote-draft requires explicit human stance", async () => {
    await expect(voteDraftCommand("drep-rationale-kit", "yes")).rejects.toThrow(/requires a human-selected stance/i);

    const result = await voteDraftCommand("drep-rationale-kit", "abstain");
    expect(result.text).toContain("Selected stance: abstain");
    expect(result.text).toContain("not selecting the stance");
    expect(result.text).not.toMatch(/you should vote|vote yes|vote no/i);
    expect(validateOutput(result)).toEqual([]);
  });

  it("/sources reports explicit source-unavailable status when citations are missing", async () => {
    const result = await sourcesCommand("source-limited-governance-note");
    expect(result.sourceStatus).toBe("unavailable");
    expect(result.text).toMatch(/Source unavailable/i);
    expect(validateOutput(result)).toEqual([]);
  });
});
