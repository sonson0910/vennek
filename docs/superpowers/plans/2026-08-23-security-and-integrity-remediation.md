# Security and Integrity Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all ten review findings while keeping Vennek a dependency-light, no-custody Telegram pilot.

**Architecture:** Harden the existing shared command path rather than adding parallel security layers. Make proof and citation validity explicit at their source, keep raw pasted text out of persistence, authorize and meter Telegram work before side effects, and bound every filesystem/network resource at its sink.

**Tech Stack:** TypeScript 5.5, Node.js 22 standard library, Vitest 4, npm workspaces, native `fetch`, filesystem APIs, and systemd deployment.

---

## File map

**Create**

- `packages/shared/src/validation.ts` — runtime `ProposalDocument` type guard shared by local ingestion and persistence.
- `apps/telegram-bot/src/accessControl.ts` — chat allowlist parsing and fixed-window rate limiting.
- `tests/accessControl.test.ts` — deterministic allowlist/rate-limit tests.

**Modify**

- `packages/shared/src/index.ts`, `packages/shared/src/types.ts` — export validation and document the hardened proof contract.
- `packages/cardano-governance-skills/src/adapters/blockfrost.ts` — complete proof-payload and hash validation.
- `packages/cardano-governance-skills/src/commands/proof.ts` — require expected hash.
- `packages/cardano-governance-skills/src/commands/analysis.ts` — claim-level citations and evidence-signal list.
- `packages/cardano-governance-skills/src/commands/proposal.ts` — render source claims with their own anchors.
- `packages/cardano-governance-skills/src/commands/compare.ts` — unique citations and no numeric quality score.
- `packages/cardano-governance-skills/src/commands/voteDraft.ts` — fixed generated voice plus quoted source claims.
- `packages/cardano-governance-skills/src/persistence/fileStore.ts` — skip raw pasted documents, redact cached public sources, rotate/prune.
- `packages/cardano-governance-skills/src/adapters/userProvided.ts` — streaming byte cap and strict content type.
- `packages/cardano-governance-skills/src/store/documentStore.ts` — canonical local-file confinement, size cap, structural validation.
- `apps/telegram-bot/src/pollingRuntime.ts` — authorization, rate limiting, bounded delivery retries, permanent-error handling.
- `apps/telegram-bot/src/main.ts`, `apps/telegram-bot/src/index.ts` — parse required pilot policy and export access-control types.
- `tests/blockfrost.test.ts`, `tests/commands.test.ts`, `tests/safety.test.ts`, `tests/persistence.test.ts`, `tests/pollingRuntime.test.ts`, `tests/adapters.test.ts`, `tests/documentStore.test.ts` — focused regressions.
- `package-lock.json` — safe transitive vulnerability resolutions only.
- `.env.example`, `deploy/vennek.env.example`, `README.md`, `docs/product/PRD.md`, `docs/product/safety-policy.md`, `docs/architecture/persistence.md`, `docs/deployment/telegram-runtime.md`, `docs/deployment/release-checklist.md` — public contracts and operator steps.

## Changeset 1 — Proof and source integrity

### Task 1: Fail closed on malformed or unbound proof metadata

**Files:**

- Modify: `packages/cardano-governance-skills/src/adapters/blockfrost.ts:34-181`
- Modify: `packages/cardano-governance-skills/src/commands/proof.ts:75-116`
- Test: `tests/blockfrost.test.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Add failing payload-validation tests**

Add these cases inside `describe("Blockfrost proof verification", ...)`:

```ts
it("rejects schema-only and malformed proof payloads", async () => {
  for (const malformed of [
    { schema: "vennek.proof.v1" },
    { ...payload, content_hash: "not-a-hash" },
    { ...payload, source_refs: "not-an-array" },
    { ...payload, created_at: "not-a-date" },
    { ...payload, agent_version: "" }
  ]) {
    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: {
        projectId: "test_project",
        fetchImpl: jsonFetch(200, [{ json_metadata: malformed }])
      }
    })).resolves.toMatchObject({ ok: false, status: "failed" });
  }
});

it("requires an expected content hash", async () => {
  await expect(proofVerifyCommand(txHash, {
    projectId: "test_project",
    fetchImpl: jsonFetch(200, [{ json_metadata: payload }])
  })).rejects.toThrow(/requires <tx_hash> <expected_content_hash>/i);
});

