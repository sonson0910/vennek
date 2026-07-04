import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CitationEvalCase = {
  id: string;
  claim: string;
  citationSnippet: string;
  expectedSupported: boolean;
};

type CitationEvalResult = CitationEvalCase & {
  predictedSupported: boolean;
  score: number;
  ok: boolean;
  reason: string;
};

type CitationEvalReport = {
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  pass: boolean;
  threshold: number;
  results: CitationEvalResult[];
};

const args = process.argv.slice(2);
const inputPath = resolve(process.cwd(), readOption("--file") ?? "samples/citation-eval-fixtures.json");
const outputPath = resolve(process.cwd(), readOption("--output") ?? "samples/citation-eval-results.json");
const writeReport = args.includes("--write-report");
const threshold = Number(readOption("--threshold") ?? "0.9");

const cases = JSON.parse(readFileSync(inputPath, "utf8")) as CitationEvalCase[];
const results = cases.map(evaluateCase);
const passed = results.filter((result) => result.ok).length;
const report: CitationEvalReport = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.length - passed,
  accuracy: results.length === 0 ? 0 : passed / results.length,
  pass: results.length > 0 && passed / results.length >= threshold,
  threshold,
  results
};

console.log(`Citation eval: ${report.passed}/${report.total} passed (${Math.round(report.accuracy * 100)}%), threshold ${Math.round(threshold * 100)}%.`);
if (writeReport) {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (!report.pass) {
  process.exitCode = 1;
}

export function evaluateCase(testCase: CitationEvalCase): CitationEvalResult {
  const claimTokens = importantTokens(testCase.claim);
  const snippetTokens = new Set(importantTokens(testCase.citationSnippet));
  const overlap = claimTokens.filter((token) => snippetTokens.has(token)).length;
  const score = claimTokens.length === 0 ? 0 : overlap / claimTokens.length;
  const contradiction = hasContradiction(testCase.claim, testCase.citationSnippet);
  const predictedSupported = score >= 0.4 && !contradiction;
  const ok = predictedSupported === testCase.expectedSupported;
  return {
    ...testCase,
    predictedSupported,
    score,
    ok,
    reason: ok
      ? "Prediction matched expected support label."
      : `Prediction mismatch: score=${score.toFixed(2)}, contradiction=${contradiction}.`
  };
}

function readOption(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function importantTokens(value: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "to", "of", "for", "with", "after", "already", "has", "have", "is", "are", "be", "must", "not", "only", "can", "into", "by", "on", "in", "it", "this", "that"
  ]);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function hasContradiction(claim: string, snippet: string): boolean {
  const normalizedClaim = claim.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  return (
    /automatically|auto|signs|submits/.test(normalizedClaim) && /does not sign|does not submit|payload only/.test(normalizedSnippet)
  );
}
