import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateEvaluationMetrics,
  parseEvaluationCorpus,
  validateEvaluationCoverage,
  validateEvaluationThresholds,
  type EvaluationSourceCatalog,
  type EvaluationCase,
} from "../packages/cardano-agent/src/evaluation/metrics.js";
import { missingLiveCredentials, resolveLiveResolution, writeLiveReport } from "../scripts/evaluate-cardano-rag.js";

const registry = JSON.parse(readFileSync(new URL("../config/cardano-sources.json", import.meta.url), "utf8")) as {
  official: Array<{ id: string; trustTier: "official"; url: string; allowedDomains: string[] }>;
  community: Array<{ id: string; trustTier: "community"; url: string; allowedDomains: string[] }>;
};
const sourceCatalog: EvaluationSourceCatalog = new Map(
  [...registry.official, ...registry.community].map((entry) => [entry.id, {
    id: entry.id,
    trustTier: entry.trustTier,
    url: entry.url,
    allowedDomains: entry.allowedDomains,
  }] as const),
);
const corpusText = readFileSync(new URL("../samples/evaluation/cardano-rag.jsonl", import.meta.url), "utf8");

describe("Cardano RAG evaluation corpus and metrics", () => {
  it("loads the checked-in corpus with exact category, language, and current-evidence coverage", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
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
    expect(validateEvaluationCoverage(cases)).toBe(true);
  });

  it("passes the checked-in deterministic fixtures at the release thresholds", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
    const metrics = calculateEvaluationMetrics(cases, sourceCatalog);
    expect(metrics.recallAt10).toBe(1);
    expect(metrics.citationPrecision).toBe(1);
    expect(metrics.unsupportedClaimCount).toBe(0);
    expect(metrics.communityOverridesOfficial).toBe(0);
    expect(metrics.answerPropertyFailureCount).toBe(0);
    expect(metrics.freshnessViolationCount).toBe(0);
    expect(metrics.perLanguage.en.passedCases).toBe(36);
    expect(metrics.perLanguage.vi.passedCases).toBe(24);
    expect(metrics.perLanguage.en.passRate).toBe(1);
    expect(metrics.perLanguage.vi.passRate).toBe(1);
    expect(validateEvaluationThresholds(metrics)).toBe(true);
  });

  it("passes at exactly 90% recall and rejects below the boundary", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
    const atBoundary = cases.map((item, index) => index < 6
      ? { ...item, requiredSourceIds: ["aiken"] }
      : item);
    const boundaryMetrics = calculateEvaluationMetrics(atBoundary, sourceCatalog);
    expect(boundaryMetrics.recallAt10).toBe(0.9);
    expect(validateEvaluationThresholds(boundaryMetrics)).toBe(true);
    const degraded = cases.map((item, index) => index < 7
      ? { ...item, requiredSourceIds: ["aiken"] }
      : item);
    const metrics = calculateEvaluationMetrics(degraded, sourceCatalog);
    expect(metrics.recallAt10).toBeLessThan(0.9);
    expect(() => validateEvaluationThresholds(metrics)).toThrow(/recall/i);
  });

  it("passes at exactly 95% citation precision and rejects below the boundary", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
    const wrongCitation = (item: EvaluationCase): EvaluationCase => ({
      ...item,
      answer: { ...item.answer, citations: [{ claimId: item.answer.claims[0]!.id, sourceId: "aiken" }] },
    });
    const atBoundary = [wrongCitation(cases[0]!), ...cases.slice(1, 20)];
    const boundaryMetrics = calculateEvaluationMetrics(atBoundary, sourceCatalog);
    expect(boundaryMetrics.citationPrecision).toBe(0.95);
    expect(validateEvaluationThresholds(boundaryMetrics)).toBe(true);
    const below = [wrongCitation(cases[0]!), ...cases.slice(1, 19)];
    const belowMetrics = calculateEvaluationMetrics(below, sourceCatalog);
    expect(belowMetrics.citationPrecision).toBeLessThan(0.95);
    expect(() => validateEvaluationThresholds(belowMetrics)).toThrow(/precision/i);
  });

  it("scores answer properties, top-ten citation scope, freshness, and safe resolution policy", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
    const item = cases[0]!;
    const badAnswer: EvaluationCase = {
      ...item,
      answer: { ...item.answer, claims: [{ ...item.answer.claims[0]!, text: "unsupported forbidden guaranteed" }] },
    };
    const badAnswerMetrics = calculateEvaluationMetrics([badAnswer], sourceCatalog);
    expect(badAnswerMetrics.answerPropertyFailureCount).toBe(1);
    expect(() => validateEvaluationThresholds(badAnswerMetrics)).toThrow(/answer property/i);

    const badCitation: EvaluationCase = {
      ...item,
      answer: { ...item.answer, citations: [{ claimId: item.answer.claims[0]!.id, sourceId: "aiken" }] },
    };
    expect(calculateEvaluationMetrics([badCitation], sourceCatalog).citationPrecision).toBe(0);

    const current = cases.find((candidate) => candidate.currentEvidenceRequired)!;
    const stale: EvaluationCase = {
      ...current,
      retrieval: current.retrieval.map((fixture) => ({ ...fixture, stale: true })),
    };
    const staleMetrics = calculateEvaluationMetrics([stale], sourceCatalog);
    expect(staleMetrics.freshnessViolationCount).toBe(1);
    expect(() => validateEvaluationThresholds(staleMetrics)).toThrow(/freshness/i);

    const adversarial = cases.find((candidate) => candidate.id === "failure-adversarial-001")!;
    const unsafe: EvaluationCase = {
      ...adversarial,
      answer: { ...adversarial.answer, claims: [{ ...adversarial.answer.claims[0]!, resolution: "community" }] },
    };
    const unsafeMetrics = calculateEvaluationMetrics([unsafe], sourceCatalog);
    expect(unsafeMetrics.communityOverridesOfficial).toBe(1);
    expect(() => validateEvaluationThresholds(unsafeMetrics)).toThrow(/override/i);
  });

  it("evaluates required and forbidden terms once over concatenated claim text", () => {
    const cases = parseEvaluationCorpus(corpusText, sourceCatalog);
    const item = cases[0]!;
    const split: EvaluationCase = {
      ...item,
      requiredTerms: ["official", "evidence"],
      answer: {
        claims: [
          { ...item.answer.claims[0]!, id: "c1", text: "official" },
          { ...item.answer.claims[0]!, id: "c2", text: "evidence" },
        ],
        citations: [
          { claimId: "c1", sourceId: item.answer.citations[0]!.sourceId },
          { claimId: "c2", sourceId: item.answer.citations[0]!.sourceId },
        ],
      },
    };
    const metrics = calculateEvaluationMetrics([split], sourceCatalog);
    expect(metrics.answerPropertyFailureCount).toBe(0);
  });

  it("rejects locator credentials and hosts outside the validated source catalog", () => {
    const valid = parseEvaluationCorpus(corpusText, sourceCatalog);
    const evilHost = {
      ...valid[0]!,
      retrieval: [{ ...valid[0]!.retrieval[0]!, locator: "https://evil.example/fixture" }],
    };
    expect(() => parseEvaluationCorpus(JSON.stringify(evilHost), sourceCatalog)).toThrow(/locator/i);
    const credentialHost = {
      ...valid[0]!,
      retrieval: [{ ...valid[0]!.retrieval[0]!, locator: "https://user:pass@cardano.org/fixture" }],
    };
    expect(() => parseEvaluationCorpus(JSON.stringify(credentialHost), sourceCatalog)).toThrow(/locator/i);
  });

  it("resolves live mixed citations fail-closed", () => {
    const official = [{ id: "official-1", trustTier: "official" as const }, { id: "official-2", trustTier: "official" as const }];
    const community = { id: "community-1", trustTier: "community" as const };
    expect(resolveLiveResolution({ kind: "conflict", citationIds: ["official-1", "official-2", "community-1"] }, [...official, community])).toBe("conflict");
    expect(resolveLiveResolution({ kind: "fact", citationIds: ["official-1", "community-1"] }, [...official, community])).toBe("community");
    expect(resolveLiveResolution({ kind: "fact", citationIds: ["official-1"] }, official)).toBe("official");
    expect(resolveLiveResolution({ kind: "fact", citationIds: ["community-1"] }, [community])).toBe("community");
  });

  it("rejects malformed rows, duplicate IDs, unknown sources, and unknown fields", () => {
    expect(() => parseEvaluationCorpus("{}\n", sourceCatalog)).toThrow(/keys|id|category/i);
    const valid = parseEvaluationCorpus(corpusText, sourceCatalog);
    const duplicate = valid.slice(0, 2).map((item) => JSON.stringify({ ...item, id: valid[0]!.id })).join("\n");
    expect(() => parseEvaluationCorpus(duplicate, sourceCatalog)).toThrow(/duplicate/i);
    const unknownSource = JSON.stringify({ ...valid[0], requiredSourceIds: ["not-a-source"] });
    expect(() => parseEvaluationCorpus(unknownSource, sourceCatalog)).toThrow(/source/i);
    const unknownField = JSON.stringify({ ...valid[0], unexpected: true });
    expect(() => parseEvaluationCorpus(unknownField, sourceCatalog)).toThrow(/unknown|keys/i);
    expect(() => parseEvaluationCorpus(JSON.stringify({ ...valid[0], validAt: "2026-02-30" }), sourceCatalog)).toThrow(/validAt/i);
    expect(() => parseEvaluationCorpus(JSON.stringify({
      ...valid[0],
      answer: { ...valid[0]!.answer, claims: [{ ...valid[0]!.answer.claims[0]!, text: "x".repeat(2_049) }] },
    }), sourceCatalog)).toThrow(/text/i);
  });

  it("reports every missing live credential by name without exposing values", () => {
    expect(missingLiveCredentials({})).toEqual([
      "DATABASE_URL", "LITELLM_BASE_URL", "LITELLM_API_KEY", "VENNEK_MODEL_FAST",
      "VENNEK_MODEL_QUALITY", "VENNEK_MODEL_VERIFIER", "VENNEK_EMBEDDING_MODEL", "GITHUB_TOKEN",
    ]);
  });

  it("writes sanitized failure reports atomically without overwriting", () => {
    const directory = mkdtempSync(join(tmpdir(), "vennek-rag-report-"));
    const now = new Date("2026-08-26T12:00:00.000Z");
    try {
      const path = writeLiveReport({ status: "failed", failure: "Live Cardano RAG evaluation requires: DATABASE_URL, SECRET_SHOULD_NOT_PRINT" }, now, directory);
      const report = JSON.parse(readFileSync(path, "utf8")) as { status: string; failure: string };
      expect(report.status).toBe("failed");
      expect(report.failure).toBe("missing credentials: DATABASE_URL");
      expect(JSON.stringify(report)).not.toContain("SECRET_SHOULD_NOT_PRINT");
      expect(() => writeLiveReport({ status: "failed", failure: "retrieval" }, now, directory)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