it("rejects a non-sha256 expected value", async () => {
  await expect(proofVerifyCommand(`${txHash} same-arbitrary-string`, {
    projectId: "test_project",
    fetchImpl: jsonFetch(200, [{ json_metadata: { ...payload, content_hash: "same-arbitrary-string" } }])
  })).rejects.toThrow(/SHA-256/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --run tests/blockfrost.test.ts
```

Expected: the schema-only payload is currently verified and the command currently accepts a missing expected hash.

- [ ] **Step 3: Replace the schema-only guard with complete validation**

In `blockfrost.ts`, make `expectedContentHash` required and use this validator:

```ts
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;

function isVennekProofPayload(value: unknown): value is ProofPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<ProofPayload>;
  return (
    payload.schema === "vennek.proof.v1" &&
    typeof payload.content_hash === "string" &&
    SHA256_PATTERN.test(payload.content_hash) &&
    Array.isArray(payload.source_refs) &&
    payload.source_refs.every((reference) => typeof reference === "string") &&
    typeof payload.created_at === "string" &&
    !Number.isNaN(Date.parse(payload.created_at)) &&
    typeof payload.agent_version === "string" &&
    payload.agent_version.trim().length > 0 &&
    (payload.report_id === undefined || typeof payload.report_id === "string")
  );
}

function normalizeContentHash(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error("Expected content hash must be a SHA-256 hex value.");
  }
  return value.replace(/^sha256:/i, "").toLowerCase();
}
```

Return a failed verification result when no complete payload is present. Compare normalized on-chain and expected hashes unconditionally.

- [ ] **Step 4: Require the expected hash at the command boundary**

In `proofVerifyCommand`, parse and validate both arguments before calling Blockfrost:

```ts
const [txHash, expectedContentHash, extra] = input.trim().split(/\s+/);
if (!txHash || !expectedContentHash || extra) {
  throw new Error("/proof-verify requires <tx_hash> <expected_content_hash>.");
}
if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(expectedContentHash)) {
  throw new Error("Expected content hash must be a SHA-256 hex value.");
}
```

- [ ] **Step 5: Update affected existing tests and run GREEN**

Pass `payload.content_hash` in the missing-project-ID and missing-metadata unit calls. Update router expectations so `/proof-verify <tx_hash>` reports the required two-argument contract.

Run:

```bash
npm test -- --run tests/blockfrost.test.ts tests/router.test.ts tests/proof.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cardano-governance-skills/src/adapters/blockfrost.ts packages/cardano-governance-skills/src/commands/proof.ts tests/blockfrost.test.ts tests/router.test.ts tests/proof.test.ts
git commit -m "fix: bind proof verification to valid content hashes"
```

### Task 2: Bind every analyzed claim to its supporting excerpt

**Files:**

- Modify: `packages/cardano-governance-skills/src/commands/analysis.ts:1-59`
- Modify: `packages/cardano-governance-skills/src/commands/proposal.ts:6-43`
- Modify: `packages/cardano-governance-skills/src/commands/compare.ts:6-56`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Add failing claim/citation regressions**

Add a document with a relevant claim after 300 benign characters and a two-document comparison whose input citations are both named `S1`:

```ts
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
```

Import `normalizeUserProvidedText` in `tests/commands.test.ts`.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --run tests/commands.test.ts
```

Expected: no `-PROBLEM` citation exists and comparison contains duplicate `S1` IDs.

- [ ] **Step 3: Introduce a claim type in `analysis.ts`**

Replace string-valued analyzed fields with:

```ts
export type AnalyzedClaim = {
  text: string;
  citation?: Citation;
};

export type ProposalAnalysis = {
  problem: AnalyzedClaim;
  requested: AnalyzedClaim;
  impact: AnalyzedClaim;
  feasibility: AnalyzedClaim;
  risks: AnalyzedClaim;
  missingEvidence: string;
};
```

Use one helper for metadata and body sentences:

```ts
function analyzedClaim(
  document: ProposalDocument,
  field: string,
  metadataKeys: string[],
  keywords: string[],
  fallback: string
): AnalyzedClaim {
  const text = pickMetadata(document, metadataKeys) ?? pickSentence(document.body, keywords);
  if (!text) {
    return { text: fallback };
  }
  const url = document.url ?? document.citations[0]?.url;
  if (!url) {
    return { text };
  }
  const prefix = document.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40).toUpperCase() || "SOURCE";
  return {
    text,
    citation: createCitation({
      id: `${prefix}-${field.toUpperCase()}`,
      url,
      title: document.title,
      snippet: text,
      retrievedAt: document.retrievedAt
    })
  };
}
```

Export helpers that commands share:

```ts
export function analysisCitations(analysis: ProposalAnalysis): Citation[] {
  return [analysis.problem, analysis.requested, analysis.impact, analysis.feasibility, analysis.risks]
    .flatMap((claim) => claim.citation ? [claim.citation] : []);
}

export function renderClaim(claim: AnalyzedClaim): string {
  return `${claim.text} ${claim.citation ? `[${claim.citation.id}]` : "[source unavailable]"}`;
}
```

- [ ] **Step 4: Render claim-level citations in `/proposal`**

Use `analysisCitations(analysis)` as the result citations. Replace each raw analysis field with `renderClaim(...)`, and label attacker-controlled prose explicitly:

```ts
`Source-stated problem: ${renderClaim(analysis.problem)}`,
`Source-stated funding/action: ${renderClaim(analysis.requested)}`,
`Source-stated impact: ${renderClaim(analysis.impact)}`,
`Source-stated feasibility: ${renderClaim(analysis.feasibility)}`,
`Source-stated risks: ${renderClaim(analysis.risks)}`,
```

- [ ] **Step 5: Render document-scoped citations in `/compare`**

