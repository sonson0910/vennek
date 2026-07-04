import { verifyProofTxWithBlockfrost } from "@vennek/cardano-governance-skills";

type Check = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
};

const checks: Check[] = [];

async function main(): Promise<void> {
  checks.push(checkDataDir());
  checks.push(await checkTelegramToken());
  checks.push(await checkBlockfrostProject());
  checks.push(await checkBlockfrostProofFixture());

  for (const check of checks) {
    const status = check.skipped ? "SKIP" : check.ok ? "PASS" : "FAIL";
    const suffix = check.reason ? ` - ${check.reason}` : "";
    console.log(`${status} ${check.name}${suffix}`);
    if (check.detail) {
      console.log(JSON.stringify(check.detail));
    }
  }

  const failed = checks.some((check) => !check.ok && !check.skipped);
  process.exitCode = failed ? 1 : 0;
}

function checkDataDir(): Check {
  const dataDir = process.env.VENNEK_DATA_DIR;
  if (!dataDir) {
    return { name: "VENNEK_DATA_DIR", ok: false, reason: "VENNEK_DATA_DIR is required for staging persistence." };
  }
  return { name: "VENNEK_DATA_DIR", ok: true, detail: { configured: true } };
}

async function checkTelegramToken(): Promise<Check> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { name: "telegram.getMe", ok: false, reason: "TELEGRAM_BOT_TOKEN is required for real Telegram staging." };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: "POST" });
    const payload = (await response.json()) as { ok?: boolean; result?: { username?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean }; description?: string };
    if (!response.ok || !payload.ok || !payload.result) {
      return { name: "telegram.getMe", ok: false, reason: sanitize(payload.description ?? `Telegram getMe failed with HTTP ${response.status}`, token) };
    }
    return {
      name: "telegram.getMe",
      ok: true,
      detail: {
        username: payload.result.username,
        canJoinGroups: payload.result.can_join_groups,
        canReadAllGroupMessages: payload.result.can_read_all_group_messages
      }
    };
  } catch (error) {
    return { name: "telegram.getMe", ok: false, reason: sanitize(error instanceof Error ? error.message : String(error), token) };
  }
}

async function checkBlockfrostProject(): Promise<Check> {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) {
    return { name: "blockfrost.latestBlock", ok: false, reason: "BLOCKFROST_PROJECT_ID is required for real Blockfrost staging." };
  }

  const network = parseNetwork(process.env.BLOCKFROST_NETWORK) ?? "mainnet";
  const baseUrl = network === "mainnet" ? "https://cardano-mainnet.blockfrost.io/api/v0" : `https://cardano-${network}.blockfrost.io/api/v0`;
  try {
    const response = await fetch(`${baseUrl}/blocks/latest`, { headers: { project_id: projectId } });
    const payload = (await response.json()) as { hash?: string; height?: number; status_code?: number; message?: string };
    if (!response.ok || !payload.hash) {
      return { name: "blockfrost.latestBlock", ok: false, reason: sanitize(payload.message ?? `Blockfrost latest block failed with HTTP ${response.status}`, projectId) };
    }
    return { name: "blockfrost.latestBlock", ok: true, detail: { network, latestBlockHashPrefix: payload.hash.slice(0, 12), height: payload.height } };
  } catch (error) {
    return { name: "blockfrost.latestBlock", ok: false, reason: sanitize(error instanceof Error ? error.message : String(error), projectId) };
  }
}

async function checkBlockfrostProofFixture(): Promise<Check> {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const txHash = process.env.BLOCKFROST_TEST_TX_HASH;
  const contentHash = process.env.BLOCKFROST_TEST_CONTENT_HASH;
  if (!projectId || !txHash || !contentHash) {
    return { name: "blockfrost.proofFixture", ok: true, skipped: true, reason: "BLOCKFROST_PROJECT_ID, BLOCKFROST_TEST_TX_HASH, and BLOCKFROST_TEST_CONTENT_HASH are required for proof fixture verification." };
  }

  const result = await verifyProofTxWithBlockfrost({
    txHash,
    expectedContentHash: contentHash,
    options: {
      projectId,
      network: parseNetwork(process.env.BLOCKFROST_NETWORK)
    }
  });

  if (!result.ok) {
    return { name: "blockfrost.proofFixture", ok: false, reason: sanitize(result.reason ?? result.status, projectId) };
  }
  return { name: "blockfrost.proofFixture", ok: true, detail: { status: result.status, matchedPayload: Boolean(result.matchedPayload) } };
}

function parseNetwork(value: string | undefined): "mainnet" | "preprod" | "preview" | undefined {
  return value === "mainnet" || value === "preprod" || value === "preview" ? value : undefined;
}

function sanitize(value: string, secret: string): string {
  return value.replaceAll(secret, "[redacted]");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
