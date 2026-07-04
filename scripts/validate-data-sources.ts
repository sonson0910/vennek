import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasUsableCitations, type ProposalDocument, type SourceType, type SourceValidationResult } from "@vennek/shared";
import { resolveProposalDocument } from "@vennek/cardano-governance-skills";

type ValidationReport = {
  mode: "sample" | "live";
  generatedAt: string;
  total: number;
  normalized: number;
  withCitations: number;
  failed: number;
  sourceTypeCounts: Record<SourceType, number>;
  pass: boolean;
  results: ValidationResult[];
  note: string;
};

type ValidationResult = SourceValidationResult & {
  input?: string;
  reason?: string;
};

const args = process.argv.slice(2);
const mode = readOption("--mode") ?? "sample";
const writeReport = args.includes("--write-report");
const outputPath = resolve(process.cwd(), readOption("--output") ?? "samples/proposals/validation-results.json");

if (mode !== "sample" && mode !== "live") {
  throw new Error(`Unsupported --mode "${mode}". Use "sample" or "live".`);
}

const report = mode === "live" ? await runLiveValidation() : runSampleValidation();
console.log(`Validated ${report.total} ${report.mode} sources: ${report.normalized} normalized, ${report.withCitations} with citations, ${report.failed} failed with reasons.`);
if (writeReport) {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (!report.pass) {
  console.error(report.note);
  process.exitCode = 1;
}

function readOption(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function runSampleValidation(): ValidationReport {
  const fixturePath = resolve(process.cwd(), "samples/proposals/validation-fixtures.json");
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as ProposalDocument[];
  const results = fixtures.map((document) => validateDocument(document));
  const summary = summarize(results);

  return {
    mode: "sample",
    generatedAt: new Date().toISOString(),
    ...summary,
    pass: results.length >= 20 && summary.normalized >= 15 && results.every((result) => result.ok || result.reason),
    results,
    note: "Sample-mode validation is deterministic and offline. It proves the normalization contract, not live Catalyst/GovTool availability."
  };
}

async function runLiveValidation(): Promise<ValidationReport> {
  const filePath = resolve(process.cwd(), readOption("--file") ?? "samples/proposals/live-sources.txt");
  const entries = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const results: ValidationResult[] = [];
  for (const input of entries) {
    results.push(await validateLiveInput(input));
  }

  const summary = summarize(results);
  const enoughEntries = results.length >= 20;
  const enoughNormalized = summary.normalized >= 15;
  const hasCatalyst = summary.sourceTypeCounts.catalyst > 0;
  const hasGovernanceAction = summary.sourceTypeCounts["governance-action"] > 0;
  const hasUserProvided = summary.sourceTypeCounts["user-provided"] > 0;
  const hasExpectedFailure = summary.failed > 0;

  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    ...summary,
    pass:
      enoughEntries &&
      enoughNormalized &&
      hasCatalyst &&
      hasGovernanceAction &&
      hasUserProvided &&
      hasExpectedFailure &&
      results.every((result) => result.ok || result.reason),
    results,
    note: enoughEntries
      ? `Live validation requires >=20 entries, >=15 normalized, Catalyst + governance-action + user-provided coverage, and at least one expected failure with a reason. Source file: ${filePath}`
      : `Live validation requires at least 20 real URL/text entries in ${filePath}; found ${results.length}. No sources were fabricated.`
  };
}

async function validateLiveInput(input: string): Promise<ValidationResult> {
  try {
    const document = await resolveProposalDocument(input, { enableFixtures: false, allowLocalFiles: false });
    const result = validateDocument(document);
    return {
      ...result,
      input,
      reason: result.ok ? "Normalized with usable citation data." : result.reason
    };
  } catch (error) {
    return {
      id: input.slice(0, 120),
      sourceType: inferFailedSourceType(input),
      url: isUrl(input) ? input : undefined,
      ok: false,
      citationCount: 0,
      input,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function validateDocument(document: ProposalDocument): ValidationResult {
  const missingFields = [
    ["id", document.id],
    ["title", document.title],
    ["body", document.body],
    ["retrievedAt", document.retrievedAt]
  ]
    .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
    .map(([key]) => key);

  const citationCount = hasUsableCitations(document.citations) ? document.citations.length : 0;
  const ok = missingFields.length === 0 && citationCount > 0;

  return {
    id: document.id,
    sourceType: document.sourceType,
    url: document.url,
    ok,
    citationCount,
    normalizedId: ok ? document.id : undefined,
    reason: ok ? undefined : `Missing or weak fields: ${missingFields.join(", ") || "citations"}`
  };
}

function summarize(results: ValidationResult[]): Pick<ValidationReport, "total" | "normalized" | "withCitations" | "failed" | "sourceTypeCounts"> {
  const sourceTypeCounts: Record<SourceType, number> = {
    catalyst: 0,
    "governance-action": 0,
    "user-provided": 0
  };
  for (const result of results) {
    if (result.ok) {
      sourceTypeCounts[result.sourceType] += 1;
    }
  }
  return {
    total: results.length,
    normalized: results.filter((result) => result.ok).length,
    withCitations: results.filter((result) => result.citationCount > 0).length,
    failed: results.filter((result) => !result.ok).length,
    sourceTypeCounts
  };
}

function inferFailedSourceType(value: string): SourceType {
  if (/gov\.tools|govtool|intersectmbo/i.test(value)) {
    return "governance-action";
  }
  if (/projectcatalyst|ideascale/i.test(value)) {
    return "catalyst";
  }
  return "user-provided";
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
