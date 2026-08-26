import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  EmbeddingClient,
  LiteLlmClient,
  retrieveEvidence,
  selectModelProfile,
  validateSourceRegistry,
  validateSourceRegistryEnvelope,
  type Evidence,
} from "@vennek/cardano-agent";
import {
  calculateEvaluationMetrics,
  parseEvaluationCorpus,
  validateEvaluationCoverage,
  validateEvaluationThresholds,
  type EvaluationCase,
  type EvaluationMetrics,
  type EvaluationSourceCatalog,
  type EvaluationSourceCatalogEntry,
} from "../packages/cardano-agent/src/evaluation/metrics.js";
import { buildGroundedMessages, parseGeneratedAnswer, type GroundedEvidence } from "../packages/cardano-agent/src/agent/groundedPrompt.js";
import { verifyClaims } from "../packages/cardano-agent/src/agent/verifyClaims.js";

const CORPUS_URL = new URL("../samples/evaluation/cardano-rag.jsonl", import.meta.url);
const REGISTRY_URL = new URL("../config/cardano-sources.json", import.meta.url);
const REPORT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../reports/evaluation");
const LIVE_CREDENTIALS = [
  "DATABASE_URL",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "VENNEK_MODEL_FAST",
  "VENNEK_MODEL_QUALITY",
  "VENNEK_MODEL_VERIFIER",
  "VENNEK_EMBEDDING_MODEL",
] as const;

export type EvaluationMode = "offline" | "live";

