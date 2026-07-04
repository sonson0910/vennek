import { createProofPayload } from "@vennek/cardano-governance-skills";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const text = process.argv.slice(2).join(" ").trim() || "Vennek staging proof fixture for Cardano governance copilot. Human decides.";
const now = process.env.VENNEK_PROOF_FIXTURE_NOW ? new Date(process.env.VENNEK_PROOF_FIXTURE_NOW) : new Date();
const receipt = createProofPayload({
  text,
  sourceRefs: ["https://t.me/cardano_claw_bot"],
  reportId: "vennek-staging-proof-fixture",
  now
});

const outDir = "samples/proof-fixtures";
mkdirSync(outDir, { recursive: true });
const path = join(outDir, "vennek-proof-fixture.json");
writeFileSync(path, JSON.stringify({ text, receipt }, null, 2));

console.log(`Wrote ${path}`);
console.log(`content_hash=${receipt.payload.content_hash}`);
console.log("metadata_payload=");
console.log(JSON.stringify(receipt.payload, null, 2));