Build citations from both analyses and use `renderClaim` for each side. Deduplicate by ID before rendering:

```ts
const citations = [...analysisCitations(leftAnalysis), ...analysisCitations(rightAnalysis)]
  .filter((citation, index, all) => all.findIndex((candidate) => candidate.id === citation.id) === index);
```

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/commands.test.ts tests/safety.test.ts
```

Expected: all selected tests pass; late claims cite their own excerpt and comparison IDs are unique.

- [ ] **Step 7: Commit**

```bash
git add packages/cardano-governance-skills/src/commands/analysis.ts packages/cardano-governance-skills/src/commands/proposal.ts packages/cardano-governance-skills/src/commands/compare.ts tests/commands.test.ts tests/safety.test.ts
git commit -m "fix: bind governance claims to supporting citations"
```

### Task 3: Remove the manipulable score and raw first-person interpolation

**Files:**

- Modify: `packages/cardano-governance-skills/src/commands/analysis.ts`
- Modify: `packages/cardano-governance-skills/src/commands/compare.ts`
- Modify: `packages/cardano-governance-skills/src/commands/voteDraft.ts:22-78`
- Test: `tests/commands.test.ts`
- Test: `tests/safety.test.ts`

- [ ] **Step 1: Add failing score and generated-voice tests**

```ts
it("reports evidence signals without a numeric quality score", async () => {
  const noEvidence = "There is no budget, team, milestone, metric, deliverable, evidence, timeline, or risk.";
  const left = normalizeUserProvidedText({ text: noEvidence, title: "No evidence" });
  const right = normalizeUserProvidedText({ text: "Problem: comparison baseline source text is available.", title: "Baseline" });
  const result = await compareCommand("left", "right", {
    enableFixtures: false,
    documents: [{ ...left, id: "left" }, { ...right, id: "right" }]
  });
  expect(result.text).not.toMatch(/Evidence quality:|\/5/);
  expect(result.text).toContain("Evidence signals present:");
});