export function missingLiveCredentials(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string[] {
  return LIVE_CREDENTIALS.filter((name) => !env[name]?.trim());
}

export function readEvaluationCorpus(): { cases: EvaluationCase[]; sourceCatalog: EvaluationSourceCatalog } {
  const registry = validateSourceRegistryEnvelope(JSON.parse(readFileSync(REGISTRY_URL, "utf8")));
  const entries = validateSourceRegistry([...registry.official, ...registry.community]);
  const sourceCatalog: EvaluationSourceCatalog = new Map(
    entries.map((entry): readonly [string, EvaluationSourceCatalogEntry] => [entry.id, {
      id: entry.id,
      trustTier: entry.trustTier === "official" ? "official" : "community",
      url: entry.url,
      allowedDomains: entry.allowedDomains,
    }]),
  );
  const cases = parseEvaluationCorpus(readFileSync(CORPUS_URL, "utf8"), sourceCatalog);
  validateEvaluationCoverage(cases);
  return { cases, sourceCatalog };
}

export function evaluateOffline(): EvaluationMetrics {
  const { cases, sourceCatalog } = readEvaluationCorpus();
  const metrics = calculateEvaluationMetrics(cases, sourceCatalog);
  validateEvaluationThresholds(metrics);
  return metrics;
}

export async function evaluateLive(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  evaluationAt = new Date(),
): Promise<EvaluationMetrics> {
  const missing = missingLiveCredentials(env);
  if (missing.length > 0) throw new Error(`Live Cardano RAG evaluation requires: ${missing.join(", ")}`);
  const { cases, sourceCatalog } = readEvaluationCorpus();
  const database = createDatabase(env.DATABASE_URL!.trim());
  const baseUrl = new URL(env.LITELLM_BASE_URL!.trim());
  const llm = new LiteLlmClient(baseUrl, env.LITELLM_API_KEY!.trim());
  const embedder = new EmbeddingClient(baseUrl, env.LITELLM_API_KEY!.trim(), env.VENNEK_EMBEDDING_MODEL!.trim());
  try {
    const liveCases: EvaluationCase[] = [];
    for (const item of cases) {
      liveCases.push(await evaluateLiveCase(item, env, database, embedder, llm));
    }
    const metrics = calculateEvaluationMetrics(liveCases, sourceCatalog, { evaluationAt });
    validateEvaluationThresholds(metrics);
    return metrics;
  } finally {
    await database.end();
  }
}

async function evaluateLiveCase(
  item: EvaluationCase,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  database: ReturnType<typeof createDatabase>,
  embedder: EmbeddingClient,
  llm: LiteLlmClient,
): Promise<EvaluationCase> {
  let evidence: Evidence[];
  try {
    evidence = await retrieveEvidence({
      query: item.question,
      language: item.language,
      embeddingModel: env.VENNEK_EMBEDDING_MODEL!.trim(),
    }, { db: database, embedder });
  } catch {
    throw new Error(`Live Cardano RAG evaluation failed during retrieval for ${item.id}.`);
  }
  if (evidence.length === 0) throw new Error(`Live Cardano RAG evaluation returned no evidence for ${item.id}.`);
  const groundedEvidence = evidence as GroundedEvidence[];
  const profile = selectModelProfile({ sourceCount: groundedEvidence.length, hasConflicts: false, technical: false });
  let generated: ReturnType<typeof parseGeneratedAnswer>;
  try {
    const output = await llm.complete({ model: env[`VENNEK_MODEL_${profile.toUpperCase()}`]!.trim(), messages: buildGroundedMessages(item.question, item.language, groundedEvidence), temperature: 0 });
    generated = parseGeneratedAnswer(output.text, item.language, groundedEvidence);
  } catch {
    throw new Error(`Live Cardano RAG evaluation failed during answer generation for ${item.id}.`);
  }
  if (!generated) throw new Error(`Live Cardano RAG evaluation returned an invalid grounded answer for ${item.id}.`);
  const verified = await verifyClaims(
    generated,
    groundedEvidence,
    (input) => llm.complete(input),
    env.VENNEK_MODEL_VERIFIER!.trim(),
  );
  if (!verified) throw new Error(`Live Cardano RAG evaluation failed claim verification for ${item.id}.`);
  const goldSourceIds = item.answer.claims[0]!.goldSourceIds;
  const verifiedClaims = new Set(verified.claims);
  return {
    ...item,
    retrieval: evidence.slice(0, 10).map((entry, index) => ({
      sourceId: entry.sourceId,
      rank: index + 1,
      excerpt: entry.excerpt,
      locator: entry.url,
      retrievedAt: entry.retrievedAt,
      stale: entry.stale,
    })),
    answer: {
      claims: generated.claims.map((claim, index) => ({ id: `live-${index + 1}`, text: claim.text, goldSourceIds, supported: verifiedClaims.has(claim), resolution: resolveLiveResolution(claim, evidence) })),
      citations: generated.claims.flatMap((claim, index) => claim.citationIds.map((citationId) => ({ claimId: `live-${index + 1}`, sourceId: evidence.find((entry) => entry.id === citationId)!.sourceId }))),
    },
  };
}

export function resolveLiveResolution(
  claim: { kind: "fact" | "caveat" | "conflict"; citationIds: readonly string[] },
  evidence: readonly Pick<Evidence, "id" | "trustTier">[],
): "official" | "community" | "conflict" {
  const cited = claim.citationIds.map((id) => evidence.find((entry) => entry.id === id)).filter(
    (entry): entry is Pick<Evidence, "id" | "trustTier"> => entry !== undefined,
  );
  const officialCount = cited.filter((entry) => entry.trustTier === "official").length;
  if (claim.kind === "conflict" && officialCount >= 2) return "conflict";
  if (cited.some((entry) => entry.trustTier === "community")) return "community";
  if (officialCount > 0) return "official";
  return "conflict";
}

export type LiveEvaluationReport = {
  status: "passed" | "failed";
  metrics?: EvaluationMetrics;
  failure?: string;
};

export function writeLiveReport(input: LiveEvaluationReport, now = new Date(), reportDirectory = REPORT_DIRECTORY): string {
  if (input.status === "passed" && input.metrics === undefined) throw new Error("Successful live reports require metrics.");
  if (input.status === "failed" && input.failure === undefined) throw new Error("Failed live reports require a failure reason.");
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  const path = resolve(reportDirectory, `cardano-rag-${timestamp}.json`);
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const report = {
    generatedAt: now.toISOString(),
    mode: "live" as const,
    status: input.status,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.failure ? { failure: sanitizeLiveFailure(input.failure) } : {}),
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

function sanitizeLiveFailure(value: string): string {
  if (value.startsWith("Live Cardano RAG evaluation requires:")) {
    const names = value.slice(value.indexOf(":") + 1).match(/[A-Z][A-Z0-9_]+/gu) ?? [];
    const allowedNames = new Set<string>(LIVE_CREDENTIALS);
    const allowed = [...new Set(names)].filter((name) => allowedNames.has(name));
    return allowed.length > 0 ? `missing credentials: ${allowed.join(", ")}` : "missing live credentials";
  }
  if (/threshold|recall|precision|freshness|answer property|override/iu.test(value)) return "live evaluation threshold gate failed";
  if (/retrieval/iu.test(value)) return "live retrieval failed";
  if (/generation|grounded answer/iu.test(value)) return "live answer generation failed";
  if (/verification/iu.test(value)) return "live claim verification failed";
  return "live evaluation failed";
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Promise<number> {
  const mode = argv.length === 1 ? argv[0] : undefined;
  if (mode === "--offline") {
    const metrics = evaluateOffline();
    console.log(JSON.stringify(metrics, null, 2));
    return 0;
  }
  if (mode === "--live") {
    const evaluationAt = new Date();
    try {
      const metrics = await evaluateLive(env, evaluationAt);
      const report = writeLiveReport({ status: "passed", metrics }, evaluationAt);
      console.log(JSON.stringify({ report, metrics }, null, 2));
      return 0;
    } catch (error) {
      const rawFailure = error instanceof Error ? error.message : "live evaluation failed";
      const failure = sanitizeLiveFailure(rawFailure);
      const report = writeLiveReport({ status: "failed", failure: rawFailure }, evaluationAt);
      console.error(failure);
      console.error(`Live evaluation report: ${report}`);
      return 1;
    }
  }
  console.error("Usage: evaluate-cardano-rag.ts --offline|--live");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Cardano RAG evaluation failed.");
    process.exitCode = 1;
  });
}
