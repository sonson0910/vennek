# Cardano Private File Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Telegram user compare one private PDF, DOCX, TXT, or Markdown file with grounded Cardano evidence without retaining or promoting private content.

**Architecture:** A dedicated encrypted PgBoss job carries bounded Telegram metadata to the agent worker. The worker performs a bounded Telegram download, sends bytes to a separately sandboxed private extractor, then runs a separate in-memory comparison pipeline with `U*` private citations and existing `E*` Cardano citations. Private bytes, text, captions, and answers bypass shared knowledge and conversation persistence.

**Tech Stack:** Node.js 22, strict TypeScript, PostgreSQL/PgBoss, Vitest, `file-type@22.0.2`, `yauzl@3.4.0`, `mammoth@1.12.1`, existing PDF.js/LiteLLM/Cardano retrieval, Docker Compose.

**Approved design:** `docs/superpowers/specs/2026-08-26-cardano-private-file-comparison-design.md`

---

## File Structure

```text
packages/cardano-agent/src/privateComparison/
  privateDocumentProtocol.ts    shared limits, wire/result validators
  privateDocumentWorker.ts      type sniffing, DOCX preflight, safe extraction
  privateDocumentServer.ts      authenticated bounded extractor endpoint
  privateDocumentClient.ts      bounded internal extractor client
  comparePrivateDocument.ts     lexical selection, prompt, verify, render

apps/telegram-bot/src/
  privateComparisonQueue.ts     encrypted job envelope and PgBoss admission
  privateComparisonRuntime.ts   Telegram download -> extract -> compare cleanup

tests/
  privateDocumentProtocol.test.ts
  privateDocumentWorker.test.ts
  privateDocumentServer.test.ts
  privateDocumentClient.test.ts
  privateComparison.test.ts
  privateComparisonQueue.test.ts
  privateComparisonRuntime.test.ts
  privateComparison.integration.test.ts
```

Existing files change only for exports, Telegram envelope parsing/API calls,
worker composition, configuration, deployment, and focused regression tests.

## Task 1: Lock the private document protocol and direct dependencies

**Description:** Establish one transport-independent contract before any parser or Telegram code is written.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/cardano-agent/src/privateComparison/privateDocumentProtocol.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Create: `tests/privateDocumentProtocol.test.ts`

**Dependencies:** None

- [ ] **Step 1: Write the failing protocol tests**

```ts
import { describe, expect, it } from "vitest";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_CODE_POINTS,
  validatePrivateExtractionResult,
  validatePrivateDocumentToken,
} from "@vennek/cardano-agent";

it("accepts the exact Unicode output boundary", () => {
  const text = "😀".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS);
  expect(validatePrivateExtractionResult({ type: "text", title: "a.md", text }).text).toBe(text);
});

it("rejects one byte or code point beyond either boundary", () => {
  expect(() => validatePrivateExtractionResult({ type: "text", title: "x", text: "a".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS + 1) })).toThrow();
  expect(PRIVATE_DOCUMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
});

it("requires a canonical 32-byte base64url service token", () => {
  expect(validatePrivateDocumentToken(Buffer.alloc(32, 7).toString("base64url"))).toHaveLength(32);
  expect(() => validatePrivateDocumentToken("short")).toThrow();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateDocumentProtocol.test.ts`

Expected: FAIL because the protocol module and exports do not exist.

- [ ] **Step 3: Install only the three approved direct dependencies**

Run:

```bash
npm install --save-exact file-type@22.0.2 yauzl@3.4.0 mammoth@1.12.1
npm install --save-dev --save-exact @types/yauzl@2.10.3
```

- [ ] **Step 4: Implement the minimal frozen protocol**

