import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateEvaluationMetrics,
  parseEvaluationCorpus,
  validateEvaluationThresholds,
  type EvaluationCase,
} from "../packages/cardano-agent/src/evaluation/metrics.js";
import { missingLiveCredentials } from "../scripts/evaluate-cardano-rag.js";

const registry = JSON.parse(readFileSync(new URL("../config/cardano-sources.json", import.meta.url), "utf8")) as {
  official: Array<{ id: string; trustTier: "official" }>;
  community: Array<{ id: string; trustTier: "community" }>;
};
const sourceTiers = new Map(
  [...registry.official, ...registry.community].map((entry) => [entry.id, entry.trustTier] as const),
);
const corpusText = readFileSync(new URL("../samples/evaluation/cardano-rag.jsonl", import.meta.url), "utf8");

describe("Cardano RAG evaluation corpus and metrics", () => {
  it("loads the checked-in corpus with exact category, language, and current-evidence coverage", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceTiers);
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((item) => item.category))).toEqual(new Set([
      "fundamentals", "consensus", "staking", "assets", "transactions", "wallets",
      "Plutus/Aiken", "nodes/APIs", "governance/CIPs", "Catalyst", "ecosystem", "failure/adversarial",
    ]));
    for (const category of new Set(cases.map((item) => item.category))) {
      expect(cases.filter((item) => item.category === category)).toHaveLength(5);
    }
    expect(cases.filter((item) => item.language === "vi").length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((item) => item.currentEvidenceRequired).length).toBeGreaterThanOrEqual(5);
  });

  it("passes the checked-in deterministic fixtures at the release thresholds", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceTiers);
    const metrics = calculateEvaluationMetrics(cases, sourceTiers);
    expect(metrics.recallAt10).toBe(1);
    expect(metrics.citationPrecision).toBe(1);
    expect(metrics.unsupportedClaimCount).toBe(0);
    expect(metrics.communityOverridesOfficial).toBe(0);
    expect(validateEvaluationThresholds(metrics)).toBe(true);
  });

  it("uses source-level recall and rejects a case at the 90% boundary", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceTiers);
    const degraded = cases.map((item, index) => index < 7
      ? { ...item, retrieval: item.retrieval.filter((fixture) => fixture.sourceId !== item.requiredSourceIds[0]) }
      : item);
    const metrics = calculateEvaluationMetrics(degraded, sourceTiers);
    expect(metrics.recallAt10).toBeLessThan(0.99);
    expect(() => validateEvaluationThresholds(metrics)).toThrow(/recall/i);
  });

  it("counts only explicitly gold-supported citations as precise", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceTiers);
    const item = cases[0]!;
    const altered: EvaluationCase = {
      ...item,
      answer: {
        ...item.answer,
        citations: [{ claimId: item.answer.claims[0]!.id, sourceId: "cardano-forum" }],
      },
    };
    const metrics = calculateEvaluationMetrics([altered], sourceTiers);
    expect(metrics.citationPrecision).toBe(0);
    expect(metrics.communityOverridesOfficial).toBe(1);
    expect(() => validateEvaluationThresholds(metrics)).toThrow(/precision|override/i);
  });

  it("rejects malformed rows, duplicate IDs, unknown sources, and unknown fields", () => {
    expect(() => parseEvaluationCorpus("{}\n", sourceTiers)).toThrow(/keys|id|category/i);
    const valid = parseEvaluationCorpus(corpusText, sourceTiers);
    const duplicate = valid.slice(0, 2).map((item) => JSON.stringify({ ...item, id: valid[0]!.id })).join("\n");
    expect(() => parseEvaluationCorpus(duplicate, sourceTiers)).toThrow(/duplicate/i);
    const unknownSource = JSON.stringify({ ...valid[0], requiredSourceIds: ["not-a-source"] });
    expect(() => parseEvaluationCorpus(unknownSource, sourceTiers)).toThrow(/source/i);
    const unknownField = JSON.stringify({ ...valid[0], unexpected: true });
    expect(() => parseEvaluationCorpus(unknownField, sourceTiers)).toThrow(/unknown|keys/i);
  });

  it("reports every missing live credential by name without exposing values", () => {
    expect(missingLiveCredentials({})).toEqual([
      "DATABASE_URL", "LITELLM_BASE_URL", "LITELLM_API_KEY", "VENNEK_MODEL_FAST",
      "VENNEK_MODEL_QUALITY", "VENNEK_MODEL_VERIFIER", "VENNEK_EMBEDDING_MODEL", "GITHUB_TOKEN",
    ]);
  });
});
