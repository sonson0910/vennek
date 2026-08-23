import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult, type Stance } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analysisCitations, analyzeDocument, cite, renderClaim, renderCitations } from "./analysis.js";

const STANCES = new Set<Stance>(["support", "oppose", "abstain"]);

export async function voteDraftCommand(input: string, stance: string, context: CommandContext = {}): Promise<CommandResult> {
  if (!STANCES.has(stance as Stance)) {
    throw new Error("/vote-draft requires a human-selected stance: support, oppose, or abstain.");
  }

  const document = await resolveProposalDocument(input, context);
  const analysis = analyzeDocument(document);
  const citations = analysisCitations(analysis);
  const sourceStatus = sourceStatusFor(citations);
  const citationHint = cite(citations);
  const sourceNote = hasUsableCitations(citations)
    ? `Evidence anchors: ${citationHint}`
    : "Source unavailable: no retrievable citation snippets were attached.";

  const stanceText = stance as Stance;
  const rationale = rationaleFor(stanceText);

  const text = [
    humanDecisionFrame(),
    "Human-selected stance only. Vennek is drafting wording; it is not selecting the stance.",
    "",
    `Proposal: ${document.title}`,
    `Selected stance: ${stanceText}`,
    `Source status: ${sourceStatus}`,
    sourceNote,
    "",
    "Draft rationale:",
    rationale,
    "",
    "Quoted source claims:",
    `- Problem: ${renderClaim(analysis.problem)}`,
    `- Requested resources/action: ${renderClaim(analysis.requested)}`,
    `- Impact: ${renderClaim(analysis.impact)}`,
    `- Feasibility: ${renderClaim(analysis.feasibility)}`,
    `- Risks: ${renderClaim(analysis.risks)}`,
    "",
    "Caveats to preserve:",
    "- Re-check missing evidence and the quoted source claims before submitting.",
    `- Confirm that cited claims still match the current proposal source before submitting.`,
    `- This draft should be edited by the human reviewer or DRep.`,
    "",
    "Citations:",
    renderCitations(citations)
  ].join("\n");

  return assertSafeOutput({
    command: "vote-draft",
    ok: true,
    text,
    citations,
    sourceStatus,
    warnings: [],
    data: { document, analysis, stance: stanceText }
  });
}

function rationaleFor(stance: Stance): string {
  if (stance === "support") {
    return "I selected support after reviewing the source-stated problem, impact, feasibility, and risks below.";
  }

  if (stance === "oppose") {
    return "I selected oppose after reviewing the source-stated risks, requested resources, and missing evidence below.";
  }

  return "I selected abstain because the available source evidence does not support a definitive rationale without further review.";
}