```ts
export const PRIVATE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const PRIVATE_DOCUMENT_MAX_CODE_POINTS = 2_000_000;
export const PRIVATE_DOCUMENT_MAX_TEXT_BYTES = 8_000_000;
export const PRIVATE_DOCUMENT_PATH = "/v1/extract/private-document";
export const PRIVATE_DOCUMENT_TIMEOUT_MS = 30_000;

export type PrivateDocumentType = "pdf" | "docx" | "text" | "markdown";
export type PrivateExtractionResult = Readonly<{ type: PrivateDocumentType; title: string; text: string }>;

export function validatePrivateDocumentToken(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Private extractor token is invalid");
  const token = Buffer.from(value, "base64url");
  if (token.byteLength !== 32 || token.toString("base64url") !== value) throw new Error("Private extractor token is invalid");
  return token;
}
```

`validatePrivateExtractionResult` must accept exact keys only, a safe bounded title, a non-empty supported type, at most 2,000,000 Unicode code points, at most 8,000,000 UTF-8 bytes, and no wallet secret.

- [ ] **Step 5: Run GREEN and static checks**

Run: `npm test -- --run tests/privateDocumentProtocol.test.ts && npm run typecheck`

Expected: all protocol tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/cardano-agent/src/index.ts packages/cardano-agent/src/privateComparison/privateDocumentProtocol.ts tests/privateDocumentProtocol.test.ts
git commit -m "feat: define private document protocol"
```

## Task 2: Extract private documents safely inside a worker

**Description:** Parse supported formats in memory after type and archive preflight; fail closed on active or ambiguous content.

**Files:**
- Create: `packages/cardano-agent/src/privateComparison/privateDocumentWorker.ts`
- Create: `tests/privateDocumentWorker.test.ts`
- Modify: `packages/cardano-agent/src/privateComparison/privateDocumentProtocol.ts`
- Modify: `packages/cardano-agent/src/index.ts`

**Dependencies:** Task 1

- [ ] **Step 1: Write failing tests with generated minimal fixtures**

The test creates TXT/Markdown bytes directly and minimal DOCX/PDF fixtures in memory. It asserts:

```ts
expect(await extractPrivateDocument(txt, { fileName: "claim.txt", mime: "text/plain" })).toMatchObject({ type: "text", text: "Cardano uses proof of stake." });
expect(await extractPrivateDocument(markdown, { fileName: "claim.md", mime: "text/markdown" })).toMatchObject({ type: "markdown" });
await expect(extractPrivateDocument(zipBomb, docxMetadata)).rejects.toThrow("Unsafe document");
await expect(extractPrivateDocument(docxWithExternalRelationship, docxMetadata)).rejects.toThrow("Unsafe document");
await expect(extractPrivateDocument(activePdf, pdfMetadata)).rejects.toThrow("Unsafe document");
await expect(extractPrivateDocument(scannedPdf, pdfMetadata)).rejects.toThrow("Text unavailable");
await expect(extractPrivateDocument(pdfBytes, { fileName: "fake.txt", mime: "text/plain" })).rejects.toThrow("Document type mismatch");
```

Cover exact 20 MiB input, 20 MiB plus one byte, invalid UTF-8, traversal, encrypted ZIP entries, over 2,048 entries, over 64 MiB declared/actual expanded DOCX data, macros, ActiveX, OLE/package embeddings, `altChunk`, attached templates, and astral Unicode output bounds.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateDocumentWorker.test.ts`

Expected: FAIL because `extractPrivateDocument` does not exist.

- [ ] **Step 3: Implement type detection and text parsing**

Use `fileTypeFromBuffer(bytes)` for binary formats. Treat an unknown signature as text only when the advisory extension and MIME agree on TXT or Markdown, then decode with `new TextDecoder("utf-8", { fatal: true })`. Reject HTML and all other unknown data.

- [ ] **Step 4: Implement lazy DOCX preflight before Mammoth**

Open with:

```ts
yauzl.fromBuffer(Buffer.from(bytes), {
  lazyEntries: true,
  decodeStrings: true,
  validateEntrySizes: true,
  strictFileNames: true,
}, callback);
```

