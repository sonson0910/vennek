import { citationIds, renderCitationList, type Citation, type ProposalDocument } from "@vennek/shared";

export type ProposalAnalysis = {
  problem: string;
  requested: string;
  impact: string;
  feasibility: string;
  risks: string;
  missingEvidence: string;
};

export function analyzeDocument(document: ProposalDocument): ProposalAnalysis {
  return {
    problem: pickMetadata(document, ["problem", "challenge"]) ?? pickSentence(document.body, ["problem", "challenge", "need"]) ?? "Problem statement is not explicit in the available source.",
    requested: pickMetadata(document, ["requestedFunding", "requestedAction", "budget"]) ?? pickSentence(document.body, ["funding", "budget", "request", "ada", "action"]) ?? "Requested funding/action is not explicit in the available source.",
    impact: pickMetadata(document, ["impact", "outcomes"]) ?? pickSentence(document.body, ["impact", "outcome", "benefit", "adoption", "reviewer"]) ?? "Impact claim is not explicit in the available source.",
    feasibility: pickMetadata(document, ["feasibility", "team", "milestones"]) ?? pickSentence(document.body, ["milestone", "team", "deliver", "experience", "timeline"]) ?? "Feasibility evidence is limited in the available source.",
    risks: pickMetadata(document, ["risks"]) ?? pickSentence(document.body, ["risk", "dependency", "uncertain", "challenge"]) ?? "No explicit risk section found; treat this as a review question.",
    missingEvidence: pickMetadata(document, ["missingEvidence"]) ?? "Check independent validation, delivery history, budget assumptions, and measurable success criteria."
  };
}

export function evidenceScore(document: ProposalDocument): number {
  const text = `${document.body}\n${JSON.stringify(document.metadata)}`.toLowerCase();
  const signals = ["milestone", "budget", "risk", "team", "metric", "deliverable", "evidence", "timeline"];
  const signalCount = signals.filter((signal) => text.includes(signal)).length;
  return Math.min(5, Math.max(1, Math.round((signalCount / signals.length) * 5)));
}

export function renderCitations(citations: Citation[]): string {
  return renderCitationList(citations);
}

export function cite(citations: Citation[], count = 2): string {
  return citationIds(citations, count);
}

function pickMetadata(document: ProposalDocument, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = document.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function pickSentence(text: string, keywords: string[]): string | undefined {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.find((sentence) =>
    keywords.some((keyword) => sentence.toLowerCase().includes(keyword.toLowerCase()))
  );
}
