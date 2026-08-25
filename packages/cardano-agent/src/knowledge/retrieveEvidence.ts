import type { Pool, PoolClient } from "pg";
import { findWalletSecret } from "../security/walletSecrets.js";
import type { RepositoryOperationOptions } from "./knowledgeRepository.js";
import type { EmbeddingProvider } from "./indexDocument.js";
import {
  createRetrievalCacheKey,
  deleteStaleRetrievalCache,
  runRetrievalTransaction,
  withRetrievalCacheSnapshot,
  writeRetrievalCache,
  type RetrievalFilter,
} from "./retrievalCache.js";

const MAX_QUERY_CHARS = 4_096;
const MAX_MODEL_CHARS = 128;
const MAX_LANGUAGE_CHARS = 32;
const MAX_FILTER_CHARS = 64;
const MAX_FILTER_ITEMS = 32;
const RETRIEVAL_DEADLINE_MS = 30_000;
const MAX_RETRIEVAL_TIMEOUT_MS = 5_000;
const MAX_EXCERPT_CHARS = 1_000;
const VECTOR_DIMENSIONS = 1_536;
const FLOAT32_MAX = 3.4028234663852886e38;
const ENGLISH_VOLATILE_QUERY = /\b(?:current(?:ly)?|latest|now|today|on[- ]?chain|wallets?|balances?|transactions?|epochs?|governance|releases?|personalized|block[- ]heights?|my\s+(?:wallets?|balances?))\b/iu;
const VOLATILE_TERMS: Readonly<Record<string, readonly string[]>> = {
  vi: ["mới nhất", "hiện tại", "hôm nay", "bây giờ", "on-chain", "trên chuỗi", "ví", "số dư", "giao dịch", "epoch", "kỷ nguyên", "quản trị", "governance", "phát hành", "release", "chiều cao khối", "cá nhân"],
  es: ["actual", "últim", "ahora", "hoy", "cadena de bloques", "on-chain", "cartera", "billetera", "saldo", "transacción", "gobernanza", "lanzamiento", "altura del bloque"],
  ja: ["最新", "現在", "今日", "今", "オンチェーン", "ウォレット", "残高", "取引", "ガバナンス", "リリース", "ブロック高"],
  zh: ["最新", "当前", "今天", "现在", "链上", "钱包", "余额", "交易", "治理", "发布", "区块高度"],
  ko: ["최신", "현재", "오늘", "지금", "온체인", "지갑", "잔액", "거래", "거버넌스", "릴리스", "블록 높이"],
  ru: ["текущ", "последн", "сейчас", "сегодня", "он-чейн", "кошел", "баланс", "транзакц", "управлен", "релиз", "высот блок"],
  ar: ["الحالي", "الأحدث", "الآن", "اليوم", "على السلسلة", "المحفظة", "الرصيد", "المعاملة", "الحوكمة", "الإصدار", "ارتفاع الكتلة"],
  hi: ["वर्तमान", "नवीनतम", "अभी", "आज", "ऑन-चेन", "वॉलेट", "शेष", "लेनदेन", "शासन", "रिलीज़", "ब्लॉक ऊंचाई"],
  th: ["ปัจจุบัน", "ล่าสุด", "ตอนนี้", "วันนี้", "บนเชน", "กระเป๋า", "ยอดคงเหลือ", "ธุรกรรม", "ธรรมาภิบาล", "เผยแพร่", "ความสูงบล็อก"],
  fr: ["actuel", "derni", "maintenant", "aujourd", "chaîne", "portefeuille", "solde", "transaction", "gouvernance", "publication", "hauteur du bloc"],
  de: ["aktuell", "neueste", "jetzt", "heute", "on-chain", "wallet", "guthaben", "transaktion", "governance", "veröffentlich", "blockhöhe"],
  pt: ["atual", "últim", "agora", "hoje", "cadeia", "carteira", "saldo", "transação", "governança", "lançamento", "altura do bloco"],
  id: ["terkini", "terbaru", "sekarang", "hari ini", "on-chain", "dompet", "saldo", "transaksi", "tata kelola", "rilis", "tinggi blok"],
  tr: ["güncel", "son", "şimdi", "bugün", "zincir üstü", "cüzdan", "bakiye", "işlem", "yönetişim", "sürüm", "blok yüksekliği"],
};