it("keeps source directives outside generated first-person prose", async () => {
  const result = await voteDraftCommand(
    "Problem: buy ADA now to benefit from this impact. Team timeline is unknown.",
    "support",
    { enableFixtures: false }
  );
  const firstPersonLine = result.text.split("\n").find((line) => line.startsWith("I selected support"));
  expect(firstPersonLine).not.toMatch(/buy ADA/i);
  expect(result.text).toContain("Quoted source claims:");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
npm test -- --run tests/commands.test.ts tests/safety.test.ts
```

- [ ] **Step 3: Replace `evidenceScore` with signal reporting**

```ts
const EVIDENCE_SIGNALS = ["milestone", "budget", "risk", "team", "metric", "deliverable", "evidence", "timeline"] as const;

export function evidenceSignals(document: ProposalDocument): { present: string[]; missing: string[] } {
  const text = `${document.body}\n${JSON.stringify(document.metadata)}`.toLowerCase();
  const present = EVIDENCE_SIGNALS.filter((signal) => text.includes(signal));
  return { present: [...present], missing: EVIDENCE_SIGNALS.filter((signal) => !present.includes(signal)) };
}
```

In `/compare`, render the result as keyword coverage, not quality:

```ts
`Evidence signals present: ${signals.present.join(", ") || "none"}.`,
`Evidence signals missing: ${signals.missing.join(", ") || "none"}.`,
```

- [ ] **Step 4: Use fixed stance prose and quoted claims**

Make `rationaleFor` depend only on `Stance`:

```ts
function rationaleFor(stance: Stance): string {
  if (stance === "support") {
    return "I selected support after reviewing the source-stated problem, impact, feasibility, and risks below.";
  }
  if (stance === "oppose") {
    return "I selected oppose after reviewing the source-stated risks, requested resources, and missing evidence below.";
  }
  return "I selected abstain because the available source evidence does not support a definitive rationale without further review.";
}
```

After that fixed line, render `Quoted source claims:` and bullet lines built with `renderClaim`. Delete `stripTerminalPunctuation` once it has no callers.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/commands.test.ts tests/safety.test.ts
```

- [ ] **Step 6: Run Changeset 1 gate**

```bash
npm test -- --run tests/blockfrost.test.ts tests/router.test.ts tests/commands.test.ts tests/safety.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cardano-governance-skills/src/commands/analysis.ts packages/cardano-governance-skills/src/commands/compare.ts packages/cardano-governance-skills/src/commands/voteDraft.ts tests/commands.test.ts tests/safety.test.ts
git commit -m "fix: keep source text out of generated governance voice"
```

## Changeset 2 — No-custody persistence

### Task 4: Stop raw pasted text from entering durable storage

**Files:**

- Modify: `packages/cardano-governance-skills/src/persistence/fileStore.ts:14-151`
- Test: `tests/persistence.test.ts`

- [ ] **Step 1: Add a failing full-store sentinel test**

```ts
it("never persists raw pasted proposal text", async () => {
  const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
  const sentinel = "REVIEW_SECRET_SENTINEL";
  await routeTelegramCommand(`/proposal ${"Background. ".repeat(40)} password=${sentinel}`, {
    persistenceRoot: root,
    enableFixtures: false,
    now
  });

  const persisted = readdirSync(root, { recursive: true })
    .filter((entry) => typeof entry === "string")
    .map((entry) => {
      const path = join(root, entry);
      return statSync(path).isFile() ? readFileSync(path, "utf8") : "";
    })
    .join("\n");

  expect(persisted).not.toContain(sentinel);
  expect(readdirSync(join(root, "source-cache"))).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --run tests/persistence.test.ts
```

- [ ] **Step 3: Centralize the persistence policy**

Filter pasted documents at the persistence sink:

```ts
function shouldPersistSourceDocument(document: ProposalDocument): boolean {
  return !(document.sourceType === "user-provided" && document.url?.startsWith("user-provided:"));
}
```

Apply it once in `extractDocuments`:

```ts
return [maybe.document, maybe.left, maybe.right]
  .filter(isProposalDocument)
  .filter(shouldPersistSourceDocument);
```

Before writing fetched public documents, redact body, title, recursively nested metadata strings, and citation strings with the existing `redactSensitive` function. Do not mutate the command result object:

```ts
function sanitizeValueForPersistence(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map(sanitizeValueForPersistence);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizeValueForPersistence(nested)]));
  }
  return value;
}

function sanitizeDocumentForPersistence(document: ProposalDocument): ProposalDocument {
  return {
    ...document,
    title: redactSensitive(document.title),
    body: redactSensitive(document.body),
    metadata: sanitizeValueForPersistence(document.metadata) as Record<string, unknown>,
    citations: document.citations.map((citation) => ({
      ...citation,
      url: redactSensitive(citation.url),
      title: citation.title ? redactSensitive(citation.title) : undefined,
      snippet: redactSensitive(citation.snippet)
    }))
  };
}
```

Call it inside `putSourceDocument` before hashing and writing.

- [ ] **Step 4: Preserve fetched-source caching coverage**

Keep the existing fixture-cache test and assert it still writes `Catalyst Reviewer Workbench`. This proves the policy skips pasted text without deleting the public-source provenance feature.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/persistence.test.ts tests/commands.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/cardano-governance-skills/src/persistence/fileStore.ts tests/persistence.test.ts
git commit -m "fix: keep raw pasted sources out of persistence"
```

### Task 5: Bound audit, cache, and proof storage

**Files:**

- Modify: `packages/cardano-governance-skills/src/persistence/fileStore.ts`
- Test: `tests/persistence.test.ts`

- [ ] **Step 1: Add failing injectable-limit tests**

Import `putSourceDocument` and `putProofReceipt`. Define tests around small limits so the suite does not create large files and independently exercises all three stores:

```ts
it("rotates audit logs and prunes oldest cache files", async () => {
  const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
  const limits = { auditBytes: 1_024, sourceFiles: 2, proofFiles: 2 };

  for (let index = 0; index < 4; index += 1) {
    await routeTelegramCommand(`/proposal pasted source ${index} with enough impact and budget evidence`, {
      persistenceRoot: root,
      enableFixtures: false,
      now: new Date(`2026-07-04T00:00:0${index}.000Z`),
      persistenceLimits: limits
    });
    putSourceDocument(root, {
      id: `public-${index}`,
      sourceType: "user-provided",
      url: `https://example.com/proposals/${index}`,
      title: `Public proposal ${index}`,
      body: `Problem: public proposal ${index} has a bounded cache record.`,
      metadata: {},
      citations: [{
        id: `PUBLIC-${index}`,
        url: `https://example.com/proposals/${index}`,
        snippet: `Public proposal ${index}`,
        retrievedAt: `2026-07-04T00:00:0${index}.000Z`
      }],
      retrievedAt: `2026-07-04T00:00:0${index}.000Z`
    }, new Date(`2026-07-04T00:00:0${index}.000Z`).toISOString(), limits);
    putProofReceipt(root, {
      local_id: `proof-${index}`,
      status: "payload-only",
      payload: {
        schema: "vennek.proof.v1",
        content_hash: `sha256:${String(index).padStart(64, "0")}`,
        source_refs: [],
        created_at: `2026-07-04T00:00:0${index}.000Z`,
        agent_version: "test"
      }
    }, new Date(`2026-07-04T00:00:0${index}.000Z`).toISOString(), limits);
  }

  expect(readdirSync(join(root, "source-cache"))).toHaveLength(2);
  expect(readdirSync(join(root, "proof-receipts"))).toHaveLength(2);
  expect(existsSync(join(root, "audit-logs", "commands.jsonl.1"))).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --run tests/persistence.test.ts
```

- [ ] **Step 3: Add limits to the command context**

In `packages/shared/src/types.ts`:

```ts
export type PersistenceLimits = {
  auditBytes: number;
  sourceFiles: number;
  proofFiles: number;
};

// Add to CommandContext:
persistenceLimits?: Partial<PersistenceLimits>;
```

Use fixed production defaults in `fileStore.ts`:

```ts
const DEFAULT_LIMITS: PersistenceLimits = {
  auditBytes: 10 * 1024 * 1024,
  sourceFiles: 500,
  proofFiles: 500
};
```

- [ ] **Step 4: Rotate and prune with Node filesystem APIs**

Resolve partial limits against `DEFAULT_LIMITS` once in `persistCommandResult`, pass the resolved values into `appendJsonLine`, `putSourceDocument`, and `putProofReceipt`, and accept the same optional limits in the two exported write helpers so their focused tests use the production path. Implement:

```ts
function rotateAuditLog(path: string, incomingBytes: number, maxBytes: number): void {
  if (!existsSync(path) || statSync(path).size + incomingBytes <= maxBytes) {
    return;
  }
  const rotated = `${path}.1`;
  rmSync(rotated, { force: true });
  renameSync(path, rotated);
}

function pruneOldestFiles(directory: string, maxFiles: number): void {
  const files = readdirSync(directory)
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  for (const file of files.slice(0, Math.max(0, files.length - maxFiles))) {
    rmSync(join(directory, file.name), { force: true });
  }
}
```

Rotate before append. Write each source/proof record, then prune that directory to its configured maximum. Validate limits as positive integers and throw before writing invalid policy values.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/persistence.test.ts tests/runtimeState.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/cardano-governance-skills/src/persistence/fileStore.ts tests/persistence.test.ts
git commit -m "fix: bound file-backed persistence growth"
```

## Changeset 3 — Telegram pilot controls

### Task 6: Require an explicit pilot chat allowlist

**Files:**

- Create: `apps/telegram-bot/src/accessControl.ts`
- Create: `tests/accessControl.test.ts`
- Modify: `apps/telegram-bot/src/index.ts`
- Modify: `apps/telegram-bot/src/main.ts:14-30`
- Modify: `apps/telegram-bot/src/pollingRuntime.ts:24-94`
- Test: `tests/pollingRuntime.test.ts`

- [ ] **Step 1: Add failing parser and authorization tests**

Create `tests/accessControl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAllowedChatIds } from "@vennek/telegram-bot";

describe("Telegram pilot access control", () => {
  it("parses direct and group chat ids", () => {
    expect([...parseAllowedChatIds("123,-456, 789")]).toEqual(["123", "-456", "789"]);
  });

  it("fails closed on missing or malformed configuration", () => {
    expect(() => parseAllowedChatIds()).toThrow(/VENNEK_TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(() => parseAllowedChatIds("123,abc")).toThrow(/Invalid Telegram chat id/);
  });
});
```

Add a polling test that supplies an update from chat `999`, allows only `123`, and asserts no sent message, no source cache, an advanced offset, and a `telegram_update_rejected` log.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts
```

- [ ] **Step 3: Implement the parser**

Create `accessControl.ts`:

```ts
export function parseAllowedChatIds(value = ""): ReadonlySet<string> {
  const ids = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("VENNEK_TELEGRAM_ALLOWED_CHAT_IDS is required in polling mode.");
  }
  for (const id of ids) {
    if (!/^-?\d+$/.test(id)) {
      throw new Error(`Invalid Telegram chat id: ${id}`);
    }
  }
  return new Set(ids);
}

export function isAllowedChat(chatId: number | string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(String(chatId));
}
```

Export it from `apps/telegram-bot/src/index.ts`.

- [ ] **Step 4: Enforce authorization before routing**

Make `allowedChatIds` required in `PollingOptions`. Immediately after resolving `chatId` and before `routeTelegramText`, reject unauthorized chats, advance/persist the offset, and log only `updateId`, `chatHash`, and `offset`.

Update every direct `runPolling` test call with `allowedChatIds: new Set(["12345"])`.

- [ ] **Step 5: Fail closed at startup**

In `main.ts`, only in `--poll` mode:

```ts
const allowedChatIds = parseAllowedChatIds(process.env.VENNEK_TELEGRAM_ALLOWED_CHAT_IDS);
```

Pass it to `runPolling`. CLI command mode must not parse or require this environment variable.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts tests/router.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/telegram-bot/src/accessControl.ts apps/telegram-bot/src/index.ts apps/telegram-bot/src/main.ts apps/telegram-bot/src/pollingRuntime.ts tests/accessControl.test.ts tests/pollingRuntime.test.ts
git commit -m "fix: restrict polling to approved pilot chats"
```

### Task 7: Add a bounded per-chat rate limiter

**Files:**

- Modify: `apps/telegram-bot/src/accessControl.ts`
- Modify: `apps/telegram-bot/src/pollingRuntime.ts`
- Test: `tests/accessControl.test.ts`
- Test: `tests/pollingRuntime.test.ts`

- [ ] **Step 1: Add failing deterministic limiter tests**

```ts
it("limits a chat within one fixed window and resets afterward", () => {
  const limiter = new FixedWindowRateLimiter(2, 60_000);
  expect(limiter.allow("123", 0)).toBe(true);
  expect(limiter.allow("123", 1)).toBe(true);
  expect(limiter.allow("123", 2)).toBe(false);
  expect(limiter.allow("123", 60_000)).toBe(true);
  expect(limiter.allow("456", 2)).toBe(true);
});
```

Add a polling test using a pre-consumed limiter with limit `1`. Assert routing/persistence is skipped, offset advances, and `telegram_update_rate_limited` is logged.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts
```

- [ ] **Step 3: Implement the limiter without a dependency**

```ts
export type RateLimiter = { allow(chatId: number | string, nowMs?: number): boolean };

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit = 10, private readonly windowMs = 60_000) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error("Rate limit and window must be positive integers.");
    }
  }

  allow(chatId: number | string, nowMs = Date.now()): boolean {
    const key = String(chatId);
    const current = this.windows.get(key);
    if (!current || nowMs - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: nowMs, count: 1 });
      return true;
    }
    if (current.count >= this.limit) {
      return false;
    }
    current.count += 1;
    return true;
  }
}
```

- [ ] **Step 4: Check the limiter before command routing**

Add `rateLimiter?: RateLimiter` to `PollingOptions`, create one default limiter once at `runPolling` startup, and advance/log rejected updates without invoking the router.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/accessControl.ts apps/telegram-bot/src/pollingRuntime.ts tests/accessControl.test.ts tests/pollingRuntime.test.ts
git commit -m "fix: rate limit Telegram pilot commands"
```

