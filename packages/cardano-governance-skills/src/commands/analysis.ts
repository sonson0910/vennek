import { citationIds, createCitation, hasUsableCitations, renderCitationList, sha256Hex, type Citation, type ProposalDocument } from "@vennek/shared";

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

  const source = sourceMatch(document, text);
  if (!source) {
    return { text };
  }

  const normalizedId = document.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const prefix = `${(normalizedId.slice(0, 31) || "SOURCE").toUpperCase()}-${sha256Hex(document.id).slice(0, 8).toUpperCase()}`;
  const citation = createCitation({
    id: `${prefix}-${field.toUpperCase()}`,
    url: source.url,
    title: source.title,
    snippet: source.text,
    retrievedAt: document.retrievedAt
  });
  return {
    text: citation.snippet,
    citation
  };
}

type SourceMatch = {
  text: string;
  url: string;
  title?: string;
};

function sourceMatch(document: ProposalDocument, text: string): SourceMatch | undefined {
  const normalizedText = normalizeForSearch(text);
  if (normalizeForSearch(document.body).includes(normalizedText)) {
    const url = document.url?.trim();
    if (url) {
      return { text, url, title: document.title };
    }
  }

  const citation = document.citations.find((candidate) =>
    hasUsableCitations([candidate]) && normalizeForSearch(candidate.snippet).includes(normalizedText)
  );
  return citation
    ? { text, url: citation.url.trim(), title: citation.title }
    : undefined;
}

function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
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
