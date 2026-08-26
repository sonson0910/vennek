import * as cheerio from "cheerio";
import {
  readResponseBytesLimited,
  requestPublicHttps,
  type PublicHttpsLookup,
  type PublicHttpsRequest,
} from "@vennek/cardano-governance-skills";
import { extractContent } from "./extractContent.js";
import {
  KnowledgeRepository,
  type RepositoryOperationOptions,
  type StackExchangeFetchState,
} from "./knowledgeRepository.js";
import { validateSourceRegistry, type SourceRegistryEntry } from "./sourceRegistry.js";

const API_ORIGIN = "https://api.stackexchange.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_QUESTION_PAGES = 5;
const MAX_ANSWER_PAGES = 5;
const MAX_DOCUMENTS = 500;
const REQUEST_TIMEOUT_MS = 8_000;
const CRAWL_TIMEOUT_MS = 120_000;
const STATE_OPERATION_TIMEOUT_MS = 5_000;
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1_000;
const MAX_TITLE_CHARS = 300;
const MAX_AUTHOR_CHARS = 120;
const MAX_DOCUMENT_CHARS = 2_000_000;

export type StackExchangeSourceInput = {
  entry: Extract<SourceRegistryEntry, { kind: "stackexchange" }>;
  repository: Pick<KnowledgeRepository, "ensureSource" | "getStackExchangeFetchState" | "compareAndSetStackExchangeFetchState">;
  signal: AbortSignal;
  now?: Date;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
};

export type StackExchangeSourceResult = {
  documents: Array<{ canonicalUrl: string; title: string; text: string; publishedAt: Date }>;
  unchanged: number;
  deferredUntil?: Date;
  commitState?: (options?: RepositoryOperationOptions) => Promise<boolean>;
};

type ApiResponse = {
  items: unknown[];
  hasMore: boolean;
  quotaRemaining: number;
  backoffSeconds?: number;
};

type Author = {
  displayName: string;
  url: string;
};

type Question = {
  id: number;
  title: string;
  body: string;
  publishedAt: Date;
  author: Author;
  license: string;
};

type Answer = {
  id: number;
  questionId: number;
  body: string;
  publishedAt: Date;
  author: Author;
  license: string;
};