### Task 8: Quarantine poison updates after bounded delivery attempts

**Files:**

- Modify: `apps/telegram-bot/src/pollingRuntime.ts:34-157`
- Test: `tests/pollingRuntime.test.ts`

- [ ] **Step 1: Replace the old failure expectation with failing bounded-delivery tests**

Add one permanent-error test and one transient-recovery test:

```ts
it("advances past a permanent delivery failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
  writeTelegramOffset(root, 20, now);
  const api = fakeApi({
    updates: [{ update_id: 20, message: { chat: { id: 12345 }, text: "/sources catalyst-review-workbench" } }],
    sendErrors: [new TelegramApiError(403, "bot was blocked")]
  });
  const logs = captureLogs();

  await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, enableFixtures: true, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

  expect(readTelegramOffset(root)).toBe(21);
  expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned")).toBe(true);
});

it("retries a transient delivery failure without rerunning the command", async () => {
  const api = fakeApi({
    updates: [{ update_id: 30, message: { chat: { id: 12345 }, text: "/proof rationale" } }],
    sendErrors: [new Error("network down"), undefined]
  });
  await runPolling({ api, allowedChatIds: new Set(["12345"]), maxCycles: 1, retryDelayMs: 0 });
  expect(api.sendCalls).toBe(2);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
npm test -- --run tests/pollingRuntime.test.ts
```