Require `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`. Reject encrypted entries, absolute/backslash/dot-segment paths, symlink Unix mode, more than 2,048 entries, any single expanded entry above 16 MiB, total expanded data above 64 MiB, compression ratios above 100:1, and the forbidden parts from the design. Read only bounded relationship/content-type XML for external/active checks, then call `mammoth.extractRawText({ buffer })` with external access left disabled.

- [ ] **Step 5: Implement private PDF inspection**

Reuse PDF.js options `isEvalSupported: false`, `useSystemFonts: false`, and the existing text-item accumulation. Before accepting text, inspect catalog/page actions, JavaScript name trees, OpenAction/AA, annotations with action entries, and embedded-file name trees; reject any active object. Reject more than 300 pages and empty extracted text.

- [ ] **Step 6: Run GREEN and regression tests**

Run: `npm test -- --run tests/privateDocumentWorker.test.ts tests/pdfExtractorWorker.test.ts tests/contentExtraction.test.ts`

Expected: private extraction tests pass and the public extraction behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/cardano-agent/src/privateComparison/privateDocumentProtocol.ts packages/cardano-agent/src/privateComparison/privateDocumentWorker.ts packages/cardano-agent/src/index.ts tests/privateDocumentWorker.test.ts
git commit -m "feat: extract private documents safely"
```

## Task 3: Expose the private extractor through a bounded internal service

**Description:** Isolate parser CPU/memory and authenticate the agent worker without sharing the knowledge PDF endpoint.

**Files:**
- Create: `packages/cardano-agent/src/privateComparison/privateDocumentServer.ts`
- Create: `packages/cardano-agent/src/privateComparison/privateDocumentClient.ts`
- Create: `tests/privateDocumentServer.test.ts`
- Create: `tests/privateDocumentClient.test.ts`
- Modify: `packages/cardano-agent/src/index.ts`

**Dependencies:** Task 2

- [ ] **Step 1: Write failing server and client boundary tests**

Assert constant-time bearer-token comparison, POST-only exact path, canonical content length from 1 through 20 MiB, no chunked request, exact metadata headers, request/worker timeout, one active extraction at a time, body mismatch rejection, JSON response bounds, cancellation, and generic error bodies. The client tests reject non-HTTP internal origins, credentials, path/query/hash, redirects, content encoding, oversized/malformed responses, and token leakage.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateDocumentServer.test.ts tests/privateDocumentClient.test.ts`

Expected: FAIL because service modules do not exist.

- [ ] **Step 3: Implement the native Node HTTP server**

Use `createServer` with 10-second headers, 30-second request, one-second connection checks, 16 KiB headers, 64 headers, and one global parser slot. Read exactly `Content-Length` bytes into a preallocated buffer, spawn the parsing worker with a transferred `ArrayBuffer`, terminate it on timeout/abort, validate the returned result, and zero the server buffer in `finally`.

- [ ] **Step 4: Implement the internal client**

Use `node:http.request`, `content-length`, `content-type: application/octet-stream`, safe base64url metadata headers, and `authorization: Bearer <token>`. Set `agent: false`, no redirects, fixed timeout, bounded response reads, exact JSON validation, and generic errors.

- [ ] **Step 5: Run GREEN and compiled import check**

