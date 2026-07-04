import type { Citation, SourceStatus } from "./types.js";

export function normalizeSnippet(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

export function createCitation(input: {
  id: string;
  url: string;
  title?: string;
  snippet: string;
  retrievedAt: string;
}): Citation {
  return {
    id: input.id,
    url: input.url,
    title: input.title,
    snippet: normalizeSnippet(input.snippet),
    retrievedAt: input.retrievedAt
  };
}

export function hasUsableCitations(citations: Citation[]): boolean {
  return citations.some((citation) => citation.url.trim().length > 0 && citation.snippet.trim().length > 0);
}

export function citationIds(citations: Citation[], count = 2): string {
  const ids = citations.slice(0, count).map((citation) => `[${citation.id}]`);
  return ids.length > 0 ? ids.join(" ") : "[source unavailable]";
}

export function renderCitationList(citations: Citation[]): string {
  if (!hasUsableCitations(citations)) {
    return "Source unavailable: no retrievable citation snippets were attached.";
  }

  return citations
    .map((citation) => {
      const title = citation.title ? `${citation.title} - ` : "";
      return `[${citation.id}] ${title}${citation.url} (${citation.retrievedAt})\n    Snippet: ${citation.snippet}`;
    })
    .join("\n");
}

export function sourceStatusFor(citations: Citation[], fallback: SourceStatus = "available"): SourceStatus {
  return hasUsableCitations(citations) ? fallback : "unavailable";
}