- [ ] **Step 3: Preserve Telegram API error status**

Extend `TelegramApiResponse` with `error_code?: number` and add:

```ts
export class TelegramApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TelegramApiError";
  }
}
```

In `telegramCall`, throw `new TelegramApiError(payload.error_code ?? response.status, description)` for failed responses.

- [ ] **Step 4: Add bounded send-only retry logic**

```ts
async function deliverMessage(
  api: TelegramApi,
  params: Parameters<TelegramApi["sendMessage"]>[0],
  retryDelayMs: number,
  signal: AbortSignal | undefined,
  maxAttempts = 3
): Promise<{ delivered: boolean; error?: unknown }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await api.sendMessage(params);
      return { delivered: true };
    } catch (error) {
      lastError = error;
      const permanent = error instanceof TelegramApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (permanent || attempt === maxAttempts) {
        return { delivered: false, error };
      }
      await abortableSleep(retryDelayMs, signal);
    }
  }
  return { delivered: false, error: lastError };
}
```

Route the command once, retry only `sendMessage`, log a sanitized `telegram_delivery_abandoned` event on failure, then advance/persist the offset in both delivered and abandoned cases.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/pollingRuntime.test.ts tests/runtimeState.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/pollingRuntime.ts tests/pollingRuntime.test.ts
git commit -m "fix: quarantine undeliverable Telegram updates"
```

## Changeset 4 — Ingestion and release gates

### Task 9: Enforce the remote byte cap while streaming

**Files:**

- Modify: `packages/cardano-governance-skills/src/adapters/userProvided.ts:5-93`
- Test: `tests/adapters.test.ts`

- [ ] **Step 1: Add failing missing-type and chunked-body tests**

Import `readResponseTextLimited` and add:

```ts
it("rejects a response without an allowed content type", async () => {
  const response = new Response(new TextEncoder().encode("plain source text long enough to normalize"));
  await expect(readResponseTextLimited(response, 1024)).rejects.toThrow(/content-type/i);
});

it("cancels a chunked body immediately above the byte limit", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      canceled = true;
    }
  }), { headers: { "content-type": "text/plain" } });

  await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/too large/i);
  expect(canceled).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
