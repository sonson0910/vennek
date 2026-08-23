import { citationIds, createCitation, renderCitationList, type Citation, type ProposalDocument } from "@vennek/shared";

export type AnalyzedClaim = {
  text: string;
  citation?: Citation;
};

export type ProposalAnalysis = {
  problem: AnalyzedClaim;
  requested: AnalyzedClaim;
  impact: AnalyzedClaim;
  feasibility: AnalyzedClaim;
  risks: AnalyzedClaim;
  missingEvidence: string;
};

export function analyzeDocument(document: ProposalDocument): ProposalAnalysis {
  return {
    problem: analyzedClaim(document, "problem", ["problem", "challenge"], ["problem", "challenge", "need"], "Problem statement is not explicit in the available source."),
    requested: analyzedClaim(document, "requested", ["requestedFunding", "requestedAction", "budget"], ["funding", "budget", "request", "ada", "action"], "Requested funding/action is not explicit in the available source."),
    impact: analyzedClaim(document, "impact", ["impact", "outcomes"], ["impact", "outcome", "benefit", "adoption", "reviewer"], "Impact claim is not explicit in the available source."),
    feasibility: analyzedClaim(document, "feasibility", ["feasibility", "team", "milestones"], ["milestone", "team", "deliver", "experience", "timeline"], "Feasibility evidence is limited in the available source."),
    risks: analyzedClaim(document, "risks", ["risks"], ["risk", "dependency", "uncertain", "challenge"], "No explicit risk section found; treat this as a review question."),
    missingEvidence: pickMetadata(document, ["missingEvidence"]) ?? "Check independent validation, delivery history, budget assumptions, and measurable success criteria."
  };
}

export function analysisCitations(analysis: ProposalAnalysis): Citation[] {
  return [analysis.problem, analysis.requested, analysis.impact, analysis.feasibility, analysis.risks]
    .flatMap((claim) => claim.citation ? [claim.citation] : []);
}

export function renderClaim(claim: AnalyzedClaim): string {
  return `${claim.text} ${claim.citation ? `[${claim.citation.id}]` : "[source unavailable]"}`;
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

function analyzedClaim(
  document: ProposalDocument,
  field: string,
  metadataKeys: string[],
  keywords: string[],
  fallback: string
): AnalyzedClaim {
  const text = pickMetadata(document, metadataKeys) ?? pickSentence(document.body, keywords);
  if (!text) {
    return { text: fallback };
  }

  const url = document.url ?? document.citations[0]?.url;
  if (!url) {
    return { text };
  }

  const prefix = document.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40).toUpperCase() || "SOURCE";
  return {
    text,
    citation: createCitation({
      id: `${prefix}-${field.toUpperCase()}`,
      url,
      title: document.title,
      snippet: text,
      retrievedAt: document.retrievedAt
    })
  };
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
