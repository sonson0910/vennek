import { hasUsableCitations, type CommandResult } from "@vennek/shared";

const HUMAN_DECISION_FRAME = "Draft analysis; human decides.";

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\byou should vote\b/i,
  /\bmust vote\b/i,
  /\bvote yes\b/i,
  /\bvote no\b/i,
  /\bdefinitely support\b/i,
  /\bdefinitely oppose\b/i,
  /\bguaranteed\b/i,
  /\bnot financial advice but\b/i,
  /\bseed phrase\b/i,
  /\bprivate key\b/i,
  /\bwallet connector\b/i,
  /\bconnect your wallet\b/i,
  /\bsubmit (a )?transaction for you\b/i,
  /\bsend funds\b/i,
  /\btrading advice\b/i,
  /\binvestment advice\b/i,
  /\bsign(ed|ing)? automatically\b/i,
  /\bauto-?sign\b/i,
  /\bauto-?vote\b/i
];

export function validateOutput(result: CommandResult): string[] {
  const errors: string[] = [];

  if (!result.text.includes(HUMAN_DECISION_FRAME)) {
    errors.push(`Missing required human decision frame: "${HUMAN_DECISION_FRAME}"`);
  }

  if (!hasUsableCitations(result.citations)) {
    const explicitUnavailable =
      result.sourceStatus === "unavailable" && /source unavailable/i.test(result.text);
    if (!explicitUnavailable) {
      errors.push("Sourced command must include citations or explicit source-unavailable status.");
    }
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(result.text)) {
      errors.push(`Unsafe or recommendation-like phrase matched ${pattern.toString()}`);
    }
  }

  return errors;
}

export function assertSafeOutput(result: CommandResult): CommandResult {
  const errors = validateOutput(result);
  if (errors.length > 0) {
    throw new Error(`Unsafe command output:\n${errors.join("\n")}`);
  }

  return result;
}

export function humanDecisionFrame(): string {
  return HUMAN_DECISION_FRAME;
}
