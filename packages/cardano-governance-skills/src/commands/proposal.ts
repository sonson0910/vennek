import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analysisCitations, analyzeDocument, cite, renderClaim, renderCitations } from "./analysis.js";

export async function proposalCommand(input: string, context: CommandContext = {}): Promise<CommandResult> {
  const document = await resolveProposalDocument(input, context);
  const analysis = analyzeDocument(document);
  const citations = analysisCitations(analysis);
  const sourceStatus = sourceStatusFor(document.citations);
  const citationHint = cite(citations);
  const sourceNote = hasUsableCitations(document.citations)
    ? `Evidence anchors: ${citationHint}`
    : "Source unavailable: no retrievable citation snippets were attached.";

  const text = [
    humanDecisionFrame(),
    "This is draft analysis, not financial advice and not a vote recommendation.",
    "",
    `Proposal: ${document.title}`,
    `Source status: ${sourceStatus}`,
    sourceNote,
    "",
    `Source-stated problem: ${renderClaim(analysis.problem)}`,
    `Source-stated funding/action: ${renderClaim(analysis.requested)}`,
    `Source-stated impact: ${renderClaim(analysis.impact)}`,
    `Source-stated feasibility: ${renderClaim(analysis.feasibility)}`,
    `Source-stated risks: ${renderClaim(analysis.risks)}`,
    `Missing evidence to verify: ${analysis.missingEvidence}`,
    "",
    "Citations:",
    renderCitations(citations)
  ].join("\n");

  return assertSafeOutput({
    command: "proposal",
    ok: true,
    text,
    citations,
    sourceStatus,
    warnings: [],
    data: { document, analysis }
  });
}