Run: `npm test -- --run tests/privateDocumentServer.test.ts tests/privateDocumentClient.test.ts && npm run typecheck && npm run build && npm run verify:imports`

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cardano-agent/src/privateComparison/privateDocumentServer.ts packages/cardano-agent/src/privateComparison/privateDocumentClient.ts packages/cardano-agent/src/index.ts tests/privateDocumentServer.test.ts tests/privateDocumentClient.test.ts
git commit -m "feat: isolate private document extraction"
```

## Task 4: Compare private excerpts with Cardano evidence

**Description:** Build a separate, bounded comparison flow that never fabricates public provenance or persists private data.

**Files:**
- Create: `packages/cardano-agent/src/privateComparison/comparePrivateDocument.ts`
- Create: `tests/privateComparison.test.ts`
- Modify: `packages/cardano-agent/src/index.ts`

**Dependencies:** Task 1

- [ ] **Step 1: Write failing comparison tests**

Use real `chunkDocument`, strict fake completion output, and existing public evidence objects. Assert deterministic lexical selection, a maximum of six private excerpts and six public excerpts, stable `U*`/`E*` IDs, prompt-injection text treated as data, comparison claims requiring both namespaces, Cardano context claims requiring `E*`, official conflicts naming all owners, private source rendering without a URL, answer length bounds, unknown/duplicate IDs rejected, and wallet secrets rejected before completion.

```ts
expect(result).toContain("[Tệp người dùng: proposal.docx]");
expect(result).toContain("[Nguồn Cardano]");
expect(result).not.toContain("private.invalid");
expect(complete).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateComparison.test.ts`

Expected: FAIL because `comparePrivateDocument` does not exist.

- [ ] **Step 3: Implement deterministic lexical selection**

Normalize caption and chunks with Unicode word segmentation where available, fall back to a Unicode letter/number regex, remove a small fixed multilingual stopword set, score term overlap plus heading matches, and sort by score then original position. Skip private embeddings. Select at most six excerpts of at most 1,000 code points and 4,000 UTF-8 bytes each.

- [ ] **Step 4: Implement strict comparison generation and verification**

Define a strict JSON schema with claims `{ text, privateCitationIds, cardanoCitationIds, kind }`. Snapshot all inputs, escape evidence JSON, state that evidence is untrusted, and use only dedicated private generation/verifier models. Parse exact keys and known IDs. Verification must preserve cited namespace sets and reject unsupported claims rather than repairing them.

- [ ] **Step 5: Render localized private/public provenance**

Render private citations as bounded labels with no URL and Cardano citations through the existing provenance rules. Keep Telegram output under the existing answer limit by dropping trailing claims, never sources required by a retained claim.

- [ ] **Step 6: Run GREEN and public grounding regressions**

Run: `npm test -- --run tests/privateComparison.test.ts tests/groundedAnswer.test.ts tests/answerQuestion.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cardano-agent/src/privateComparison/comparePrivateDocument.ts packages/cardano-agent/src/index.ts tests/privateComparison.test.ts
git commit -m "feat: compare private files with Cardano evidence"
```

## Task 5: Admit encrypted private comparison jobs

**Description:** Parse one-shot private document updates and persist only an authenticated encrypted metadata envelope for retry.

**Files:**
- Create: `apps/telegram-bot/src/privateComparisonQueue.ts`
- Modify: `apps/telegram-bot/src/webhookRuntime.ts`
- Modify: `apps/telegram-bot/src/agentQueue.ts`
- Create: `tests/privateComparisonQueue.test.ts`
- Modify: `tests/webhookRuntime.test.ts`

**Dependencies:** Task 1

- [ ] **Step 1: Write failing webhook and queue tests**

Assert text-only updates are byte-for-byte compatible; one private-chat document plus non-empty caption becomes a private job; groups, channels, multiple media fields, missing caption, oversize advisory size, unsafe metadata, wallet secrets, replay, cross-owner AAD, tampered ciphertext, extra keys, and noncanonical IDs fail closed. Inspect PgBoss arguments to prove caption/file ID/name are absent from plaintext serialized job fields.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateComparisonQueue.test.ts tests/webhookRuntime.test.ts tests/agentQueue.test.ts`

Expected: new private update cases fail while existing text cases pass.

- [ ] **Step 3: Implement exact Telegram document parsing**

Extend the webhook parser to return a discriminated union:

```ts
type TelegramIngressJob =
  | { kind: "answer"; updateId: number; telegramUserId: string; telegramChatId: string; text: string }
  | { kind: "private-compare"; updateId: number; telegramUserId: string; telegramChatId: string; encrypted: EncryptedText };
```

Require `message.chat.type === "private"`, `from.id === chat.id`, exact document metadata types, bounded filename/MIME/file ID, advisory size at most 20 MiB, and caption within the existing Telegram byte/code-point bound.

- [ ] **Step 4: Implement encrypted queue admission**

