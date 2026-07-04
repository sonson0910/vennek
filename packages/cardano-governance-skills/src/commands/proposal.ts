import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analyzeDocument, cite, renderCitations } from "./analysis.js";

export async function proposalCommand(input: string, context: CommandContext = {}): Promise<CommandResult> {
  const document = await resolveProposalDocument(input, context);
  const analysis = analyzeDocument(document);
  const citations = document.citations;
  const sourceStatus = sourceStatusFor(citations);
  const citationHint = cite(citations);
  const sourceNote = hasUsableCitations(citations)
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
    `Problem: ${analysis.problem} ${citationHint}`,
    `Requested funding/action: ${analysis.requested} ${citationHint}`,
    `Impact claims: ${analysis.impact} ${citationHint}`,
    `Feasibility: ${analysis.feasibility} ${citationHint}`,
    `Risks: ${analysis.risks} ${citationHint}`,
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
