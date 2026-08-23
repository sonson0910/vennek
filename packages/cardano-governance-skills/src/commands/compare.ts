import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analysisCitations, analyzeDocument, evidenceScore, renderClaim, renderCitations } from "./analysis.js";

export async function compareCommand(leftInput: string, rightInput: string, context: CommandContext = {}): Promise<CommandResult> {
  const left = await resolveProposalDocument(leftInput, context);
  const right = await resolveProposalDocument(rightInput, context);
  const leftAnalysis = analyzeDocument(left);
  const rightAnalysis = analyzeDocument(right);
  const leftCitations = analysisCitations(leftAnalysis);
  const rightCitations = analysisCitations(rightAnalysis);
  const citations = [...leftCitations, ...rightCitations]
    .filter((citation, index, all) => all.findIndex((candidate) => candidate.id === citation.id) === index);
  const sourceStatus = sourceStatusFor(citations, hasUsableCitations(leftCitations) && hasUsableCitations(rightCitations) ? "available" : "partial");

  const text = [
    humanDecisionFrame(),
    "This comparison uses a fixed rubric and does not choose a vote stance.",
    "",
    `Compare: ${left.title} vs ${right.title}`,
    `Source status: ${sourceStatus}`,
    "",
    `Impact:`,
    `- ${left.id}: ${renderClaim(leftAnalysis.impact)}`,
    `- ${right.id}: ${renderClaim(rightAnalysis.impact)}`,
    "",
    `Feasibility:`,
    `- ${left.id}: ${renderClaim(leftAnalysis.feasibility)}`,
    `- ${right.id}: ${renderClaim(rightAnalysis.feasibility)}`,
    "",
    `Budget/resources:`,
    `- ${left.id}: ${renderClaim(leftAnalysis.requested)}`,
    `- ${right.id}: ${renderClaim(rightAnalysis.requested)}`,
    "",
    `Evidence quality:`,
    `- ${left.id}: ${evidenceScore(left)}/5 based on explicit budget/team/milestone/risk/metric signals.`,
    `- ${right.id}: ${evidenceScore(right)}/5 based on explicit budget/team/milestone/risk/metric signals.`,
    "",
    `Risk:`,
    `- ${left.id}: ${renderClaim(leftAnalysis.risks)}`,
    `- ${right.id}: ${renderClaim(rightAnalysis.risks)}`,
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
