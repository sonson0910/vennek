import { hasUsableCitations, type CommandContext, type CommandResult } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analyzeDocument, cite, evidenceScore, renderCitations } from "./analysis.js";

export async function compareCommand(leftInput: string, rightInput: string, context: CommandContext = {}): Promise<CommandResult> {
  const left = await resolveProposalDocument(leftInput, context);
  const right = await resolveProposalDocument(rightInput, context);
  const leftAnalysis = analyzeDocument(left);
  const rightAnalysis = analyzeDocument(right);
  const citations = [...left.citations, ...right.citations];
  const sourceStatus = hasUsableCitations(left.citations) && hasUsableCitations(right.citations) ? "available" : "partial";

  const text = [
    humanDecisionFrame(),
    "This comparison uses a fixed rubric and does not choose a vote stance.",
    "",
    `Compare: ${left.title} vs ${right.title}`,
    `Source status: ${sourceStatus}`,
    "",
    `Impact:`,
    `- ${left.id}: ${leftAnalysis.impact} ${cite(left.citations, 1)}`,
    `- ${right.id}: ${rightAnalysis.impact} ${cite(right.citations, 1)}`,
    "",
    `Feasibility:`,
    `- ${left.id}: ${leftAnalysis.feasibility} ${cite(left.citations, 1)}`,
    `- ${right.id}: ${rightAnalysis.feasibility} ${cite(right.citations, 1)}`,
    "",
    `Budget/resources:`,
    `- ${left.id}: ${leftAnalysis.requested} ${cite(left.citations, 1)}`,
    `- ${right.id}: ${rightAnalysis.requested} ${cite(right.citations, 1)}`,
    "",
    `Evidence quality:`,
    `- ${left.id}: ${evidenceScore(left)}/5 based on explicit budget/team/milestone/risk/metric signals. ${cite(left.citations, 1)}`,
    `- ${right.id}: ${evidenceScore(right)}/5 based on explicit budget/team/milestone/risk/metric signals. ${cite(right.citations, 1)}`,
    "",
    `Risk:`,
    `- ${left.id}: ${leftAnalysis.risks} ${cite(left.citations, 1)}`,
    `- ${right.id}: ${rightAnalysis.risks} ${cite(right.citations, 1)}`,
    "",
    "Reviewer notes: compare the evidence, assumptions, and fit to your mandate before deciding.",
    "",
    "Citations:",
    renderCitations(citations)
  ].join("\n");

  return assertSafeOutput({
    command: "compare",
    ok: true,
    text,
    citations,
    sourceStatus,
    warnings: [],
    data: { left, right, leftAnalysis, rightAnalysis }
  });
}