Serialize exact bounded private metadata to JSON, encrypt using the existing AES-256-GCM helper and AAD `telegram-private-compare:<update>:<user>:<chat>`, then enqueue under a separate queue with singleton key `private:<update>`, three retries, retry backoff, one-hour retention/expiry, and the same transactional update claim/admission limiter. Export decryption that repeats exact-key validation and owner binding.

- [ ] **Step 5: Run GREEN and security regressions**

Run: `npm test -- --run tests/privateComparisonQueue.test.ts tests/webhookRuntime.test.ts tests/agentQueue.test.ts tests/agentSecurity.test.ts`

Expected: all tests pass with no plaintext private metadata in persisted job arguments.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/privateComparisonQueue.ts apps/telegram-bot/src/webhookRuntime.ts apps/telegram-bot/src/agentQueue.ts tests/privateComparisonQueue.test.ts tests/webhookRuntime.test.ts
git commit -m "feat: admit encrypted private comparison jobs"
```

## Task 6: Download Telegram documents through a fixed bounded origin

**Description:** Add only the two Telegram API operations needed by the private worker, with no reusable arbitrary downloader.

**Files:**
- Modify: `apps/telegram-bot/src/pollingRuntime.ts`
- Create: `apps/telegram-bot/src/privateComparisonRuntime.ts`
- Create: `tests/privateComparisonRuntime.test.ts`
- Modify: `tests/pollingRuntime.test.ts`

**Dependencies:** Task 5

- [ ] **Step 1: Write failing Telegram adapter/download tests**

Assert `getFile` uses the JSON API with a bounded file ID; the returned object has exact safe fields; download origin is exactly `https://api.telegram.org/file/bot<TOKEN>/`; relative path is canonical and contains no dot segment, query, fragment, credentials, encoded slash/backslash, or control character; redirects and compression are rejected; declared and streamed sizes are enforced; timeout/abort cancels the stream; buffers are zeroed after the consumer returns; and sanitized errors contain no token/path/file metadata.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateComparisonRuntime.test.ts tests/pollingRuntime.test.ts`

Expected: FAIL because the document API/download path does not exist.

- [ ] **Step 3: Extend the Telegram API interface narrowly**

Add `getFile({ file_id })` and `downloadFile(filePath, expectedSize, signal)` to `TelegramApi`. Keep `telegramCall` for JSON and implement the fixed download inside `createTelegramApi`; never expose a generic URL fetch dependency.

- [ ] **Step 4: Implement bounded download and cleanup**

Use native `https.request` with `agent: false`, `accept-encoding: identity`, fixed hostname/path construction, 15-second timeout, no redirect handling, status 200, supported content type, canonical length when present, and a hard streaming counter. Return a Buffer only to the supplied callback and fill it with zero in `finally`.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- --run tests/privateComparisonRuntime.test.ts tests/pollingRuntime.test.ts tests/webhookRuntime.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/pollingRuntime.ts apps/telegram-bot/src/privateComparisonRuntime.ts tests/privateComparisonRuntime.test.ts tests/pollingRuntime.test.ts
git commit -m "feat: download private Telegram documents safely"
```

## Task 7: Compose the end-to-end private comparison worker

**Description:** Connect queue decryption, download, extraction, Cardano retrieval, private models, delivery, status, and cleanup without conversation persistence.

**Files:**
- Modify: `apps/telegram-bot/src/privateComparisonRuntime.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `packages/cardano-agent/src/config.ts`
- Create: `tests/privateComparisonRuntimeComposition.test.ts`
- Modify: `tests/runtimeComposition.test.ts`

**Dependencies:** Tasks 3, 4, and 6

- [ ] **Step 1: Write failing composition tests**

