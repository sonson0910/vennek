# Public Cardano Agent Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the allowlisted command-only Telegram entry point with a public natural-language, queued conversation runtime backed by encrypted PostgreSQL history and a LiteLLM provider gateway.

**Architecture:** Add one focused `@vennek/cardano-agent` package for configuration, storage, secret filtering, model access, and question orchestration. Keep Telegram transport in the existing app, use webhook delivery in production, retain polling for local development, and use pg-boss on the same PostgreSQL database for asynchronous work.

**Tech Stack:** TypeScript, Node.js 22, Vitest, PostgreSQL 16 + pgvector, `pg`, `pg-boss`, LiteLLM proxy, Docker Compose

---

## Scope and Delivery Gate

This plan creates the production-shaped public transport and provider foundation. It intentionally refuses factual Cardano questions until Plan 2 supplies retrieved evidence. Do not expose this phase publicly as a knowledge agent; its deployable acceptance state is credential-gated staging.

### Task 1: Add the Cardano Agent Workspace

**Files:**
- Create: `packages/cardano-agent/package.json`
- Create: `packages/cardano-agent/tsconfig.build.json`
- Create: `packages/cardano-agent/src/index.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Test: `tests/cardanoAgentPackage.test.ts`

- [ ] **Step 1: Write the failing package import test**

```ts
import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE_VERSION } from "@vennek/cardano-agent";

describe("cardano agent package", () => {
  it("exports its package contract", () => {
    expect(AGENT_PACKAGE_VERSION).toBe("1");
  });
});
```

- [ ] **Step 2: Run the test and confirm the package does not resolve**

Run: `npm test -- --run tests/cardanoAgentPackage.test.ts`

Expected: FAIL because `@vennek/cardano-agent` is not present in the TypeScript path map.

- [ ] **Step 3: Create the workspace package**

`packages/cardano-agent/package.json`:

```json
{
  "name": "@vennek/cardano-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "dependencies": {
    "@vennek/cardano-governance-skills": "0.1.0",
    "@vennek/shared": "0.1.0",
    "pg": "^8.16.0",
    "pg-boss": "^12.0.0"
  }
}
```

`packages/cardano-agent/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/cardano-agent/src/index.ts`:

```ts
export const AGENT_PACKAGE_VERSION = "1";
```

Add `@vennek/cardano-agent` to `tsconfig.json` paths. Insert its build before `apps/telegram-bot` in the root `build` script, add it to `verify:imports`, and add `@vennek/cardano-agent: "0.1.0"` to `apps/telegram-bot/package.json` dependencies.

Set the root package runtime contract to Node 22.12 or newer and align Node types:

```json
"engines": { "node": ">=22.12" },
"devDependencies": { "@types/node": "^22.0.0" }
```

- [ ] **Step 4: Install and verify the workspace**

Run: `npm install -D @types/pg@^8.15.0`

Run: `npm test -- --run tests/cardanoAgentPackage.test.ts && npm run typecheck && npm run build && npm run verify:imports`

Expected: the test passes, TypeScript succeeds, and `package imports ok` is printed.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json packages/cardano-agent apps/telegram-bot/package.json tests/cardanoAgentPackage.test.ts
git commit -m "feat: add Cardano agent workspace"
```

### Task 2: Validate Runtime Configuration

**Files:**
- Create: `packages/cardano-agent/src/config.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/agentConfig.test.ts`

- [ ] **Step 1: Write failing configuration tests**