npm test -- --run tests/adapters.test.ts
```

- [ ] **Step 3: Implement a streaming reader**

```ts
export async function readResponseTextLimited(response: Response, maxBytes = MAX_FETCH_BYTES): Promise<string> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`Unsupported or missing content-type: ${contentType ?? "missing"}`);
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Source body too large: ${declared} bytes`);
  }
  if (!response.body) {
    throw new Error("Source response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Source body too large: more than ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
```

Replace the old content-type/content-length/`arrayBuffer` block with this helper.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/adapters.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/cardano-governance-skills/src/adapters/userProvided.ts tests/adapters.test.ts
git commit -m "fix: bound remote source bodies while streaming"
```

### Task 10: Canonicalize and validate optional local documents

**Files:**

- Create: `packages/shared/src/validation.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/cardano-governance-skills/src/store/documentStore.ts:1-69`
- Modify: `packages/cardano-governance-skills/src/persistence/fileStore.ts:107-130`
- Test: `tests/documentStore.test.ts`
- Test: `tests/shared.test.ts`

- [ ] **Step 1: Add failing symlink, size, and schema tests**

```ts
it("rejects a symlink that resolves outside the allowed root", async () => {
  const base = mkdtempSync(join(tmpdir(), "vennek-doc-"));
  const root = join(base, "allowed");
  mkdirSync(root);
  const outside = join(base, "outside.json");
  writeFileSync(outside, JSON.stringify(validDocument("outside")));
  const link = join(root, "link.json");
  symlinkSync(outside, link);
  await expect(resolveProposalDocument(link, { allowLocalFiles: true, allowedFileRoot: root, enableFixtures: false })).rejects.toThrow(/symlink|outside/i);
});

it("rejects malformed local proposal documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "vennek-doc-"));
  const file = join(root, "invalid.json");
  writeFileSync(file, JSON.stringify({ id: "invalid", title: "missing fields" }));
  await expect(resolveProposalDocument(file, { allowLocalFiles: true, allowedFileRoot: root, enableFixtures: false })).rejects.toThrow(/Invalid ProposalDocument/);
});
```

Add a separate oversized file case using `2 * 1024 * 1024 + 1` bytes.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- --run tests/documentStore.test.ts tests/shared.test.ts
```

- [ ] **Step 3: Add the shared type guard**

Create `packages/shared/src/validation.ts`:

```ts
import type { Citation, ProposalDocument } from "./types.js";

function isCitation(value: unknown): value is Citation {
  if (!value || typeof value !== "object") return false;
  const citation = value as Partial<Citation>;
  return typeof citation.id === "string" && typeof citation.url === "string" &&
    typeof citation.snippet === "string" && typeof citation.retrievedAt === "string";
}

export function isProposalDocument(value: unknown): value is ProposalDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<ProposalDocument>;
  return typeof document.id === "string" &&
    (document.sourceType === "catalyst" || document.sourceType === "governance-action" || document.sourceType === "user-provided") &&
    typeof document.title === "string" && typeof document.body === "string" &&
    Boolean(document.metadata && typeof document.metadata === "object" && !Array.isArray(document.metadata)) &&
    Array.isArray(document.citations) && document.citations.every(isCitation) &&
    typeof document.retrievedAt === "string";
}
```

Export it from `packages/shared/src/index.ts`. Import it into `fileStore.ts` and delete that file's private near-duplicate.

- [ ] **Step 4: Enforce canonical containment before reading**

Use `realpathSync`, `lstatSync`, and `statSync`:

```ts
const MAX_LOCAL_SOURCE_BYTES = 2 * 1024 * 1024;

function resolveAllowedLocalPath(path: string, root: string): string {
  const canonicalRoot = realpathSync(root);
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Local file source must not be a symlink.");
  }
  const canonicalPath = realpathSync(path);
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Local file source is outside the allowed file root.");
  }
  const stats = statSync(canonicalPath);
  if (!stats.isFile() || stats.size > MAX_LOCAL_SOURCE_BYTES) {
    throw new Error("Local file source must be a regular file no larger than 2 MiB.");
  }
  return canonicalPath;
}
```

Parse JSON as `unknown`, require `isProposalDocument(parsed)`, and reject arrays for this single-file path.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- --run tests/documentStore.test.ts tests/shared.test.ts tests/persistence.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validation.ts packages/shared/src/index.ts packages/cardano-governance-skills/src/store/documentStore.ts packages/cardano-governance-skills/src/persistence/fileStore.ts tests/documentStore.test.ts tests/shared.test.ts tests/persistence.test.ts
git commit -m "fix: confine and validate local source files"
```

### Task 11: Clear the dependency audit gate

**Files:**

- Modify: `package-lock.json`

- [ ] **Step 1: Capture the failing baseline**

```bash
npm audit --audit-level=moderate
```

Expected: failure naming vulnerable transitive `postcss` and `nanoid` versions under Vite/Vitest.

- [ ] **Step 2: Update only those transitive resolutions**

```bash
npm update postcss nanoid --package-lock-only --ignore-scripts
```

- [ ] **Step 3: Inspect the lockfile diff**

```bash
git diff -- package-lock.json
npm ls postcss nanoid vite vitest
```

Expected: no new direct dependency; only compatible transitive lockfile versions and integrity fields change. If npm changes an unrelated package, restore `package-lock.json` and use `npm install --package-lock-only --ignore-scripts` with the exact existing top-level Vitest range instead.

- [ ] **Step 4: Verify both audit surfaces**

```bash
npm ci --ignore-scripts
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
```

Expected: both audits exit 0 with zero moderate-or-higher vulnerabilities.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json
git commit -m "chore: update vulnerable test toolchain transitive dependencies"
```

