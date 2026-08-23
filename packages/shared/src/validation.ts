import type { Citation, ProposalDocument } from "./types.js";

function isCitation(value: unknown): value is Citation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const citation = value as Partial<Citation>;
  return typeof citation.id === "string"
    && typeof citation.url === "string"
    && (citation.title === undefined || typeof citation.title === "string")
    && typeof citation.snippet === "string"
    && typeof citation.retrievedAt === "string";
}

export function isProposalDocument(value: unknown): value is ProposalDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const document = value as Partial<ProposalDocument>;
  return typeof document.id === "string"
    && (document.sourceType === "catalyst" || document.sourceType === "governance-action" || document.sourceType === "user-provided")
    && (document.url === undefined || typeof document.url === "string")
    && typeof document.title === "string"
    && typeof document.body === "string"
    && document.metadata !== null
    && typeof document.metadata === "object"
    && !Array.isArray(document.metadata)
    && Array.isArray(document.citations)
    && document.citations.every(isCitation)
    && typeof document.retrievedAt === "string";
}