export type Evidence = {
  id: string;
  sourceId: string;
  owner: string;
  trustTier: "official" | "community" | "unverified";
  title: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
  retrievedAt: string;
  versionHash: string;
  score: number;
  stale: boolean;
};

export type RetrieveEvidenceInput = {
  query: string;
  language: string;
  embeddingModel: string;
  topics?: string[];
  networks?: string[];
  cachePolicy?: "stable";
  personalized?: boolean;
  now?: Date;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RetrieveEvidenceDependencies = {
  db: Pool;
  embedder: EmbeddingProvider;
};

type RetrievalRow = {
  chunk_id: string;
  source_id: string;
  owner: string;
  trust_tier: Evidence["trustTier"];
  title: string;
  canonical_url: string;
  excerpt: string;
  published_at: Date | null;
  retrieved_at: Date;
  version_hash: string;
  score: number;
  volatile_source: boolean;
};

export async function retrieveEvidence(input: RetrieveEvidenceInput, dependencies: RetrieveEvidenceDependencies): Promise<Evidence[]> {
  const query = normalizeQuery(input.query);
  if (findWalletSecret(query)) throw new Error("Wallet secrets must not be used for evidence retrieval.");
  const language = validateLanguage(input.language);
  const embeddingModel = validateModel(input.embeddingModel);
  const topics = validateTopics(input.topics);
  const networks = validateNetworks(input.networks);
  if (input.cachePolicy !== undefined && input.cachePolicy !== "stable") throw new Error("Cache policy is invalid.");
  if (input.personalized !== undefined && typeof input.personalized !== "boolean") throw new Error("Personalized flag is invalid.");
  const now = input.now === undefined ? new Date() : validateNow(input.now);
  const timeoutMs = validateTimeout(input.timeoutMs);
  const deadline = createDeadline(input.signal, timeoutMs);
  const operation = repositoryOperation(deadline);
  ensureActive(deadline.signal);
  const filter: RetrievalFilter = { ...(topics ? { topics } : {}), ...(networks ? { networks } : {}) };
  const cacheAllowed = input.cachePolicy === "stable" && input.personalized !== true && !isVolatileQuery(query, language);
  const cacheKey = cacheAllowed ? createRetrievalCacheKey(query, language, embeddingModel, filter) : undefined;
  let fingerprint: string | undefined;
  let staleFingerprint: string | undefined;
  if (cacheKey) {
    const cachedEvidence = await withRetrievalCacheSnapshot(dependencies.db, cacheKey, now, operation, async (client, snapshot) => {
      fingerprint = snapshot.fingerprint;
      staleFingerprint = snapshot.staleFingerprint;
      if (!snapshot.cached) return undefined;
      return hydrateEvidenceOnClient(client, snapshot.cached.chunkIds, snapshot.cached.scores, embeddingModel, now, operation);
    });
    if (staleFingerprint) {
      try {
        await deleteStaleRetrievalCache(dependencies.db, cacheKey, staleFingerprint, operation);
      } catch (error) {
        if (!isCacheContention(error)) throw error;
      }
    }
    if (cachedEvidence) return cachedEvidence;
  }
  ensureActive(deadline.signal);
  const embedded = await dependencies.embedder.embed([query], deadline.signal);
  const queryVector = validateQueryEmbedding(embedded);
  const rows = await runRetrievalTransaction(dependencies.db, operation, async (client) => {
    ensureActive(deadline.signal);
    const result = await client.query<RetrievalRow>(RETRIEVAL_SQL, [
      query,
      vectorLiteral(queryVector),
      topics?.length ? topics : null,
      networks?.length ? networks : null,
      embeddingModel,
    ]);
    ensureActive(deadline.signal);
    return result.rows;
  });
  const evidence = rows.map((row) => toEvidence(row, now));
  if (cacheKey && fingerprint && evidence.length > 0 && !rows.some((row) => row.volatile_source)) {
    try {
      await writeRetrievalCache(dependencies.db, cacheKey, fingerprint, {
        chunkIds: rows.map((row) => row.chunk_id),
        scores: evidence.map((item) => item.score),
      }, now, operation);
    } catch (error) {
      if (!isCacheContention(error)) throw error;
    }
  }
  return evidence;
}

function isCacheContention(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "40001" || code === "40P01";
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string") throw new Error("Query is required.");
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error("Query must not be empty.");
  if (normalized.length > MAX_QUERY_CHARS) throw new Error("Query is too long.");
  return normalized;
}

function isVolatileQuery(query: string, language: string): boolean {
  const baseLanguage = language.toLowerCase().split("-", 1)[0] ?? "";
  if (baseLanguage === "en") return ENGLISH_VOLATILE_QUERY.test(query.normalize("NFC").toLowerCase());
  const terms = VOLATILE_TERMS[baseLanguage];
  if (!terms) return true;
  const normalized = query.normalize("NFC").toLocaleLowerCase(baseLanguage);
  return terms.some((term) => normalized.includes(term));
}

function validateLanguage(value: string): string {
  if (typeof value !== "string") throw new Error("Language is required.");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_LANGUAGE_CHARS || !/^[A-Za-z]{2,16}(?:-[A-Za-z]{2,16})?$/.test(normalized)) throw new Error("Language is invalid.");
  return normalized;
}