### Task 12: Align public contracts and deployment configuration

**Files:**

- Modify: `.env.example`
- Modify: `deploy/vennek.env.example`
- Modify: `README.md`
- Modify: `docs/product/PRD.md`
- Modify: `docs/product/safety-policy.md`
- Modify: `docs/architecture/persistence.md`
- Modify: `docs/deployment/telegram-runtime.md`
- Modify: `docs/deployment/release-checklist.md`
- Modify: `scripts/run-demo.ts`

- [ ] **Step 1: Document the required allowlist configuration**

Add to both environment examples:

```dotenv
# Required in polling mode; comma-separated direct-chat or approved group IDs
VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=
```

Document that polling fails closed without it and that direct CLI mode does not require it.

- [ ] **Step 2: Update the proof contract everywhere**

Replace every optional expected-hash spelling with:

```text
/proof-verify <tx_hash> <expected_content_hash>
```

Update demo/router examples so they always pass a valid SHA-256 value.

- [ ] **Step 3: Document persistence and output guarantees**

State explicitly:

- pasted user text is hash-audited but not source-cached;
- public fetched sources are redacted before caching;
- audit/cache/proof retention is bounded by the application defaults;
- evidence signal lists are keyword coverage, not quality scores;
- source claims are quotations and must have claim-level citations.

- [ ] **Step 4: Update the release checklist**

Add checks for an authorized chat, rejected chat, rate limit, poison-update advancement, and zero audit findings. Keep the live Blockfrost and staging gates explicit.

- [ ] **Step 5: Run documentation consistency searches**

```bash
rg -n '/proof-verify <tx_hash> \[expected_content_hash\]|Evidence quality:|/5 based on|VENNEK_TELEGRAM_ALLOWED_CHAT_IDS' README.md docs .env.example deploy scripts tests packages apps
```

Expected: no old optional-hash or numeric-quality wording; allowlist appears in runtime/deployment docs and examples.

- [ ] **Step 6: Commit**

```bash
git add .env.example deploy/vennek.env.example README.md docs/product/PRD.md docs/product/safety-policy.md docs/architecture/persistence.md docs/deployment/telegram-runtime.md docs/deployment/release-checklist.md scripts/run-demo.ts
git commit -m "docs: publish hardened pilot runtime contracts"
```

## Final assurance gate

### Task 13: Verify the complete remediation and prepare staging rollout

**Files:**

- Review only: all changed files
- Optional generated report update only if the existing npm scripts intentionally write it

- [ ] **Step 1: Inspect the complete change series**

```bash
git log --oneline 62bbcd6..HEAD
git diff 62bbcd6..HEAD --stat
git diff 62bbcd6..HEAD --check
```

Expected: only the files named in this plan changed; no whitespace errors.

- [ ] **Step 2: Run the deterministic repository gate**

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run health
node --import tsx scripts/validate-data-sources.ts --mode sample
node --import tsx scripts/evaluate-citations.ts
node --import tsx scripts/run-demo.ts
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
git diff --check
```

Expected:

- all deterministic tests pass;
- only the credential-gated Blockfrost integration test is skipped;
- typecheck/build/import/health/demo/validation/evaluation pass;
- both audit commands report zero moderate-or-higher vulnerabilities;
- working-tree diff has no whitespace errors.

- [ ] **Step 3: Run an independent ASSURANCE review**

Dispatch the configured `reviewer` after verification. Dispatch `security_reviewer` separately with the final diff, original ten findings, design spec, and verification output. Resolve every substantiated High/Medium finding and send fixes back to the same reviewer for re-review.

- [ ] **Step 4: Re-run the complete gate after review fixes**

Run the exact Step 2 command set again. Do not reuse pre-review results.

- [ ] **Step 5: Execute credential-gated staging checks**

With the staging env loaded and `VENNEK_TELEGRAM_ALLOWED_CHAT_IDS` populated:

```bash
npm test -- --run tests/blockfrost.integration.test.ts
npm run staging:smoke
```

Manually verify one allowed chat, one rejected chat, one rate-limited chat, one valid proof, one invalid proof, and continued processing after an undeliverable update.

- [ ] **Step 6: Record rollout evidence**

Append the tested commit SHA and command results to the release notes section in `docs/deployment/release-checklist.md`. Record no credential values or raw Telegram messages.

- [ ] **Step 7: Commit release evidence if documentation changed**

```bash
git add docs/deployment/release-checklist.md
git commit -m "docs: record hardened pilot verification"
```

Skip this commit only when no release-evidence text was added.
