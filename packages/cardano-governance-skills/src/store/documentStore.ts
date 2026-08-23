import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProposalDocument, type CommandContext, type ProposalDocument } from "@vennek/shared";
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
    return readLocalProposalDocument(trimmed, context.allowedFileRoot);
  }

  if (isUrl(trimmed)) {
    if (isCatalystUrl(trimmed)) {
      return fetchCatalystProposal(trimmed, context.now);
    }

    if (isGovToolUrl(trimmed)) {
      return fetchGovernanceAction(trimmed, context.now);
    }

    return fetchUserProvidedUrl({ url: trimmed, now: context.now, allowedDomains: context.remoteFetchAllowedDomains });
  }

  return normalizeUserProvidedText({ text: trimmed, now: context.now });
}

function readJsonDocuments(path: string): ProposalDocument[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProposalDocument | ProposalDocument[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024;

function readLocalProposalDocument(path: string, root: string): ProposalDocument {
  try {
    const absolutePath = resolve(path);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch (error) {
      const lexicalRelative = relative(resolve(root), absolutePath);
      if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
        throw new Error("Local file source is outside the allowed file root.");
      }
      throw error;
    }

    const linkMetadata = lstatSync(absolutePath);
    if (linkMetadata.isSymbolicLink()) {
      throw new Error("Local file source must be a regular file, not a symbolic link.");
    }

    const canonicalPath = realpathSync(absolutePath);
    const rel = relative(canonicalRoot, canonicalPath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Local file source is outside the allowed file root.");
    }

    const metadata = statSync(canonicalPath);
    if (!metadata.isFile()) {
      throw new Error("Local file source must be a regular file.");
    }
    if (metadata.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error("Local file source exceeds 2 MiB.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(canonicalPath, "utf8")) as unknown;
    } catch {
      throw new Error("Invalid ProposalDocument in local file source.");
    }
    if (!isProposalDocument(parsed)) {
      throw new Error("Invalid ProposalDocument in local file source.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Local file source")) {
      throw error;
    }
    throw new Error(`Unable to read local file source: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
