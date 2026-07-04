import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { CommandContext, ProposalDocument } from "@vennek/shared";
import { isCatalystUrl, fetchCatalystProposal } from "../adapters/catalyst.js";
import { isGovToolUrl, fetchGovernanceAction } from "../adapters/govtool.js";
import { fetchUserProvidedUrl, normalizeUserProvidedText } from "../adapters/userProvided.js";

export function loadSampleDocuments(sampleRoot = process.cwd()): ProposalDocument[] {
  const directory = resolve(sampleRoot, "samples/proposals");
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((file) => file.endsWith(".json") && !file.startsWith("validation-"))
    .flatMap((file) => readJsonDocuments(join(directory, file)));
}

export async function resolveProposalDocument(input: string, context: CommandContext = {}): Promise<ProposalDocument> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Missing proposal id, URL, file path, or pasted proposal text.");
  }

  const documents = [
    ...(context.documents ?? []),
    ...(context.enableFixtures === false ? [] : loadSampleDocuments(context.sampleRoot))
  ];
  const id = trimmed.replace(/^sample:/, "");
  const fixture = documents.find((document) => document.id === id || basename(document.id, ".json") === id);
  if (fixture) {
    return fixture;
  }

  if (context.allowLocalFiles && context.allowedFileRoot && existsSync(trimmed)) {
    const safePath = resolveAllowedLocalPath(trimmed, context.allowedFileRoot);
    const parsed = JSON.parse(readFileSync(safePath, "utf8")) as ProposalDocument;
    return parsed;
  }

  if (isUrl(trimmed)) {
    if (isCatalystUrl(trimmed)) {
      return fetchCatalystProposal(trimmed, context.now);
    }

    if (isGovToolUrl(trimmed)) {
      return fetchGovernanceAction(trimmed, context.now);
    }

    return fetchUserProvidedUrl({ url: trimmed, now: context.now });
  }

  return normalizeUserProvidedText({ text: trimmed, now: context.now });
}

function readJsonDocuments(path: string): ProposalDocument[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProposalDocument | ProposalDocument[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function resolveAllowedLocalPath(path: string, root: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  const withinRoot = rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  if (!withinRoot) {
    throw new Error("Local file source is outside the allowed file root.");
  }
  return absolutePath;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