export async function fetchStackExchangeSource(input: StackExchangeSourceInput): Promise<StackExchangeSourceResult> {
  input.signal.throwIfAborted();
  const [validated] = validateSourceRegistry([input.entry]);
  if (validated.kind !== "stackexchange") {
    throw new Error("Stack Exchange retrieval requires a stackexchange source registry entry.");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Retrieval time must be a valid date.");
  const crawlSignal = AbortSignal.any([input.signal, AbortSignal.timeout(CRAWL_TIMEOUT_MS)]);
  const repositoryOptions: RepositoryOperationOptions = {
    signal: crawlSignal,
    deadlineAt: Date.now() + CRAWL_TIMEOUT_MS,
  };
  await input.repository.ensureSource(validated, repositoryOptions);
  crawlSignal.throwIfAborted();
  const originalState = await input.repository.getStackExchangeFetchState(validated.id, repositoryOptions);
  crawlSignal.throwIfAborted();
  const storedDeferral = futureRetryAt(originalState, now);
  if (storedDeferral) return { documents: [], unchanged: 0, deferredUntil: storedDeferral };

  let consumedBytes = 0;
  let lastQuota = 0;
  const questions = new Map<number, Question>();
  const answerIdsSeen = new Set<number>();
  const documents: StackExchangeSourceResult["documents"] = [];
  let questionPage = 1;
  let hasMoreQuestions = true;

  while (hasMoreQuestions && questionPage <= MAX_QUESTION_PAGES && documents.length < MAX_DOCUMENTS) {
    crawlSignal.throwIfAborted();
    const response = await fetchApiPage({
      path: "/2.3/questions",
      params: [
        ["order", "desc"],
        ["sort", "activity"],
        ["pagesize", "100"],
        ["page", String(questionPage)],
        ["filter", "withbody"],
        ["site", "cardano"],
      ],
      ...input,
      signal: crawlSignal,
      consumedBytes: () => consumedBytes,
      addConsumedBytes: (bytes) => { consumedBytes += bytes; },
    });
    lastQuota = response.quotaRemaining;
    if (response.backoffSeconds !== undefined || lastQuota === 0) {
      const deferredUntil = await deferFetch(input, validated.id, originalState, now, response.quotaRemaining, response.backoffSeconds, crawlSignal);
      return { documents: [], unchanged: 0, deferredUntil };
    }

    if (response.items.length > 100) throw new Error("Stack Exchange question page is too large.");
    const pageQuestions: Question[] = [];
    for (const item of response.items) {
      const question = parseQuestion(item);
      if (questions.has(question.id)) throw new Error("Stack Exchange question IDs must be unique.");
      questions.set(question.id, question);
      pageQuestions.push(question);
      if (documents.length >= MAX_DOCUMENTS) break;
      documents.push(await documentForQuestion(question));
    }

    if (pageQuestions.length > 0 && documents.length < MAX_DOCUMENTS) {
      const answerIds = pageQuestions.map((question) => String(question.id)).join(";");
      let answerPage = 1;
      let hasMoreAnswers = true;
      while (hasMoreAnswers && answerPage <= MAX_ANSWER_PAGES && documents.length < MAX_DOCUMENTS) {
        const answerParams: Array<[string, string]> = [
          ["order", "desc"],
          ["sort", "activity"],
          ["pagesize", "100"],
          ["page", String(answerPage)],
          ["filter", "withbody"],
          ["site", "cardano"],
        ];
        const answers = await fetchApiPage({
          path: `/2.3/questions/${answerIds}/answers`,
          params: answerParams,
          ...input,
          signal: crawlSignal,
          consumedBytes: () => consumedBytes,
          addConsumedBytes: (bytes) => { consumedBytes += bytes; },
        });
        lastQuota = answers.quotaRemaining;
        if (answers.backoffSeconds !== undefined || lastQuota === 0) {
          const deferredUntil = await deferFetch(input, validated.id, originalState, now, answers.quotaRemaining, answers.backoffSeconds, crawlSignal);
          return { documents: [], unchanged: 0, deferredUntil };
        }
        if (answers.items.length > 100) throw new Error("Stack Exchange answer page is too large.");
        for (const item of answers.items) {
          const answer = parseAnswer(item, new Set(pageQuestions.map((question) => question.id)));
          if (documents.length >= MAX_DOCUMENTS) break;
          if (!questions.has(answer.questionId)) throw new Error("Stack Exchange answer question ID is not in the requested page.");
          if (answerIdsSeen.has(answer.id)) throw new Error("Stack Exchange answer IDs must be unique.");
          answerIdsSeen.add(answer.id);
          documents.push(await documentForAnswer(answer, questions.get(answer.questionId)!));
        }
        hasMoreAnswers = answers.hasMore;
        answerPage += 1;
      }
    }

    hasMoreQuestions = response.hasMore;
    questionPage += 1;
  }

  const commitState = async (options?: RepositoryOperationOptions): Promise<boolean> => input.repository.compareAndSetStackExchangeFetchState(
    validated.id,
    originalState,
    { checkedAt: now.toISOString(), quotaRemaining: lastQuota },
    options,
  );
  return { documents, unchanged: 0, commitState };
}

async function fetchApiPage(input: StackExchangeSourceInput & {
  path: string;
  params: Array<[string, string]>;
  signal: AbortSignal;
  consumedBytes: () => number;
  addConsumedBytes: (bytes: number) => void;
}): Promise<ApiResponse> {
  const url = new URL(input.path, API_ORIGIN);
  const query = new URLSearchParams(input.params);
  url.search = query.toString();
  if (input.consumedBytes() >= MAX_TOTAL_RESPONSE_BYTES) {
    throw new Error("Aggregate Stack Exchange response byte budget is exhausted.");
  }
  const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await requestPublicHttps({
    url: url.toString(),
    allowedDomains: input.entry.allowedDomains,
    signal: requestSignal,
    method: "GET",
    headers: { accept: "application/json", "accept-encoding": "identity" },
    lookup: input.lookup,
    request: input.request,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.cancel();
    throw new Error(`Stack Exchange API returned HTTP ${response.statusCode}.`);
  }
  const remaining = MAX_TOTAL_RESPONSE_BYTES - input.consumedBytes();
  const result = await readResponseBytesLimited(response, Math.min(MAX_RESPONSE_BYTES, remaining), ["application/json"], requestSignal);
  input.addConsumedBytes(result.bytes.byteLength);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
  } catch {
    throw new Error("Stack Exchange API response is not valid UTF-8 JSON.");
  }
  return parseApiResponse(payload);
}

function parseApiResponse(value: unknown): ApiResponse {
  if (!isPlainRecord(value)) throw new Error("Stack Exchange API response wrapper is invalid.");
  if ("error_id" in value || "error_message" in value || "error_name" in value) {
    throw new Error("Stack Exchange API returned an error wrapper.");
  }
  if (!Array.isArray(value.items)) throw new Error("Stack Exchange API response items are invalid.");
  if (typeof value.has_more !== "boolean") throw new Error("Stack Exchange API response has_more is invalid.");
  const quotaRemaining = safeNonNegativeInteger(value.quota_remaining, "quota_remaining");
  let backoffSeconds: number | undefined;
  if ("backoff" in value) {
    backoffSeconds = safeNonNegativeInteger(value.backoff, "backoff");
  }
  return { items: value.items, hasMore: value.has_more, quotaRemaining, ...(backoffSeconds === undefined ? {} : { backoffSeconds }) };
}

function parseQuestion(value: unknown): Question {
  if (!isPlainRecord(value)) throw new Error("Stack Exchange question item is invalid.");
  const id = safePositiveInteger(value.question_id, "question_id");
  const title = boundedSanitized(value.title, MAX_TITLE_CHARS, "question title");
  const body = requiredString(value.body, "question body");
  const publishedAt = timestampDate(value.creation_date, "question creation_date");
  timestampDate(value.last_activity_date, "question last_activity_date");
  const license = validateLicense(value.content_license);
  return { id, title, body, publishedAt, license, author: parseAuthor(value.owner) };
}

function parseAnswer(value: unknown, questionIds: Set<number>): Answer {
  if (!isPlainRecord(value)) throw new Error("Stack Exchange answer item is invalid.");
  const id = safePositiveInteger(value.answer_id, "answer_id");
  const questionId = safePositiveInteger(value.question_id, "answer question_id");
  if (!questionIds.has(questionId)) throw new Error("Stack Exchange answer question_id is invalid.");
  const body = requiredString(value.body, "answer body");
  const publishedAt = timestampDate(value.creation_date, "answer creation_date");
  if ("last_activity_date" in value) timestampDate(value.last_activity_date, "answer last_activity_date");
  const license = validateLicense(value.content_license);
  return { id, questionId, body, publishedAt, license, author: parseAuthor(value.owner) };
}

function parseAuthor(value: unknown): Author {
  if (value === null || value === undefined) return { displayName: "deleted user", url: "unavailable" };
  if (!isPlainRecord(value)) throw new Error("Stack Exchange owner is invalid.");
  const userId = safePositiveInteger(value.user_id, "owner user_id");
  const displayName = boundedSanitized(value.display_name, MAX_AUTHOR_CHARS, "owner display_name");
  const url = typeof value.link === "string" && validAuthorUrl(value.link, userId) ? value.link : "unavailable";
  return { displayName, url };
}

function validAuthorUrl(value: string, userId: number): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "cardano.stackexchange.com"
      && !url.port
      && !url.username
      && !url.password
      && url.pathname.startsWith(`/users/${userId}/`)
      && url.pathname.length > `/users/${userId}/`.length
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

async function documentForQuestion(question: Question): Promise<StackExchangeSourceResult["documents"][number]> {
  const canonicalUrl = `https://cardano.stackexchange.com/questions/${question.id}`;
  return {
    canonicalUrl,
    title: buildTitle(question.title, question.author, question.license),
    text: await buildText(question.body, question.author, question.license, canonicalUrl),
    publishedAt: question.publishedAt,
  };
}

async function documentForAnswer(answer: Answer, question: Question): Promise<StackExchangeSourceResult["documents"][number]> {
  const canonicalUrl = `https://cardano.stackexchange.com/a/${answer.id}`;
  return {
    canonicalUrl,
    title: buildTitle(`Answer to: ${question.title}`, answer.author, answer.license),
    text: await buildText(answer.body, answer.author, answer.license, canonicalUrl),
    publishedAt: answer.publishedAt,
  };
}

function buildTitle(base: string, author: Author, license: string): string {
  const suffix = ` — ${author.displayName} [${license}]`;
  const prefix = Array.from(base).slice(0, Math.max(1, MAX_TITLE_CHARS - Array.from(suffix).length)).join("");
  return `${prefix}${suffix}`;
}

async function buildText(body: string, author: Author, license: string, canonicalUrl: string): Promise<string> {
  const extracted = await extractContent({ mime: "text/html", bytes: new TextEncoder().encode(body) });
  const attribution = [
    "Attribution:",
    `Author: ${author.displayName}`,
    `Author URL: ${author.url}`,
    `License: ${license}`,
    `Source: ${canonicalUrl}`,
  ].join("\n");
  const text = `${extracted.text}\n\n${attribution}`.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (text.length > MAX_DOCUMENT_CHARS) throw new Error("Stack Exchange document content is too large.");
  return text;
}

function boundedSanitized(value: unknown, maxChars: number, field: string): string {
  const raw = requiredString(value, field);
  const $ = cheerio.load(`<div>${raw}</div>`);
  $("script, style, nav, footer, [hidden], [aria-hidden='true']").remove();
  const text = $.root().text().replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${field} is empty.`);
  return Array.from(text).slice(0, maxChars).join("");
}

function validateLicense(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^CC BY-SA [1-4]\.[0-9]$/.test(value)) {
    throw new Error("Stack Exchange content license is invalid.");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Stack Exchange ${field} is invalid.`);
  }
  return value;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Stack Exchange ${field} is invalid.`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stack Exchange ${field} is invalid.`);
  }
  return value;
}

