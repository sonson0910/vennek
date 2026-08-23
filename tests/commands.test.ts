import { describe, expect, it } from "vitest";
import { compareCommand, proposalCommand, sourcesCommand, voteDraftCommand } from "@vennek/cardano-governance-skills";
import { validateOutput } from "@vennek/cardano-governance-skills";
import { normalizeUserProvidedText } from "@vennek/cardano-governance-skills";

describe("governance commands", () => {
  it("/proposal returns grounded proposal analysis with citations and no stance", async () => {
    const result = await proposalCommand("catalyst-review-workbench");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Draft analysis; human decides.");
    expect(result.text).toContain("Source-stated problem:");
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
    expect(result.citations.some((citation) => citation.id.startsWith("CATALYST-REVIEW-WORKBENCH-"))).toBe(true);
    expect(result.citations.some((citation) => citation.id.startsWith("DREP-RATIONALE-KIT-"))).toBe(true);
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

  it("binds late claims to exact excerpts with document-scoped ids", async () => {
    const padding = "Background context. ".repeat(25);
    const result = await proposalCommand(
      `${padding} Problem: reviewers cannot trace late claims. Budget request: 42 ADA.`,
      { enableFixtures: false, now: new Date("2026-07-04T00:00:00.000Z") }
    );
    const problem = result.citations.find((citation) => citation.id.endsWith("-PROBLEM"));
    expect(problem?.snippet).toContain("reviewers cannot trace late claims");
    expect(result.text).toContain(`[${problem?.id}]`);
  });

  it("namespaces comparison citations by document", async () => {
    const left = normalizeUserProvidedText({ text: "Problem: left impact evidence is explicit and reviewable.", title: "Left" });
    const right = normalizeUserProvidedText({ text: "Problem: right impact evidence is explicit and reviewable.", title: "Right" });
    const result = await compareCommand("left", "right", {
      enableFixtures: false,
      documents: [{ ...left, id: "left" }, { ...right, id: "right" }]
    });
    expect(new Set(result.citations.map((citation) => citation.id)).size).toBe(result.citations.length);
  });

  it("keeps citations distinct when long document ids share a prefix", async () => {
    const left = normalizeUserProvidedText({ text: "Impact: left source statement is supported.", title: "Left" });
    const right = normalizeUserProvidedText({ text: "Impact: right source statement is supported.", title: "Right" });
    const sharedPrefix = "document-" + "x".repeat(40);
    const leftId = `${sharedPrefix}-left`;
    const rightId = `${sharedPrefix}-right`;
    const result = await compareCommand(leftId, rightId, {
      enableFixtures: false,
      documents: [
        { ...left, id: leftId },
        { ...right, id: rightId }
      ]
    });
    expect(result.citations).toHaveLength(2);
    expect(new Set(result.citations.map((citation) => citation.id)).size).toBe(2);
    expect(result.citations.find((citation) => citation.snippet.includes("left source statement"))?.url).toBe(left.url);
    expect(result.citations.find((citation) => citation.snippet.includes("right source statement"))?.url).toBe(right.url);
  });

  it("marks a source unavailable when no analyzed claim has a citation", async () => {
    const result = await proposalCommand("Neutral background prose without claim labels.", {
      enableFixtures: false,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(result.sourceStatus).toBe("unavailable");
    expect(result.citations).toEqual([]);
    expect(result.text).toContain("[source unavailable]");
    expect(validateOutput(result)).toEqual([]);
  });

  it("marks a comparison unavailable when neither side has an analyzed citation", async () => {
    const left = normalizeUserProvidedText({ text: "Neutral left background prose.", title: "Left" });
    const right = normalizeUserProvidedText({ text: "Neutral right background prose.", title: "Right" });
    const result = await compareCommand("left-neutral", "right-neutral", {
      enableFixtures: false,
      documents: [{ ...left, id: "left-neutral" }, { ...right, id: "right-neutral" }]
    });
    expect(result.sourceStatus).toBe("unavailable");
    expect(result.citations).toEqual([]);
    expect(result.text).toContain("[source unavailable]");
    expect(validateOutput(result)).toEqual([]);
  });

  it("keeps short normalized ids distinct and binds each snippet to its document", async () => {
    const left = normalizeUserProvidedText({ text: "Impact: left short-id evidence.", title: "Left" });
    const right = normalizeUserProvidedText({ text: "Impact: right short-id evidence.", title: "Right" });
    const result = await compareCommand("foo/bar", "foo-bar", {
      enableFixtures: false,
      documents: [{ ...left, id: "foo/bar" }, { ...right, id: "foo-bar" }]
    });
    expect(result.citations).toHaveLength(2);
    expect(new Set(result.citations.map((citation) => citation.id)).size).toBe(2);
    expect(result.citations.find((citation) => citation.snippet.includes("left short-id"))?.url).toBe(left.url);
    expect(result.citations.find((citation) => citation.snippet.includes("right short-id"))?.url).toBe(right.url);
  });

  it("does not cite metadata claims absent from the source span", async () => {
    const document = {
      ...normalizeUserProvidedText({ text: "A neutral source body with no labeled claim.", title: "Metadata only" }),
      id: "metadata-only",
      metadata: { impact: "Metadata impact claim not present in the source body." }
    };
    const result = await proposalCommand("metadata-only", { enableFixtures: false, documents: [document] });
    expect(result.citations.some((citation) => citation.id.endsWith("-IMPACT"))).toBe(false);
    expect(result.text).toContain("Source-stated impact: Metadata impact claim not present in the source body. [source unavailable]");
    expect(validateOutput(result)).toEqual([]);
  });

  it("bounds rendered supported claims to their citation snippet", async () => {
    const longProblem = `Problem: ${"A".repeat(320)}.`;
    const result = await proposalCommand(longProblem, { enableFixtures: false });
    const problem = result.citations.find((citation) => citation.id.endsWith("-PROBLEM"));
    expect(problem).toBeDefined();
    expect(problem!.snippet.length).toBeLessThanOrEqual(260);
    expect(result.text).toContain(`Source-stated problem: ${problem!.snippet} [${problem!.id}]`);
  });

  it("skips blank URL candidates and reports partial claim availability", async () => {
    const leftBase = normalizeUserProvidedText({ text: "Impact: left fallback evidence.", title: "Left" });
    const rightBase = normalizeUserProvidedText({ text: "Impact: right blank-url evidence.", title: "Right" });
    const blankCitation = (id: string, snippet: string) => ({ id, url: " ", snippet, retrievedAt: "2026-07-04T00:00:00.000Z" });
    const left = {
      ...leftBase,
      id: "left-fallback",
      url: " ",
      citations: [blankCitation("LEFT-BLANK", leftBase.body), { ...blankCitation("LEFT-GOOD", leftBase.body), url: "https://left.example/source" }]
    };
    const right = {
      ...rightBase,
      id: "right-blank",
      url: " ",
      citations: [blankCitation("RIGHT-BLANK", rightBase.body)]
    };
    const result = await compareCommand("left-fallback", "right-blank", {
      enableFixtures: false,
      documents: [left, right]
    });
    expect(result.sourceStatus).toBe("partial");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.url).toBe("https://left.example/source");
    expect(result.text).toContain("[source unavailable]");
    expect(validateOutput(result)).toEqual([]);
  });
});
