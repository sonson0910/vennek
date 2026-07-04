import { hasUsableCitations, sourceStatusFor, type CommandContext, type CommandResult } from "@vennek/shared";
import { resolveProposalDocument } from "../store/documentStore.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";
import { renderCitations } from "./analysis.js";

export async function sourcesCommand(input: string, context: CommandContext = {}): Promise<CommandResult> {
  const document = await resolveProposalDocument(input, context);
  const citations = document.citations;
  const sourceStatus = sourceStatusFor(citations);
  const sourceNote = hasUsableCitations(citations)
    ? "Source cache status: deterministic fixture or retrieved source available."
    : "Source unavailable: no retrievable citation snippets were attached.";

  const text = [
    humanDecisionFrame(),
    "Sources are reported for audit; humans must verify current source state before final decisions.",
    "",
    `Proposal: ${document.title}`,
    `Source status: ${sourceStatus}`,
    `Retrieved at: ${document.retrievedAt}`,
    sourceNote,
    "",
    "Citations:",
    renderCitations(citations)
  ].join("\n");

  return assertSafeOutput({
    command: "sources",
    ok: true,
    text,
    citations,
    sourceStatus,
    warnings: [],
    data: { document }
  });
}
