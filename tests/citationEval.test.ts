import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("citation eval script", () => {
  it("passes mixed positive and negative citation support fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "vennek-citation-eval-"));
    const input = join(dir, "fixtures.json");
    const output = join(dir, "results.json");
    writeFileSync(input, JSON.stringify([
      {
        id: "support",
        claim: "Reviewers need cited proposal summaries.",
        citationSnippet: "Problem: reviewers need cited proposal summaries.",
        expectedSupported: true
      },
      {
        id: "contradict",
        claim: "The bot automatically signs Cardano transactions.",
        citationSnippet: "Vennek does not sign or submit transactions.",
        expectedSupported: false
      }
    ]));

    execFileSync("npx", ["tsx", "scripts/evaluate-citations.ts", "--file", input, "--output", output, "--write-report"], {
      cwd: process.cwd(),
      stdio: "pipe"
    });

    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.pass).toBe(true);
    expect(report.passed).toBe(2);
  });
});