Assert one private job calls download, extractor, public retrieval with caption only, private compare, and delivery in order. Assert no `ConversationRepository.append`, discovery, promotion, knowledge write, or cache write call. Cover secret detection before extractor/provider, stale/empty Cardano evidence, private route missing, extraction/provider/delivery failure, retry, update status, cleanup, sanitized logs, and exact user/chat delivery binding.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateComparisonRuntimeComposition.test.ts tests/runtimeComposition.test.ts`

Expected: private worker composition cases fail.

- [ ] **Step 3: Add fail-closed private runtime configuration**

Require `PRIVATE_DOCUMENT_EXTRACTOR_URL`, `PRIVATE_DOCUMENT_EXTRACTOR_TOKEN`, `VENNEK_PRIVATE_MODEL_QUALITY`, and `VENNEK_PRIVATE_MODEL_VERIFIER` only in agent-worker mode. Origins must be plain internal HTTP without credentials/query/hash; models must be distinct bounded aliases beginning `cardano-private-`; no fallback list is accepted.

- [ ] **Step 4: Register the private queue worker**

Create one `PrivateDocumentClient`, reuse public Cardano `retrieveEvidence` with the caption and `personalized: true`, call `comparePrivateDocument`, deliver only to the bound chat, then update `telegram_updates`. Catch only to sanitize/log category and rethrow retryable failures. Cleanup remains inside the runtime `finally`.

- [ ] **Step 5: Run GREEN and broad worker regressions**

Run: `npm test -- --run tests/privateComparisonRuntimeComposition.test.ts tests/runtimeComposition.test.ts tests/agentWorker.test.ts tests/knowledgePromotionServer.test.ts`

Expected: all tests pass and public worker behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/privateComparisonRuntime.ts apps/telegram-bot/src/main.ts packages/cardano-agent/src/config.ts tests/privateComparisonRuntimeComposition.test.ts tests/runtimeComposition.test.ts
git commit -m "feat: run private comparisons end to end"
```

## Task 8: Support polling ingress without weakening webhook behavior

**Description:** Keep the legacy polling mode functionally equivalent for private document updates.

**Files:**
- Modify: `apps/telegram-bot/src/pollingRuntime.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `tests/pollingRuntime.test.ts`
- Modify: `tests/runtimeComposition.test.ts`

**Dependencies:** Tasks 5 and 7

- [ ] **Step 1: Write failing polling tests**

Assert polling requests `message` updates, routes private document+caption through the same encrypted admission function, advances offset only after admission outcome, applies the same rate limit and owner checks, keeps text answers unchanged, and never downloads or parses inside the poller.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/pollingRuntime.test.ts tests/runtimeComposition.test.ts`

Expected: document polling cases fail.

- [ ] **Step 3: Reuse the shared ingress parser/admission boundary**

Move only pure Telegram-message canonicalization to a focused exported helper used by webhook and poller. Do not create a general transport abstraction. Polling receives an `enqueuePrivate` dependency alongside `answer` and handles the discriminated result.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- --run tests/pollingRuntime.test.ts tests/webhookRuntime.test.ts tests/runtimeComposition.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/telegram-bot/src/pollingRuntime.ts apps/telegram-bot/src/main.ts tests/pollingRuntime.test.ts tests/runtimeComposition.test.ts
git commit -m "feat: accept private files in Telegram polling"
```

## Task 9: Harden and wire deployment

**Description:** Run the private extractor as a distinct internal service and pin private model routes without exposing a host port.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `deploy/vennek.env.example`
- Modify: `config/litellm.example.yaml`
- Modify: `Dockerfile`
- Modify: `tests/compose.test.ts`
- Create: `scripts/verify-private-extractor-compose.ts`
- Modify: `package.json`

**Dependencies:** Tasks 3 and 7

- [ ] **Step 1: Write failing Compose/config tests**

Assert the new service has no `ports`, uses a distinct token and internal network, read-only filesystem, non-root user, tmpfs, dropped capabilities, no-new-privileges, init, CPU/RAM/PID limits, healthcheck, and only the agent worker can reach it. Assert knowledge worker remains attached only to the public PDF sandbox. Assert private aliases each map to exactly one model and have no fallback.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/compose.test.ts`