```ts
import { describe, expect, it } from "vitest";
import { parseAgentConfig } from "@vennek/cardano-agent";

const valid = {
  DATABASE_URL: "postgres://vennek:secret@localhost:5432/vennek",
  VENNEK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  LITELLM_BASE_URL: "http://localhost:4000",
  LITELLM_API_KEY: "test-key",
  VENNEK_MODEL_FAST: "cardano-fast",
  VENNEK_MODEL_QUALITY: "cardano-quality",
  VENNEK_MODEL_VERIFIER: "cardano-verifier"
};

describe("agent configuration", () => {
  it("parses the required foundation settings", () => {
    expect(parseAgentConfig(valid).encryptionKey).toHaveLength(32);
  });

  it("rejects a short encryption key", () => {
    expect(() => parseAgentConfig({ ...valid, VENNEK_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
  });

  it("rejects non-http LiteLLM endpoints", () => {
    expect(() => parseAgentConfig({ ...valid, LITELLM_BASE_URL: "file:///tmp/model" })).toThrow(/http/);
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/agentConfig.test.ts`

Expected: FAIL because `parseAgentConfig` is not exported.

- [ ] **Step 3: Implement one strict parser**

```ts
export type AgentConfig = {
  databaseUrl: string;
  encryptionKey: Buffer;
  liteLlmBaseUrl: URL;
  liteLlmApiKey: string;
  models: { fast: string; quality: string; verifier: string };
};

export function parseAgentConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AgentConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const encryptionKey = Buffer.from(required("VENNEK_ENCRYPTION_KEY"), "base64");
  if (encryptionKey.length !== 32) throw new Error("VENNEK_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const liteLlmBaseUrl = new URL(required("LITELLM_BASE_URL"));
  if (!['http:', 'https:'].includes(liteLlmBaseUrl.protocol)) throw new Error("LITELLM_BASE_URL must use http or https.");
  return {
    databaseUrl: required("DATABASE_URL"),
    encryptionKey,
    liteLlmBaseUrl,
    liteLlmApiKey: required("LITELLM_API_KEY"),
    models: {
      fast: required("VENNEK_MODEL_FAST"),
      quality: required("VENNEK_MODEL_QUALITY"),
      verifier: required("VENNEK_MODEL_VERIFIER")
    }
  };
}
```

Export the parser and type from `packages/cardano-agent/src/index.ts`.

- [ ] **Step 4: Verify**

Run: `npm test -- --run tests/agentConfig.test.ts && npm run typecheck`

Expected: all configuration tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cardano-agent/src tests/agentConfig.test.ts
git commit -m "feat: validate agent runtime configuration"
```

### Task 3: Reject Wallet Secrets and Encrypt Conversation Content

**Files:**
- Create: `packages/cardano-agent/src/security/walletSecrets.ts`
- Create: `packages/cardano-agent/src/security/encryption.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/agentSecurity.test.ts`

- [ ] **Step 1: Write failing boundary tests**

```ts
import { describe, expect, it } from "vitest";
import { decryptText, encryptText, findWalletSecret } from "@vennek/cardano-agent";

