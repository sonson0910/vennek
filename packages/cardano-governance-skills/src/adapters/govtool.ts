import type { ProposalDocument } from "@vennek/shared";
import { fetchUserProvidedUrl, hostMatches, normalizeUserProvidedText } from "./userProvided.js";

const GOVTOOL_HOSTS = ["gov.tools", "govtool.org", "intersectmbo.org"];

export function isGovToolUrl(value: string): boolean {
  try {
    return hostMatches(new URL(value).hostname, GOVTOOL_HOSTS);
  } catch {
    return false;
  }
}

export async function fetchGovernanceAction(url: string, now?: Date): Promise<ProposalDocument> {
  return fetchUserProvidedUrl({ url, sourceType: "governance-action", now });
}

export function normalizeGovernanceSnapshot(input: {
  text: string;
  title?: string;
  url?: string;
  now?: Date;
}): ProposalDocument {
  return normalizeUserProvidedText({
    ...input,
    sourceType: "governance-action"
  });
}
