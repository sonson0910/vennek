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

  const generatedText = result.command === "vote-draft"
    ? generatedVoteDraftText(result.text, errors)
    : result.text;

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(generatedText)) {
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

function generatedVoteDraftText(text: string, errors: string[]): string {
  const lines = text.split("\n");
  const rationale = markerIndex(lines, "Draft rationale:");
  const quotedClaims = markerIndex(lines, "Quoted source claims:");
  const caveats = markerIndex(lines, "Caveats to preserve:");
  const citations = markerIndex(lines, "Citations:");
  const selected = lines.reduce<number[]>((indexes, line, index) => {
    if (/^I selected (support|oppose|abstain)\b/.test(line)) {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (
    rationale.length !== 1 ||
    quotedClaims.length !== 1 ||
    caveats.length !== 1 ||
    citations.length !== 1 ||
    selected.length !== 1 ||
    !(rationale[0] < selected[0] && selected[0] < quotedClaims[0] && quotedClaims[0] < caveats[0] && caveats[0] < citations[0])
  ) {
    errors.push("Malformed vote-draft generated/quoted section boundaries.");
    return text;
  }

  const quoteLines = lines.slice(quotedClaims[0] + 1, caveats[0]);
  const nonEmptyQuoteLines = quoteLines.filter((line) => line.trim().length > 0);
  if (nonEmptyQuoteLines.length === 0 || nonEmptyQuoteLines.some((line) => !line.startsWith("- "))) {
    errors.push("Malformed vote-draft quoted source claims section.");
    return text;
  }

  return [
    ...lines.slice(0, quotedClaims[0]),
    ...lines.slice(caveats[0], citations[0])
  ].join("\n");
}

function markerIndex(lines: string[], marker: string): number[] {
  return lines.reduce<number[]>((indexes, line, index) => {
    if (line === marker) {
      indexes.push(index);
    }
    return indexes;
  }, []);
}
