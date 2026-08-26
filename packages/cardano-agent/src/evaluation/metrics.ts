export const EVALUATION_CATEGORIES = [
  "fundamentals",
  "consensus",
  "staking",
  "assets",
  "transactions",
  "wallets",
  "Plutus/Aiken",
  "nodes/APIs",
  "governance/CIPs",
  "Catalyst",
  "ecosystem",
  "failure/adversarial",
] as const;

export type EvaluationCategory = (typeof EVALUATION_CATEGORIES)[number];
export type EvaluationLanguage = "en" | "vi";
export type EvaluationTrustTier = "official" | "community";
export type EvaluationSourceTiers = ReadonlyMap<string, EvaluationTrustTier>;

export type EvaluationRetrievalFixture = {
  sourceId: string;
  rank: number;
  excerpt: string;
};

export type EvaluationClaim = {
  id: string;
  goldSourceIds: string[];
  supported: boolean;
};

export type EvaluationCitation = {
  claimId: string;
  sourceId: string;
};

export type EvaluationCase = {
  id: string;
  category: EvaluationCategory;
  language: EvaluationLanguage;
  question: string;
  requiredSourceIds: string[];
  requiredTerms: string[];
  forbiddenTerms: string[];
  validAt: string;
  currentEvidenceRequired: boolean;
  retrieval: EvaluationRetrievalFixture[];
  answer: {
    claims: EvaluationClaim[];
    citations: EvaluationCitation[];
  };
};

export type LanguageEvaluationMetrics = {
  caseCount: number;
  recallAt10: number;
  citationPrecision: number;
  unsupportedClaimCount: number;
  communityOverridesOfficial: number;
  pass: boolean;
};

export type EvaluationMetrics = {
  caseCount: number;
  recallAt10: number;
  citationPrecision: number;
  unsupportedClaimCount: number;
  communityOverridesOfficial: number;
  perLanguage: Record<EvaluationLanguage, LanguageEvaluationMetrics>;
};

export const EVALUATION_THRESHOLDS = Object.freeze({
  recallAt10: 0.9,
  citationPrecision: 0.95,
  communityOverridesOfficial: 0,
});

const CASE_KEYS = [
  "id", "category", "language", "question", "requiredSourceIds", "requiredTerms", "forbiddenTerms",
  "validAt", "currentEvidenceRequired", "retrieval", "answer",
];
const RETRIEVAL_KEYS = ["sourceId", "rank", "excerpt"];
const ANSWER_KEYS = ["claims", "citations"];
const CLAIM_KEYS = ["id", "goldSourceIds", "supported"];
const CITATION_KEYS = ["claimId", "sourceId"];
const MAX_CASES = 256;
const MAX_ID_LENGTH = 80;
const MAX_QUESTION_LENGTH = 1_024;
const MAX_TERM_LENGTH = 96;
const MAX_TERMS = 32;
const MAX_REQUIRED_SOURCES = 16;
const MAX_RETRIEVAL_FIXTURES = 10;
const MAX_CLAIMS = 32;
const MAX_CITATIONS = 128;
const MAX_EXCERPT_LENGTH = 2_048;