describe("agent security boundary", () => {
  it("rejects common Cardano signing-key JSON", () => {
    expect(findWalletSecret('{"type":"PaymentSigningKeyShelley_ed25519","cborHex":"5820' + "a".repeat(64) + '"}')).toBe("signing-key");
  });

  it("rejects a 24-word recovery phrase candidate", () => {
    expect(findWalletSecret(Array.from({ length: 24 }, (_, i) => `word${i}`).join(" "))).toBe("recovery-phrase");
  });

  it("round-trips AES-256-GCM without storing plaintext", () => {
    const key = Buffer.alloc(32, 9);
    const encrypted = encryptText("xin chào Cardano", key);
    expect(JSON.stringify(encrypted)).not.toContain("xin chào");
    expect(decryptText(encrypted, key)).toBe("xin chào Cardano");
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/agentSecurity.test.ts`

Expected: FAIL because the boundary functions do not exist.

- [ ] **Step 3: Implement wallet-secret classification**

```ts
export type WalletSecretKind = "signing-key" | "recovery-phrase";

const SIGNING_KEY = /(?:Payment|Stake|DRep|CommitteeCold|CommitteeHot)SigningKey[^\n]{0,256}(?:cborHex|bytes)/i;

export function findWalletSecret(input: string): WalletSecretKind | undefined {
  if (SIGNING_KEY.test(input)) return "signing-key";
  const words = input.trim().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((word) => /^[\p{L}]+\d*$/u.test(word))) {
    return "recovery-phrase";
  }
  return undefined;
}
```

This conservative detector may reject a sentence that looks exactly like a recovery phrase; that false positive is preferable to persisting a wallet secret.

- [ ] **Step 4: Implement authenticated encryption**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedText = { ciphertext: string; iv: string; tag: string };

export function encryptText(value: string, key: Buffer): EncryptedText {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptText(value: EncryptedText, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
```

Export both modules from the package index.

- [ ] **Step 5: Verify**

Run: `npm test -- --run tests/agentSecurity.test.ts && npm run typecheck`

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cardano-agent/src tests/agentSecurity.test.ts
git commit -m "feat: protect stored conversation content"
```

### Task 4: Create PostgreSQL Schema and Conversation Repository

**Files:**
- Create: `packages/cardano-agent/migrations/001_foundation.sql`
- Create: `packages/cardano-agent/src/database.ts`
- Create: `packages/cardano-agent/src/conversations.ts`
- Create: `packages/cardano-agent/src/conversationPartitions.ts`
- Create: `scripts/migrate-agent.ts`
- Create: `docker-compose.yml`
- Modify: `package.json`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/conversations.integration.test.ts`

- [ ] **Step 1: Write a credential-gated integration test**

```ts
import { describe, expect, it } from "vitest";
import { createDatabase, ConversationRepository } from "@vennek/cardano-agent";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("conversation repository", () => {
  it("stores encrypted messages and reads them in order", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    await repository.append({ telegramUserId: "42", telegramChatId: "99", role: "user", text: "Cardano là gì?" });
    expect(await repository.recent("42", 10)).toMatchObject([{ role: "user", text: "Cardano là gì?" }]);
    await db.end();
  });
});
```

- [ ] **Step 2: Add the initial schema**

`001_foundation.sql` must create `schema_migrations`, `telegram_users`, monthly-partition-ready `conversation_messages`, `conversation_summaries`, `telegram_updates`, and `usage_ledger`. Store message text only as `ciphertext`, `iv`, and `auth_tag`; enforce role with `CHECK (role IN ('user','assistant'))`; make `telegram_updates.update_id` the primary key; index `(telegram_user_id, created_at DESC)`.

Use this exact message table shape:

```sql
CREATE TABLE conversation_messages (
  id bigint GENERATED ALWAYS AS IDENTITY,
  telegram_user_id text NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX conversation_messages_user_created_idx
  ON conversation_messages (telegram_user_id, created_at DESC);
```

Remove the first inline `PRIMARY KEY` from `id` when using the composite partition key. In the same migration, create previous/current/next monthly partitions with a PostgreSQL `DO` block using `format('%I', partition_name)` and explicit UTC `timestamptz` bounds. `ensureConversationPartitions(db, now)` creates the current and next two monthly partitions under an advisory lock, independent of the database session timezone. Task 4 exports and verifies this helper; Task 8 wires it into the webhook/worker runtimes and schedules it daily after those runtimes and their pg-boss instance exist.

Create the initial local PostgreSQL service now so the migration test is runnable:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: vennek
      POSTGRES_USER: vennek
      POSTGRES_PASSWORD: vennek
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vennek -d vennek"]
      interval: 2s
      timeout: 2s
      retries: 20
```

- [ ] **Step 3: Implement database creation and a transaction-safe migration runner**

`createDatabase(databaseUrl)` returns a `pg.Pool` with `max: 20`, `connectionTimeoutMillis: 5_000`, and `idleTimeoutMillis: 30_000`. `scripts/migrate-agent.ts` obtains a PostgreSQL advisory lock, applies sorted SQL files not present in `schema_migrations`, records each filename in the same transaction, and releases the client in `finally`.

Add root script:

```json
"migrate:agent": "tsx scripts/migrate-agent.ts"
```

- [ ] **Step 4: Implement the repository**

```ts
export class ConversationRepository {
  constructor(private readonly db: Pool, private readonly key: Buffer) {}

  async append(input: { telegramUserId: string; telegramChatId: string; role: "user" | "assistant"; text: string }): Promise<void> {
    const encrypted = encryptText(input.text, this.key);
    await this.db.query("INSERT INTO telegram_users (telegram_user_id) VALUES ($1) ON CONFLICT DO NOTHING", [input.telegramUserId]);
    await this.db.query(
      `INSERT INTO conversation_messages
       (telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.telegramUserId, input.telegramChatId, input.role, encrypted.ciphertext, encrypted.iv, encrypted.tag]
    );
  }

  async recent(telegramUserId: string, limit: number): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Conversation limit must be between 1 and 50.");
    const result = await this.db.query(
      `SELECT role, ciphertext, iv, auth_tag FROM conversation_messages
       WHERE telegram_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [telegramUserId, limit]
    );
    return result.rows.reverse().map((row) => ({ role: row.role, text: decryptText({ ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag }, this.key) }));
  }
}
```

`append` must reject detected wallet secrets before querying PostgreSQL and write the user/message rows in one transaction. Bind each AES-GCM envelope to an unambiguous versioned AAD value containing the message's composite row identity plus Telegram user, chat, and role so moving ciphertext between rows fails authentication.

- [ ] **Step 5: Run against PostgreSQL**

Run: `docker compose up -d postgres`

Run: `DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm run migrate:agent`

Run: `TEST_DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm test -- --run tests/conversations.integration.test.ts`

Expected: migration succeeds and the integration test passes.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/cardano-agent scripts/migrate-agent.ts tests/conversations.integration.test.ts
git commit -m "feat: persist encrypted agent conversations"
```

### Task 5: Add the LiteLLM Client and Model Profiles

**Files:**
- Create: `packages/cardano-agent/src/llm/liteLlmClient.ts`
- Create: `packages/cardano-agent/src/llm/modelRouter.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/liteLlmClient.test.ts`

- [ ] **Step 1: Write failing HTTP contract tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteLlmClient } from "@vennek/cardano-agent";

afterEach(() => vi.unstubAllGlobals());

describe("LiteLLM client", () => {
  it("uses the OpenAI-compatible chat endpoint without logging prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Cardano answer" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LiteLlmClient(new URL("http://litellm:4000"), "secret");
    await expect(client.complete({ model: "cardano-fast", messages: [{ role: "user", content: "xin chào" }] })).resolves.toMatchObject({ text: "Cardano answer" });
    expect(fetchMock).toHaveBeenCalledWith("http://litellm:4000/v1/chat/completions", expect.objectContaining({ method: "POST" }));
  });

  it("rejects malformed success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    const client = new LiteLlmClient(new URL("http://litellm:4000"), "secret");
    await expect(client.complete({ model: "cardano-fast", messages: [] })).rejects.toThrow(/malformed/i);
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/liteLlmClient.test.ts`

Expected: FAIL because `LiteLlmClient` is not exported.

- [ ] **Step 3: Implement the smallest strict client**

Use native `fetch`, a 45-second `AbortSignal.timeout`, bearer authentication, `content-type` validation, a 2 MiB response limit, `store: false` in the request body, and explicit parsing of `choices[0].message.content`. Return `{ text, promptTokens, completionTokens, model }`. Do not accept a caller-supplied URL and do not log request bodies.

The public method contract is:

```ts
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type CompletionInput = { model: string; messages: ChatMessage[]; temperature?: number };
type CompletionOutput = { text: string; promptTokens: number; completionTokens: number; model: string };
```

- [ ] **Step 4: Implement deterministic profile selection**

```ts
export type ModelProfile = "fast" | "quality" | "verifier";

export function selectModelProfile(input: { sourceCount: number; hasConflicts: boolean; technical: boolean }): ModelProfile {
  return input.hasConflicts || input.technical || input.sourceCount > 6 ? "quality" : "fast";
}
```

Provider fallback remains in LiteLLM configuration, not duplicated in application code.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run tests/liteLlmClient.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/liteLlmClient.test.ts
git commit -m "feat: add multi-provider model gateway"
```

### Task 6: Add a Fail-Closed Natural-Language Question Service

**Files:**
- Create: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/answerQuestion.test.ts`

- [ ] **Step 1: Write failing behavior tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { answerQuestion } from "@vennek/cardano-agent";

describe("natural-language question service", () => {
  it("blocks wallet secrets before persistence or model access", async () => {
    const persist = vi.fn();
    const complete = vi.fn();
    const phrase = Array.from({ length: 24 }, (_, i) => `word${i}`).join(" ");
    const answer = await answerQuestion({ telegramUserId: "1", telegramChatId: "2", text: phrase }, { persist, complete, retrieve: async () => [] });
    expect(answer).toMatch(/không gửi|wallet secret/i);
    expect(persist).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not ask the model for Cardano facts without evidence", async () => {
    const complete = vi.fn();
    const answer = await answerQuestion({ telegramUserId: "1", telegramChatId: "2", text: "Ouroboros hoạt động thế nào?" }, { persist: vi.fn(), complete, retrieve: async () => [] });
    expect(answer).toMatch(/chưa có đủ nguồn/i);
    expect(complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/answerQuestion.test.ts`

Expected: FAIL because `answerQuestion` does not exist.

- [ ] **Step 3: Implement the fail-closed orchestration boundary**

Define injected dependencies for persistence and retrieval so tests never need a network or database. Run `findWalletSecret` before every dependency. Persist the user message only after it passes the secret check. Allow deterministic greetings and the first-use retention notice. Foundation staging has no completion dependency and never calls the model for factual questions, even if a stub retrieval dependency returns items; return the localized insufficient-evidence message. Plan 2 introduces the completion dependency together with the validated evidence contract, grounding, and verification by extending the same function rather than replacing the boundary.

Return this Vietnamese notice on the first accepted interaction:

```text
Vennek lưu lịch sử hội thoại vô thời hạn để duy trì ngữ cảnh; dữ liệu không được dùng để huấn luyện nếu chưa có sự đồng ý riêng. Đừng gửi seed phrase hoặc private key.
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- --run tests/answerQuestion.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/answerQuestion.test.ts
git commit -m "feat: add safe natural-language question boundary"
```

### Task 7: Add Authenticated Telegram Webhooks and Queueing

**Files:**
- Create: `apps/telegram-bot/src/webhookRuntime.ts`
- Create: `apps/telegram-bot/src/agentQueue.ts`
- Modify: `apps/telegram-bot/src/index.ts`
- Test: `tests/webhookRuntime.test.ts`

- [ ] **Step 1: Write failing webhook tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook } from "@vennek/telegram-bot";

const update = { update_id: 77, message: { from: { id: 11 }, chat: { id: 22 }, text: "Cardano là gì?" } };

describe("Telegram webhook", () => {
  it("rejects an invalid secret without enqueueing", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(new Request("https://bot.example/webhook", { method: "POST", body: JSON.stringify(update), headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" } }), { secret: "right", enqueue });
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues a valid text update once and returns immediately", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(new Request("https://bot.example/webhook", { method: "POST", body: JSON.stringify(update), headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "right" } }), { secret: "right", enqueue });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "Cardano là gì?" });
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/webhookRuntime.test.ts`

Expected: FAIL because the webhook handler is missing.

- [ ] **Step 3: Implement strict parsing and idempotent enqueueing**

`handleTelegramWebhook` must accept only POST, compare the exact secret header with `timingSafeEqual`, require JSON, cap the body at 256 KiB, and validate a positive safe-integer `update_id`. For updates carrying `message.text`, require `message.from.id`, `message.chat.id`, and non-empty bounded text. Authenticated updates without a text message are unsupported input and must return 202 without enqueueing so Telegram does not retry them indefinitely. Return 202 for accepted or already-seen updates. It must never log or return the message body.

Implement `PgBossAgentQueue.enqueue()` with job name `telegram-answer`, `singletonKey: String(updateId)`, and three retry attempts with exponential backoff.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- --run tests/webhookRuntime.test.ts && npm run typecheck`

```bash
git add apps/telegram-bot/src tests/webhookRuntime.test.ts
git commit -m "feat: queue authenticated Telegram webhooks"
```

### Task 8: Make Telegram Public and Run the Worker

**Files:**
- Create: `packages/cardano-agent/migrations/001_transport_admission.sql`
- Create: `packages/cardano-agent/migrations/001_worker_idempotency.sql`
- Create: `apps/telegram-bot/src/agentWorker.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `apps/telegram-bot/src/pollingRuntime.ts`
- Modify: `apps/telegram-bot/src/accessControl.ts`
- Modify: `tests/accessControl.test.ts`
- Modify: `tests/pollingRuntime.test.ts`
- Test: `tests/agentWorker.test.ts`

- [ ] **Step 1: Replace allowlist expectations with public-access tests**

Delete tests for `parseAllowedChatIds` and `isAllowedChat`. Add a polling test proving a valid text update routes without `VENNEK_TELEGRAM_ALLOWED_CHAT_IDS`. Keep independent rate-limit tests and all delivery/offset tests.

For the public webhook, retain an immediate database-backed fixed-window admission limit of ten accepted updates per minute for both user and chat. The update claim and admission decision must share the queue transaction so replays do not consume capacity and rejected updates are never queued. The later production admission task extends this baseline with configurable budgets, load shedding, and reservation settlement.

Add this worker test:

```ts
it("answers a queued update once and persists both accepted messages", async () => {
  const answer = vi.fn().mockResolvedValue("Xin chào Cardano");
  const send = vi.fn().mockResolvedValue(undefined);
  await processAgentJob({ updateId: 7, telegramUserId: "1", telegramChatId: "2", text: "xin chào" }, { answer, send });
  expect(answer).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith("2", "Xin chào Cardano");
});
```

Add a second worker test proving a `walletSecretDetected` queue marker sends only the fixed wallet-security warning and never calls the answer service. The original secret text must not exist in the job.

Conversation persistence must be idempotent by Telegram `update_id` and role so a worker retry after a partial persistence failure neither duplicates the user message nor loses the original first-interaction retention notice.

- [ ] **Step 2: Confirm changed expectations fail**

Run: `npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts tests/agentWorker.test.ts`

Expected: FAIL because polling still requires an allowlist and the worker is absent.

- [ ] **Step 3: Remove only the authorization gate**

Delete `parseAllowedChatIds` and `isAllowedChat`. Remove `allowedChatIds` from `PollingOptions`, `main.ts`, and `runPolling`. Keep the fixed-window limiter, sanitized chat hash, offset handling, and send-only retry behavior unchanged.

- [ ] **Step 4: Implement the worker and runtime modes**

`processAgentJob` calls the injected answer service once and the existing Telegram delivery path once. A wallet-secret marker bypasses the answer/persistence/provider path and sends only the fixed security warning. `--worker` starts pg-boss work for `telegram-answer`. `--webhook` starts a Node HTTP server whose only application route is `POST /telegram/webhook`; `--poll` remains available for local development and routes the same question service synchronously. Polling must require the full agent configuration and must never fall back to the legacy command router. Production webhook startup must create its handler options through `createWebhookOptions` so secret-strength validation cannot be bypassed.

Webhook and worker startup must call `ensureConversationPartitions` before accepting work. The worker's pg-boss instance must also schedule it as a daily maintenance job so future monthly partitions are created automatically.

Required environment values in webhook/worker mode are `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and all values parsed by `parseAgentConfig`. Health mode must not require external credentials.

- [ ] **Step 5: Verify the transport suite**

Run: `npm test -- --run tests/accessControl.test.ts tests/pollingRuntime.test.ts tests/webhookRuntime.test.ts tests/agentWorker.test.ts`

Expected: all transport tests pass and no test requires an allowlist.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src tests/accessControl.test.ts tests/pollingRuntime.test.ts tests/agentWorker.test.ts
git commit -m "feat: open Telegram agent access"
```

### Task 9: Add Portable Local Infrastructure and Staging Documentation

**Files:**
- Modify: `docker-compose.yml`
- Create: `config/litellm.example.yaml`
- Create: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/deployment/telegram-runtime.md`
- Modify: `docs/deployment/release-checklist.md`

- [ ] **Step 1: Add Docker Compose services**

Extend the existing PostgreSQL compose file with a pinned LiteLLM image plus `telegram-webhook` and `agent-worker` application services built from the same repository image. Application services wait for healthy PostgreSQL and successful migration. Do not put real provider keys or Telegram tokens in the compose file.

Staging must separate the migration owner from the application DML role. Expose partition maintenance through a narrowly scoped migration-owned operation with a pinned `search_path`; grant the application role only the minimum DML and maintenance execution privileges, never general `CREATE` privileges.

`config/litellm.example.yaml` defines these aliases with provider deployments supplied through environment variables:

```yaml
model_list:
  - model_name: cardano-fast
    litellm_params:
      model: os.environ/OPENAI_FAST_MODEL
      api_key: os.environ/OPENAI_API_KEY
  - model_name: cardano-fast
    litellm_params:
      model: os.environ/ANTHROPIC_FAST_MODEL
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: cardano-fast
    litellm_params:
      model: os.environ/GEMINI_FAST_MODEL
      api_key: os.environ/GEMINI_API_KEY
  - model_name: cardano-quality
    litellm_params:
      model: os.environ/OPENAI_QUALITY_MODEL
      api_key: os.environ/OPENAI_API_KEY
  - model_name: cardano-quality
    litellm_params:
      model: os.environ/ANTHROPIC_QUALITY_MODEL
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: cardano-quality
    litellm_params:
      model: os.environ/GEMINI_QUALITY_MODEL
      api_key: os.environ/GEMINI_API_KEY
  - model_name: cardano-verifier
    litellm_params:
      model: os.environ/OPENAI_VERIFIER_MODEL
      api_key: os.environ/OPENAI_API_KEY
  - model_name: cardano-verifier
    litellm_params:
      model: os.environ/ANTHROPIC_VERIFIER_MODEL
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: cardano-verifier
    litellm_params:
      model: os.environ/GEMINI_VERIFIER_MODEL
      api_key: os.environ/GEMINI_API_KEY
router_settings:
  num_retries: 1
  allowed_fails: 2
  routing_strategy: least-busy
litellm_settings:
  drop_params: true
```

- [ ] **Step 2: Document exact staging commands**

Document key generation without printing the key:

```bash
umask 077
openssl rand -base64 32 > /secure/path/vennek-encryption-key
```

Document migration, webhook registration, worker start, health check, and rollback. State explicitly that foundation staging refuses factual Cardano answers until the knowledge plan is complete.

- [ ] **Step 3: Run foundation verification**

Run:

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm audit --audit-level=moderate
git diff --check
```

Expected: all existing and new tests pass, one credential-gated Blockfrost integration test may remain skipped, audit reports zero moderate-or-higher vulnerabilities, and diff check is clean.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml config/litellm.example.yaml .env.example .gitignore README.md docs/deployment package-lock.json
git commit -m "docs: add public agent staging runtime"
```
