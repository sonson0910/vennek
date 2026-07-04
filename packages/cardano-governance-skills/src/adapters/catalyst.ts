import type { ProposalDocument } from "@vennek/shared";
import { fetchUserProvidedUrl, hostMatches, normalizeUserProvidedText } from "./userProvided.js";

const CATALYST_HOSTS = ["projectcatalyst.io", "ideascale.com"];

export function isCatalystUrl(value: string): boolean {
  try {
    return hostMatches(new URL(value).hostname, CATALYST_HOSTS);
  } catch {
    return false;
  }
}

export async function fetchCatalystProposal(url: string, now?: Date): Promise<ProposalDocument> {
  return fetchUserProvidedUrl({ url, sourceType: "catalyst", now, allowedDomains: CATALYST_HOSTS });
}

export function normalizeCatalystSnapshot(input: {
  text: string;
  title?: string;
  url?: string;
  now?: Date;
}): ProposalDocument {
  return normalizeUserProvidedText({
    ...input,
    sourceType: "catalyst"
  });
}