Expected: FAIL because the private service is absent.

- [ ] **Step 3: Add the private extractor service and agent wiring**

Mirror the public PDF sandbox controls with a distinct `private-document-sandbox` internal network and `PRIVATE_DOCUMENT_EXTRACTOR_TOKEN`. Command the built server module directly. Add only extractor URL/token and private model aliases to agent-worker environment.

- [ ] **Step 4: Add deterministic Compose boundary verification**

`scripts/verify-private-extractor-compose.ts` starts the extractor service, waits for health, submits generated safe TXT/DOCX/PDF fixtures plus rejected active/spoofed fixtures, verifies no host exposure, and exits non-zero on any mismatch. It never reads production credentials or writes fixture content outside a temporary directory.

- [ ] **Step 5: Run GREEN and configuration checks**

Run:

```bash
npm test -- --run tests/compose.test.ts
docker compose --env-file .env.example config --quiet
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example deploy/vennek.env.example config/litellm.example.yaml Dockerfile tests/compose.test.ts scripts/verify-private-extractor-compose.ts package.json
git commit -m "feat: deploy isolated private document extraction"
```

## Task 10: Prove privacy, expiry, and end-to-end behavior with real PostgreSQL

**Description:** Verify the trust boundary across PgBoss, Telegram download, extractor process, retrieval, model output, delivery, and terminal deletion.

**Files:**
- Create: `tests/privateComparison.integration.test.ts`
- Modify: `tests/provisionAppRole.integration.test.ts`
- Modify: `tests/provisionAppRole.test.ts`
- Modify: `scripts/provision-app-role.ts`

**Dependencies:** Tasks 5 through 9

- [ ] **Step 1: Write failing integration tests**

Against a disposable PostgreSQL instance, enqueue a signed private update, process it with local Telegram/extractor/model servers, and assert one grounded delivery. Query all application-visible conversation, knowledge, retrieval-cache, promotion-audit, Telegram-update, and PgBoss tables to prove no caption, filename, file ID, extracted phrase, private citation, or answer remains after completion. Assert ciphertext tampering/cross-owner replay fails and an abandoned job is deleted at the one-hour boundary.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/privateComparison.integration.test.ts`

Expected: FAIL until role grants/cleanup and worker lifecycle are complete.

- [ ] **Step 3: Grant only the existing app-owned queue operations**

If the separate queue uses the existing PgBoss schema, add no new database object or grant. Update provisioning only when the real integration test proves a missing least-privilege operation; never grant knowledge or promotion mutation.

- [ ] **Step 4: Implement terminal deletion and expiry proof**

Use PgBoss-supported retention/expiration settings and explicit terminal cleanup by job ID. The integration test advances database time through injected clock values or inserts an expired fixture; it must not sleep for an hour.

- [ ] **Step 5: Run GREEN with real database**

Run: `DATABASE_URL=<disposable-app-url> npm test -- --run tests/privateComparison.integration.test.ts tests/provisionAppRole.integration.test.ts`

Expected: all tests pass and private markers are absent from every queried durable surface.

- [ ] **Step 6: Commit**

```bash
git add tests/privateComparison.integration.test.ts tests/provisionAppRole.integration.test.ts tests/provisionAppRole.test.ts scripts/provision-app-role.ts
git commit -m "test: prove private comparison isolation"
```

## Task 11: Final verification, review, and milestone closeout

**Description:** Run release-proportional gates, resolve independent findings, and mark only R8c complete.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md`
- Modify: `docs/superpowers/plans/2026-08-26-cardano-private-file-comparison.md`

**Dependencies:** Tasks 1 through 10

- [ ] **Step 1: Run targeted suites**

```bash
npm test -- --run tests/privateDocumentProtocol.test.ts tests/privateDocumentWorker.test.ts tests/privateDocumentServer.test.ts tests/privateDocumentClient.test.ts
npm test -- --run tests/privateComparison.test.ts tests/privateComparisonQueue.test.ts tests/privateComparisonRuntime.test.ts tests/privateComparisonRuntimeComposition.test.ts tests/privateComparison.integration.test.ts
```