function timestampDate(value: unknown, field: string): Date {
  const seconds = safeNonNegativeInteger(value, field);
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) throw new Error(`Stack Exchange ${field} is invalid.`);
  return date;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function futureRetryAt(state: StackExchangeFetchState | null, now: Date): Date | undefined {
  if (!state?.retryAt) return undefined;
  const timestamp = new Date(state.retryAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) return undefined;
  return new Date(Math.min(timestamp, now.getTime() + MAX_RETRY_MS));
}

async function deferFetch(
  input: StackExchangeSourceInput,
  sourceId: string,
  expectedState: StackExchangeFetchState | null,
  now: Date,
  quotaRemaining: number,
  backoffSeconds: number | undefined,
  signal: AbortSignal,
): Promise<Date> {
  const retrySeconds = Math.min(MAX_RETRY_MS / 1_000, backoffSeconds ?? 0);
  const retryMs = Math.max(MIN_RETRY_MS, retrySeconds * 1_000);
  const retryAt = new Date(now.getTime() + retryMs);
  const options: RepositoryOperationOptions = { signal, timeoutMs: STATE_OPERATION_TIMEOUT_MS };
  const nextState: StackExchangeFetchState = {
    checkedAt: now.toISOString(),
    retryAt: retryAt.toISOString(),
    quotaRemaining,
  };
  const persisted = await input.repository.compareAndSetStackExchangeFetchState(sourceId, expectedState, nextState, options);
  if (persisted) return retryAt;
  const current = await input.repository.getStackExchangeFetchState(sourceId, options);
  const currentRetryAt = futureRetryAt(current, now);
  if (currentRetryAt) return currentRetryAt;
  throw new Error("Stack Exchange fetch state concurrency conflict.");
}
