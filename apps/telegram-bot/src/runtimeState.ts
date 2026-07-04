import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RuntimeState = {
  telegramOffset: number;
  updatedAt: string;
};

export function stateFilePath(root: string): string {
  return join(resolve(root), "runtime", "telegram-state.json");
}

export function readTelegramOffset(root?: string): number {
  if (!root) {
    return 0;
  }

  const path = stateFilePath(root);
  if (!existsSync(path)) {
    return 0;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeState>;
  const offset = parsed.telegramOffset;
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

export function writeTelegramOffset(root: string | undefined, offset: number, now = new Date()): void {
  if (!root) {
    return;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid Telegram offset: ${offset}`);
  }

  const path = stateFilePath(root);
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ telegramOffset: offset, updatedAt: now.toISOString() }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

export function validateRuntimeState(root?: string): { ok: true; offset: number } {
  const offset = readTelegramOffset(root);
  if (root) {
    ensurePrivateDirectory(dirname(stateFilePath(root)));
  }
  return { ok: true, offset };
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