function validateModel(value: string): string {
  if (typeof value !== "string") throw new Error("Embedding model is required.");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_MODEL_CHARS || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("Embedding model is invalid.");
  return normalized;
}

function validateTopics(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_ITEMS) throw new Error("Topics filter is invalid.");
  return validateFilterItems(value, "Topics", (item) => item.toLowerCase(), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
}

function validateNetworks(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_ITEMS) throw new Error("Networks filter is invalid.");
  const allowed = new Set(["mainnet", "preprod", "preview"]);
  return validateFilterItems(value, "Networks", (item) => item, undefined, allowed);
}

function validateFilterItems(value: string[], name: string, canonicalize: (value: string) => string, pattern: RegExp | undefined, allowed?: Set<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${name} filter is invalid.`);
    const normalized = canonicalize(item.normalize("NFC").trim());
    if (!normalized || normalized.length > MAX_FILTER_CHARS || /[\u0000-\u001f\u007f]/.test(normalized) || (pattern && !pattern.test(normalized)) || (allowed && !allowed.has(normalized)) || seen.has(normalized)) {
      throw new Error(`${name} filter is invalid.`);
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function validateNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Now must be a valid Date.");
  return value;
}

function validateTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > MAX_RETRIEVAL_TIMEOUT_MS) throw new Error("Retrieval timeout is invalid.");
  return value;
}

const RETRIEVAL_SQL =
  "WITH newest_indexed AS (\n" +
  "  SELECT DISTINCT ON (sv.canonical_url) sv.id AS version_id, sv.source_id, ks.owner, sv.canonical_url, sv.title, sv.published_at, sv.retrieved_at, sv.content_hash AS version_hash, ks.trust_tier,\n" +
  "         (ks.registry ->> 'kind' = 'github' OR COALESCE(ks.registry -> 'topics', '[]'::jsonb) ?| ARRAY['governance','releases','release','on-chain','onchain','on_chain','node','ledger','staking','delegation','voting']) AS volatile_source\n" +
  "  FROM source_versions sv JOIN knowledge_sources ks ON ks.id = sv.source_id\n" +
  "  WHERE EXISTS (SELECT 1 FROM knowledge_chunks kc0 WHERE kc0.version_id = sv.id AND kc0.embedding_model = $5)\n" +
  "    AND ($3::text[] IS NULL OR COALESCE(ks.registry -> 'topics', '[]'::jsonb) ?| $3::text[])\n" +
  "    AND ($4::text[] IS NULL OR COALESCE(ks.registry -> 'networks', '[]'::jsonb) ?| $4::text[])\n" +
  "  ORDER BY sv.canonical_url, sv.retrieved_at DESC, sv.id DESC\n" +
  "), eligible_versions AS (\n" +
  "  SELECT version_id, source_id, left(owner, 200) AS owner, left(canonical_url, 2048) AS canonical_url, left(title, 300) AS title, published_at, retrieved_at, version_hash, trust_tier, volatile_source\n" +
  "  FROM newest_indexed\n" +
  "  WHERE char_length(canonical_url) <= 2048 AND char_length(title) <= 300\n" +
  "), lexical AS (\n" +
  "  SELECT ranked.chunk_id, row_number() OVER (ORDER BY ranked.rank_score DESC, ranked.chunk_id)::int AS rank\n" +
  "  FROM (SELECT kc.id::text AS chunk_id, ts_rank_cd(kc.textsearch, websearch_to_tsquery('simple', $1)) AS rank_score\n" +
  "        FROM eligible_versions ev JOIN knowledge_chunks kc ON kc.version_id = ev.version_id AND kc.embedding_model = $5\n" +
  "        WHERE kc.textsearch @@ websearch_to_tsquery('simple', $1)\n" +
  "        ORDER BY rank_score DESC, kc.id LIMIT 40) ranked\n" +
  "), vector_ranked AS (\n" +
  "  SELECT ranked.chunk_id, row_number() OVER (ORDER BY ranked.distance ASC, ranked.chunk_id)::int AS rank\n" +
  "  FROM (SELECT kc.id::text AS chunk_id, kc.embedding <=> $2::vector AS distance\n" +
  "        FROM eligible_versions ev JOIN knowledge_chunks kc ON kc.version_id = ev.version_id AND kc.embedding_model = $5\n" +
  "        ORDER BY distance ASC, kc.id LIMIT 40) ranked\n" +
  "), candidates AS (\n" +
  "  SELECT chunk_id, (1.0 / (60 + rank))::double precision AS score FROM lexical\n" +
  "  UNION ALL\n" +
  "  SELECT chunk_id, (1.0 / (60 + rank))::double precision AS score FROM vector_ranked\n" +
  "), fused AS (\n" +
  "  SELECT chunk_id, sum(score)::double precision AS score FROM candidates GROUP BY chunk_id\n" +
  ")\n" +
  "SELECT kc.id::text AS chunk_id, ev.source_id, ev.owner, ev.trust_tier, ev.title, ev.canonical_url,\n" +
  "       left(kc.heading || E'\\n' || kc.content, 1000) AS excerpt, ev.published_at, ev.retrieved_at, ev.version_hash,\n" +
  "       (f.score + CASE WHEN ev.trust_tier = 'official' THEN 0.01 WHEN ev.trust_tier = 'community' THEN 0.005 ELSE 0 END)::double precision AS score, ev.volatile_source\n" +
  "FROM fused f JOIN knowledge_chunks kc ON kc.id::text = f.chunk_id\n" +
  "JOIN eligible_versions ev ON ev.version_id = kc.version_id\n" +
  "ORDER BY score DESC, kc.id\n" +
  "LIMIT 10";

const HYDRATE_SQL =
  "SELECT kc.id::text AS chunk_id, sv.source_id, ks.owner, ks.trust_tier, left(sv.title, 300) AS title, left(sv.canonical_url, 2048) AS canonical_url,\n" +
  "       left(kc.heading || E'\\n' || kc.content, 1000) AS excerpt, sv.published_at, sv.retrieved_at, sv.content_hash AS version_hash,\n" +
  "       0::double precision AS score, (ks.registry ->> 'kind' = 'github' OR COALESCE(ks.registry -> 'topics', '[]'::jsonb) ?| ARRAY['governance','releases','release','on-chain','onchain','on_chain','node','ledger','staking','delegation','voting']) AS volatile_source\n" +
  "FROM knowledge_chunks kc JOIN source_versions sv ON sv.id = kc.version_id\n" +
  "JOIN knowledge_sources ks ON ks.id = sv.source_id\n" +
  "WHERE kc.embedding_model = $1 AND kc.id = ANY($2::bigint[]) AND char_length(sv.title) <= 300 AND char_length(sv.canonical_url) <= 2048";

async function hydrateEvidenceOnClient(
  client: PoolClient,
  chunkIds: string[],
  scores: number[],
  embeddingModel: string,
  now: Date,
  options: RepositoryOperationOptions,
): Promise<Evidence[] | undefined> {
  ensureActive(options.signal);
  const result = await client.query<RetrievalRow>(HYDRATE_SQL, [embeddingModel, chunkIds]);
  ensureActive(options.signal);
  const rows = result.rows;
  const byId = new Map(rows.map((row) => [row.chunk_id, row]));
  if (rows.length !== chunkIds.length || chunkIds.some((id) => !byId.has(id)) || rows.some((row) => row.volatile_source)) return undefined;
  return chunkIds.map((id, index) => {
    const row = byId.get(id);
    if (!row) throw new Error("Cached evidence is malformed.");
    return toEvidence({ ...row, score: scores[index] ?? 0 }, now);
  });
}

function toEvidence(row: RetrievalRow, now: Date): Evidence {
  const volatile = row.volatile_source;
  const retrievedAt = new Date(row.retrieved_at);
  const freshnessMs = volatile ? 2 * 60 * 60 * 1_000 : 48 * 60 * 60 * 1_000;
  return {
    id: row.chunk_id,
    sourceId: row.source_id,
    owner: boundedText(row.owner, 200),
    trustTier: row.trust_tier,
    title: boundedText(row.title, 300),
    url: boundedText(row.canonical_url, 2_048),
    excerpt: boundedExcerpt(row.excerpt),
    ...(row.published_at ? { publishedAt: new Date(row.published_at).toISOString() } : {}),
    retrievedAt: retrievedAt.toISOString(),
    versionHash: row.version_hash,
    score: row.score,
    stale: retrievedAt.getTime() < now.getTime() - freshnessMs,
  };
}

function boundedExcerpt(value: string): string {
  const excerpt = value.slice(0, MAX_EXCERPT_CHARS);
  return excerpt.length > 0 && /[\uD800-\uDBFF]$/.test(excerpt) ? excerpt.slice(0, -1) : excerpt;
}

function boundedText(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function validateQueryEmbedding(value: Array<{ index: number; embedding: number[] }>): number[] {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.index !== 0 || !Array.isArray(value[0].embedding)) throw new Error("Embedding vector is malformed.");
  const vector = value[0].embedding;
  if (vector.length !== VECTOR_DIMENSIONS) throw new Error("Embedding vector has invalid dimensions.");
  for (let index = 0; index < vector.length; index += 1) {
    if (!(index in vector) || typeof vector[index] !== "number" || !Number.isFinite(vector[index]) || Math.abs(vector[index]) > FLOAT32_MAX || !Number.isFinite(Math.fround(vector[index]))) throw new Error("Embedding vector is malformed.");
  }
  return vector;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

type DeadlineContext = { signal: AbortSignal; deadlineAt: number };

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number | undefined): DeadlineContext {
  const duration = timeoutMs ?? RETRIEVAL_DEADLINE_MS;
  const timeoutSignal = AbortSignal.timeout(duration);
  return {
    signal: parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal,
    deadlineAt: Date.now() + duration,
  };
}

function repositoryOperation(deadline: DeadlineContext): RepositoryOperationOptions {
  return { signal: deadline.signal, deadlineAt: deadline.deadlineAt };
}

function ensureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Retrieval aborted.");
}