- [ ] **Step 2: Run full static and dependency gates**

```bash
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
git diff --check
```

- [ ] **Step 3: Run the complete test suite**

Run: `npm test -- --run`

Expected: all credential-independent tests pass; any credential-gated live test is reported explicitly.

- [ ] **Step 4: Run compiled-process and container smoke tests**

Run the private extractor Compose verifier, then a compiled worker smoke with local Telegram/LiteLLM servers and disposable PostgreSQL. Cover safe DOCX, exact-size Unicode TXT, spoofed file, tampered queue envelope, retry, one delivery, and zero retained private markers.

- [ ] **Step 5: Inspect the complete R8c diff**

Run: `git diff --stat 8a056f3..HEAD && git diff --check 8a056f3..HEAD`

Confirm no R9/R10 implementation, arbitrary URL intake, public knowledge mutation, host-exposed extractor port, secret, generated fixture, or private content entered the range.

- [ ] **Step 6: Independent reviews**

After implementation and verification, dispatch one correctness reviewer and one security reviewer in parallel. Fix every substantiated finding with a failing regression test, rerun affected and broad gates, and send fixes back to the same reviewers until both report PASS.

- [ ] **Step 7: Mark R8c complete**

Add an R8c completion checkbox and evidence to `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md`. Record final commits, test counts, external skips, smoke results, and both review outcomes. Do not mark R9 or R10 complete.

- [ ] **Step 8: Commit closeout and remove disposable resources**

```bash
git add docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md docs/superpowers/plans/2026-08-26-cardano-private-file-comparison.md
git commit -m "docs: close private comparison milestone"
```

Inspect exact test container and volume names, then remove only those disposable resources created by this plan. Report that their test data is unrecoverable.

## Checkpoints

### After Tasks 1–3: Extraction boundary

- [ ] Supported-format protocol and exact limits pass.
- [ ] Unsafe PDF/DOCX cases fail closed.
- [ ] Authenticated internal service passes timeout/cancellation tests.
- [ ] Public extraction regressions pass.

### After Tasks 4–7: Complete private path

- [ ] Comparison requires correct private/public provenance.
- [ ] Encrypted queue contains no plaintext metadata.
- [ ] Telegram download is origin-locked and bounded.
- [ ] No private content reaches conversation or knowledge paths.

### After Tasks 8–10: Deployable integration

- [ ] Polling and webhook behave consistently.
- [ ] Compose isolation and private model aliases validate.
- [ ] Real PostgreSQL proves terminal deletion and one-hour expiry.

### After Task 11: R8c complete

- [ ] Full suite and release gates pass.
- [ ] Correctness and security reviews pass.
- [ ] Only R8c is marked complete.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| ZIP/PDF parser resource exhaustion | High | Preflight, worker termination, single-flight service, container CPU/RAM/PID limits |
| Private data retained in PgBoss | High | AES-GCM envelope, owner-bound AAD, prompt terminal deletion, one-hour expiry, DB marker scans |
| Bot token leaked in download errors | High | Fixed native downloader, no URL logging, sanitized category-only errors |
| Provider retains private data | High | Dedicated no-fallback aliases and fail-closed runtime; operator contract documented |
| Private evidence gets public provenance | High | Separate `U*` schema/renderer with no URL |
| Upload DoS affects knowledge ingestion | High | Distinct extractor process, token, worker slot, and internal network |
| Lexical selection misses relevant passages | Medium | R9 measures recall; add private embeddings only if the measured threshold fails |

## Plan Self-Review

- Spec coverage: every requirement in sections 1–15 maps to Tasks 1–11.
- Placeholder scan: no unfinished marker or deferred implementation instruction remains.
- Type consistency: `PrivateExtractionResult`, encrypted private jobs, `U*`/`E*` citations, service token, and runtime config names are consistent across tasks.
- Scope: R8c only; R9 evaluation and R10 release work remain separate milestones.
