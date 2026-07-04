import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult, type Stance } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { analyzeDocument, cite, renderCitations } from "./analysis.js";

const STANCES = new Set<Stance>(["support", "oppose", "abstain"]);

export async function voteDraftCommand(input: string, stance: string, context: CommandContext = {}): Promise<CommandResult> {
  if (!STANCES.has(stance as Stance)) {
    throw new Error("/vote-draft requires a human-selected stance: support, oppose, or abstain.");
  }

  const document = await resolveProposalDocument(input, context);
  const analysis = analyzeDocument(document);
  const citations = document.citations;
  const sourceStatus = sourceStatusFor(citations);
  const citationHint = cite(citations);
  const sourceNote = hasUsableCitations(citations)
    ? `Evidence anchors: ${citationHint}`
    : "Source unavailable: no retrievable citation snippets were attached.";

  const stanceText = stance as Stance;
  const rationale = rationaleFor(stanceText, analysis);

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
    `${rationale} ${citationHint}`,
    "",
    "Caveats to preserve:",
    `- Re-check missing evidence: ${analysis.missingEvidence}`,
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

function rationaleFor(stance: Stance, analysis: ReturnType<typeof analyzeDocument>): string {
  const problem = stripTerminalPunctuation(analysis.problem);
  const impact = stripTerminalPunctuation(analysis.impact);
  const feasibility = stripTerminalPunctuation(analysis.feasibility);
  const risks = stripTerminalPunctuation(analysis.risks);
  const missingEvidence = stripTerminalPunctuation(analysis.missingEvidence);
  const requested = stripTerminalPunctuation(analysis.requested);

  if (stance === "support") {
    return `I selected support because the proposal's stated problem, requested action, impact claim, and feasibility evidence appear aligned enough for consideration. Key points to cite are: ${problem}; ${impact}; ${feasibility}.`;
  }

  if (stance === "oppose") {
    return `I selected oppose because the proposal leaves material concerns for review. The main issues to cite are: ${risks}; missing evidence: ${missingEvidence}; requested resources/action: ${requested}.`;
  }

  return `I selected abstain because the source gives partial evidence but leaves enough uncertainty that a definitive governance rationale should wait for more information. The main unresolved points are: ${missingEvidence}; ${risks}.`;
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "");
}
