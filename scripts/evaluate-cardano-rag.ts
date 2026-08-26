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
  type CompletionOutput,
  type Evidence,
} from "@vennek/cardano-agent";
import {
  calculateEvaluationMetrics,
  parseEvaluationCorpus,
  validateEvaluationCoverage,
  validateEvaluationThresholds,
  type EvaluationCase,
  type EvaluationMetrics,
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
  "GITHUB_TOKEN",
] as const;

export type EvaluationMode = "offline" | "live";

export function missingLiveCredentials(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string[] {
  return LIVE_CREDENTIALS.filter((name) => !env[name]?.trim());
}

export function readEvaluationCorpus(): { cases: EvaluationCase[]; sourceTiers: Map<string, "official" | "community"> } {
  const registry = validateSourceRegistryEnvelope(JSON.parse(readFileSync(REGISTRY_URL, "utf8")));
  const entries = validateSourceRegistry([...registry.official, ...registry.community]);
  const sourceTiers = new Map<string, "official" | "community">([
    ...entries.map((entry) => [entry.id, entry.trustTier === "official" ? "official" : "community"] as const),
  ]);
  const cases = parseEvaluationCorpus(readFileSync(CORPUS_URL, "utf8"), sourceTiers);
  validateEvaluationCoverage(cases);
  return { cases, sourceTiers };
}

export function evaluateOffline(): EvaluationMetrics {
  const { cases, sourceTiers } = readEvaluationCorpus();
  const metrics = calculateEvaluationMetrics(cases, sourceTiers);
  validateEvaluationThresholds(metrics);
  return metrics;
}

export async function evaluateLive(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Promise<EvaluationMetrics> {
  const missing = missingLiveCredentials(env);
  if (missing.length > 0) throw new Error(`Live Cardano RAG evaluation requires: ${missing.join(", ")}`);
  const { cases, sourceTiers } = readEvaluationCorpus();
  const database = createDatabase(env.DATABASE_URL!.trim());
  const baseUrl = new URL(env.LITELLM_BASE_URL!.trim());
  const llm = new LiteLlmClient(baseUrl, env.LITELLM_API_KEY!.trim());
  const embedder = new EmbeddingClient(baseUrl, env.LITELLM_API_KEY!.trim(), env.VENNEK_EMBEDDING_MODEL!.trim());
  try {
    const liveCases: EvaluationCase[] = [];
    for (const item of cases) {
      liveCases.push(await evaluateLiveCase(item, env, database, embedder, llm));
    }
    const metrics = calculateEvaluationMetrics(liveCases, sourceTiers);
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
      now: new Date(`${item.validAt}T00:00:00.000Z`),
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
    retrieval: evidence.slice(0, 10).map((entry, index) => ({ sourceId: entry.sourceId, rank: index + 1, excerpt: entry.excerpt })),
    answer: {
      claims: generated.claims.map((claim, index) => ({ id: `live-${index + 1}`, goldSourceIds, supported: verifiedClaims.has(claim) })),
      citations: generated.claims.flatMap((claim, index) => claim.citationIds.map((citationId) => ({ claimId: `live-${index + 1}`, sourceId: evidence.find((entry) => entry.id === citationId)!.sourceId }))),
    },
  };
}

export function writeLiveReport(metrics: EvaluationMetrics, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  const path = resolve(REPORT_DIRECTORY, `cardano-rag-${timestamp}.json`);
  mkdirSync(REPORT_DIRECTORY, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ generatedAt: now.toISOString(), mode: "live", metrics }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Promise<number> {
  const mode = argv.length === 1 ? argv[0] : undefined;
  if (mode === "--offline") {
    const metrics = evaluateOffline();
    console.log(JSON.stringify(metrics, null, 2));
    return 0;
  }
  if (mode === "--live") {
    const metrics = await evaluateLive(env);
    const report = writeLiveReport(metrics);
    console.log(JSON.stringify({ report, metrics }, null, 2));
    return 0;
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