export function parseEvaluationCorpus(text: string, sourceTiers: EvaluationSourceTiers): EvaluationCase[] {
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("Evaluation corpus must not be empty.");
  const rows = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Evaluation corpus line ${index + 1} is invalid JSON.`);
    }
  });
  return validateEvaluationCorpus(rows, sourceTiers);
}

export function validateEvaluationCorpus(input: unknown, sourceTiers: EvaluationSourceTiers): EvaluationCase[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CASES) {
    throw new Error("Evaluation corpus must contain between 1 and 256 cases.");
  }
  const ids = new Set<string>();
  return input.map((candidate, index) => {
    const item = validateCase(candidate, index, sourceTiers);
    if (ids.has(item.id)) throw new Error(`Duplicate evaluation case id: ${item.id}`);
    ids.add(item.id);
    return item;
  });
}

export function validateEvaluationCoverage(cases: readonly EvaluationCase[]): true {
  if (cases.length < 60) throw new Error("Evaluation corpus must contain at least 60 cases.");
  for (const category of EVALUATION_CATEGORIES) {
    if (cases.filter((item) => item.category === category).length < 5) {
      throw new Error(`Evaluation corpus category ${category} must contain at least five cases.`);
    }
  }
  if (cases.filter((item) => item.language === "vi").length < 15) throw new Error("Evaluation corpus must contain at least 15 Vietnamese cases.");
  if (cases.filter((item) => item.currentEvidenceRequired).length < 5) throw new Error("Evaluation corpus must contain at least five current-evidence cases.");
  return true;
}

export function calculateEvaluationMetrics(cases: readonly EvaluationCase[], sourceTiers: EvaluationSourceTiers): EvaluationMetrics {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("At least one evaluation case is required.");
  const languages = new Map<EvaluationLanguage, EvaluationCase[]>([["en", []], ["vi", []]]);
  for (const item of cases) languages.get(item.language)!.push(item);
  const aggregate = calculateAggregateMetrics(cases, sourceTiers);
  const perLanguage = Object.fromEntries([...languages.entries()].map(([language, languageCases]) => {
    return [language, calculateEvaluationMetricsForCases(languageCases, sourceTiers)];
  })) as Record<EvaluationLanguage, LanguageEvaluationMetrics>;
  return { ...aggregate, perLanguage };
}

function calculateAggregateMetrics(cases: readonly EvaluationCase[], sourceTiers: EvaluationSourceTiers): Omit<EvaluationMetrics, "perLanguage"> {
  let requiredSources = 0;
  let retrievedRequiredSources = 0;
  let citationCount = 0;
  let preciseCitations = 0;
  let unsupportedClaimCount = 0;
  let communityOverridesOfficial = 0;

  for (const item of cases) {
    const topTen = new Set(item.retrieval.filter((fixture) => fixture.rank <= 10).map((fixture) => fixture.sourceId));
    requiredSources += item.requiredSourceIds.length;
    retrievedRequiredSources += item.requiredSourceIds.filter((sourceId) => topTen.has(sourceId)).length;
    const claimsById = new Map(item.answer.claims.map((claim) => [claim.id, claim]));
    const citationsByClaim = new Map<string, EvaluationCitation[]>();
    for (const citation of item.answer.citations) {
      citationCount += 1;
      const claim = claimsById.get(citation.claimId);
      if (claim && claim.goldSourceIds.includes(citation.sourceId)) preciseCitations += 1;
      const citations = citationsByClaim.get(citation.claimId) ?? [];
      citations.push(citation);
      citationsByClaim.set(citation.claimId, citations);
    }
    unsupportedClaimCount += item.answer.claims.filter((claim) => !claim.supported).length;
    for (const claim of item.answer.claims) {
      const hasOfficialGold = claim.goldSourceIds.some((sourceId) => sourceTiers.get(sourceId) === "official");
      if (!hasOfficialGold) continue;
      const citations = citationsByClaim.get(claim.id) ?? [];
      const hasOfficialCitation = citations.some((citation) => sourceTiers.get(citation.sourceId) === "official");
      if (!hasOfficialCitation && citations.some((citation) => sourceTiers.get(citation.sourceId) === "community")) {
        communityOverridesOfficial += 1;
      }
    }
  }

  return {
    caseCount: cases.length,
    recallAt10: retrievedRequiredSources / requiredSources,
    citationPrecision: citationCount === 0 ? 0 : preciseCitations / citationCount,
    unsupportedClaimCount,
    communityOverridesOfficial,
  };
}

export function validateEvaluationThresholds(metrics: EvaluationMetrics): true {
  const failures: string[] = [];
  if (metrics.recallAt10 < EVALUATION_THRESHOLDS.recallAt10) failures.push(`recall@10 ${formatPercent(metrics.recallAt10)} < 90%`);
  if (metrics.citationPrecision < EVALUATION_THRESHOLDS.citationPrecision) failures.push(`citation precision ${formatPercent(metrics.citationPrecision)} < 95%`);
  if (metrics.communityOverridesOfficial > EVALUATION_THRESHOLDS.communityOverridesOfficial) failures.push(`community overrides official: ${metrics.communityOverridesOfficial}`);
  if (failures.length > 0) throw new Error(`Cardano RAG evaluation failed: ${failures.join("; ")}`);
  return true;
}

function calculateEvaluationMetricsForCases(cases: readonly EvaluationCase[], sourceTiers: EvaluationSourceTiers): LanguageEvaluationMetrics {
  if (cases.length === 0) {
    return { caseCount: 0, recallAt10: 0, citationPrecision: 0, unsupportedClaimCount: 0, communityOverridesOfficial: 0, pass: false };
  }
  const metrics = calculateAggregateMetrics(cases, sourceTiers);
  return {
    caseCount: metrics.caseCount,
    recallAt10: metrics.recallAt10,
    citationPrecision: metrics.citationPrecision,
    unsupportedClaimCount: metrics.unsupportedClaimCount,
    communityOverridesOfficial: metrics.communityOverridesOfficial,
    pass: metrics.recallAt10 >= EVALUATION_THRESHOLDS.recallAt10 && metrics.citationPrecision >= EVALUATION_THRESHOLDS.citationPrecision && metrics.communityOverridesOfficial === 0,
  };
}

function validateCase(candidate: unknown, index: number, sourceTiers: EvaluationSourceTiers): EvaluationCase {
  const value = record(candidate, `Evaluation case ${index}`);
  exactKeys(value, CASE_KEYS, `Evaluation case ${index}`);
  const id = boundedId(value.id, `Evaluation case ${index} id`);
  const category = enumValue(value.category, EVALUATION_CATEGORIES, `Evaluation case ${id} category`);
  const language = enumValue(value.language, ["en", "vi"] as const, `Evaluation case ${id} language`);
  const question = boundedString(value.question, MAX_QUESTION_LENGTH, `Evaluation case ${id} question`);
  const requiredSourceIds = sourceIds(value.requiredSourceIds, sourceTiers, `Evaluation case ${id} requiredSourceIds`, true);
  const requiredTerms = terms(value.requiredTerms, `Evaluation case ${id} requiredTerms`);
  const forbiddenTerms = terms(value.forbiddenTerms, `Evaluation case ${id} forbiddenTerms`);
  if (typeof value.validAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.validAt) || Number.isNaN(Date.parse(`${value.validAt}T00:00:00Z`))) {
    throw new Error(`Evaluation case ${id} validAt is invalid.`);
  }
  if (typeof value.currentEvidenceRequired !== "boolean") throw new Error(`Evaluation case ${id} currentEvidenceRequired is invalid.`);
  if (!Array.isArray(value.retrieval) || value.retrieval.length === 0 || value.retrieval.length > MAX_RETRIEVAL_FIXTURES) throw new Error(`Evaluation case ${id} retrieval fixture is invalid.`);
  const retrieval = value.retrieval.map((fixture, fixtureIndex) => validateRetrievalFixture(fixture, id, fixtureIndex, sourceTiers));
  const ranks = new Set(retrieval.map((fixture) => fixture.rank));
  if (ranks.size !== retrieval.length) throw new Error(`Evaluation case ${id} retrieval ranks must be unique.`);
  const answer = validateAnswer(value.answer, id, sourceTiers);
  return { id, category, language, question, requiredSourceIds, requiredTerms, forbiddenTerms, validAt: value.validAt, currentEvidenceRequired: value.currentEvidenceRequired, retrieval, answer };
}

function validateRetrievalFixture(candidate: unknown, caseId: string, index: number, sourceTiers: EvaluationSourceTiers): EvaluationRetrievalFixture {
  const value = record(candidate, `Evaluation case ${caseId} retrieval ${index}`);
  exactKeys(value, RETRIEVAL_KEYS, `Evaluation case ${caseId} retrieval ${index}`);
  const sourceId = sourceIds([value.sourceId], sourceTiers, `Evaluation case ${caseId} retrieval ${index} sourceId`, false)[0]!;
  if (typeof value.rank !== "number" || !Number.isSafeInteger(value.rank) || value.rank < 1 || value.rank > 10) throw new Error(`Evaluation case ${caseId} retrieval ${index} rank must be between 1 and 10.`);
  const excerpt = boundedString(value.excerpt, MAX_EXCERPT_LENGTH, `Evaluation case ${caseId} retrieval ${index} excerpt`);
  return { sourceId, rank: value.rank, excerpt };
}

function validateAnswer(candidate: unknown, caseId: string, sourceTiers: EvaluationSourceTiers): EvaluationCase["answer"] {
  const value = record(candidate, `Evaluation case ${caseId} answer`);
  exactKeys(value, ANSWER_KEYS, `Evaluation case ${caseId} answer`);
  if (!Array.isArray(value.claims) || value.claims.length === 0 || value.claims.length > MAX_CLAIMS) throw new Error(`Evaluation case ${caseId} claims are invalid.`);
  if (!Array.isArray(value.citations) || value.citations.length === 0 || value.citations.length > MAX_CITATIONS) throw new Error(`Evaluation case ${caseId} citations are invalid.`);
  const claimIds = new Set<string>();
  const claims = value.claims.map((candidateClaim, index) => {
    const claim = record(candidateClaim, `Evaluation case ${caseId} claim ${index}`);
    exactKeys(claim, CLAIM_KEYS, `Evaluation case ${caseId} claim ${index}`);
    const id = boundedId(claim.id, `Evaluation case ${caseId} claim ${index} id`);
    if (claimIds.has(id)) throw new Error(`Duplicate claim id in evaluation case ${caseId}: ${id}`);
    claimIds.add(id);
    const goldSourceIds = sourceIds(claim.goldSourceIds, sourceTiers, `Evaluation case ${caseId} claim ${id} goldSourceIds`, true);
    if (typeof claim.supported !== "boolean") throw new Error(`Evaluation case ${caseId} claim ${id} supported is invalid.`);
    return { id, goldSourceIds, supported: claim.supported };
  });
  const citationPairs = new Set<string>();
  const citations = value.citations.map((candidateCitation, index) => {
    const citation = record(candidateCitation, `Evaluation case ${caseId} citation ${index}`);
    exactKeys(citation, CITATION_KEYS, `Evaluation case ${caseId} citation ${index}`);
    const claimId = boundedId(citation.claimId, `Evaluation case ${caseId} citation ${index} claimId`);
    if (!claimIds.has(claimId)) throw new Error(`Evaluation case ${caseId} citation references unknown claim ${claimId}.`);
    const sourceId = sourceIds([citation.sourceId], sourceTiers, `Evaluation case ${caseId} citation ${index} sourceId`, false)[0]!;
    const pair = `${claimId}\u0000${sourceId}`;
    if (citationPairs.has(pair)) throw new Error(`Duplicate citation in evaluation case ${caseId}.`);
    citationPairs.add(pair);
    return { claimId, sourceId };
  });
  return { claims, citations };
}

function sourceIds(value: unknown, sourceTiers: EvaluationSourceTiers, label: string, multiple: boolean): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUIRED_SOURCES || (!multiple && value.length !== 1)) throw new Error(`${label} is invalid.`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const sourceId = boundedId(candidate, label);
    if (seen.has(sourceId)) throw new Error(`${label} contains duplicate source ${sourceId}.`);
    if (!sourceTiers.has(sourceId)) throw new Error(`${label} references unknown source ${sourceId}.`);
    seen.add(sourceId);
    result.push(sourceId);
  }
  return result;
}

function terms(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TERMS) throw new Error(`${label} is invalid.`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const term = boundedString(candidate, MAX_TERM_LENGTH, label);
    if (seen.has(term)) throw new Error(`${label} contains duplicate term.`);
    seen.add(term);
    result.push(term);
  }
  return result;
}

function boundedId(value: unknown, label: string): string {
  const result = boundedString(value, MAX_ID_LENGTH, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function boundedString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Array.from(normalized).length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid.`);
  return value as T[number];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${label} has unknown or missing keys.`);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
