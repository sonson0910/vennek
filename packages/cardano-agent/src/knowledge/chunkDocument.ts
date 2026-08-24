import { sha256Hex } from "@vennek/shared";

const TARGET_CHARS = 1_000;
const HARD_CAP_CHARS = 1_200;
const MAX_PROSE_CARRY = 150;
const MAX_HEADING_CHARS = 200;
// Embedding payloads are heading + newline + content, so the fixed bound is 200 + 1 + 1200 = 1401.
const DEFAULT_HEADING = "Document";
const MAX_CHUNKS_PER_DOCUMENT = 2_500;
const MAX_DERIVED_EMBEDDING_CHARS = 3_000_000;

export type DocumentChunk = {
  ordinal: number;
  heading: string;
  content: string;
  contentHash: string;
};

type Block = { heading: string; headingRemainder: string; kind: "prose" | "code"; content: string };

export function chunkDocument(content: string): DocumentChunk[] {
  if (typeof content !== "string") throw new Error("Document content is required.");
  const normalized = content.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!normalized) throw new Error("Document content must not be empty.");

  const blocks = parseBlocks(normalized.split("\n"));
  const chunks: Array<{ heading: string; content: string }> = [];
  let derivedEmbeddingChars = 0;
  const pushChunk = (heading: string, chunkContent: string) => {
    const payloadChars = heading.length + 1 + chunkContent.length;
    if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) throw new Error("Document produces too many chunks.");
    if (derivedEmbeddingChars + payloadChars > MAX_DERIVED_EMBEDDING_CHARS) {
      throw new Error("Document derived embeddings are too large.");
    }
    chunks.push({ heading, content: chunkContent });
    derivedEmbeddingChars += payloadChars;
  };
  let prose: { heading: string; content: string } | undefined;
  const flushProse = () => {
    if (prose?.content) pushChunk(prose.heading, prose.content);
    prose = undefined;
  };
  const appendProse = (heading: string, blockContent: string) => {
    if (!blockContent) return;
    for (const piece of splitProse(blockContent, TARGET_CHARS, HARD_CAP_CHARS)) {
      if (prose && prose.heading === heading && prose.content.length + 2 + piece.length <= TARGET_CHARS) {
        prose.content += `\n\n${piece}`;
      } else {
        flushProse();
        prose = { heading, content: piece };
      }
    }
  };

  for (const block of blocks) {
    const heading = boundHeading(block.heading);
    if (block.kind === "code") {
      appendProse(heading, block.headingRemainder);
      flushProse();
      for (const piece of splitCode(block.content, HARD_CAP_CHARS)) pushChunk(heading, piece);
      continue;
    }
    appendProse(heading, block.headingRemainder ? `${block.headingRemainder}\n\n${block.content}` : block.content);
  }
  flushProse();

  if (chunks.length === 0) {
    const heading = DEFAULT_HEADING;
    for (const piece of splitProse(normalized, TARGET_CHARS, HARD_CAP_CHARS)) {
      pushChunk(heading, piece);
    }
  }

  return chunks
    .filter(({ content }) => content.trim().length > 0)
    .map(({ heading, content }, ordinal) => ({
      ordinal,
      heading,
      content,
      contentHash: sha256Hex(`${heading}\n${content}`),
    }));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let heading = DEFAULT_HEADING;
  let headingRemainder = "";
  const flushHeadingRemainder = () => {
    if (!headingRemainder) return;
    blocks.push({ heading, headingRemainder: "", kind: "prose", content: headingRemainder });
    headingRemainder = "";
  };
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n").trim();
    if (text) {
      blocks.push({ heading, headingRemainder, kind: "prose", content: text });
      headingRemainder = "";
    }
    prose = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const parsedHeading = markdownHeading(line);
    if (parsedHeading !== undefined) {
      flushProse();
      flushHeadingRemainder();
      heading = parsedHeading || DEFAULT_HEADING;
      headingRemainder = headingOverflow(parsedHeading ?? "");
      continue;
    }
    const fence = openingFence(line);
    if (fence) {
      flushProse();
      const codeLines = [line];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        const codeLine = lines[index]!;
        codeLines.push(codeLine);
        if (closingFence(codeLine, fence)) {
          closed = true;
          break;
        }
      }
      blocks.push({ heading, headingRemainder, kind: "code", content: codeLines.join("\n").trim() });
      headingRemainder = "";
      if (!closed) break;
      continue;
    }
    if (line.trim()) prose.push(line);
    else flushProse();
  }
  flushProse();
  flushHeadingRemainder();
  return blocks;
}

function markdownHeading(line: string): string | undefined {
  const match = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/.exec(line);
  if (!match) return undefined;
  return (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function openingFence(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { marker: match[1]![0] as "`" | "~", length: match[1]!.length } : undefined;
}

function closingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const expression = new RegExp(`^\\s{0,3}${fence.marker}{${fence.length},}\\s*$`);
  return expression.test(line);
}

function splitProse(content: string, target: number, hardCap: number): string[] {
  if (content.length <= hardCap) return [content];
  const pieces: string[] = [];
  let remaining = content;
  while (remaining.length > hardCap) {
    const cut = safeCut(remaining, proseCut(remaining, target));
    const piece = remaining.slice(0, cut).trimEnd();
    if (piece) pieces.push(piece);
    const carry = suffixSafe(piece, MAX_PROSE_CARRY);
    const tail = remaining.slice(cut).trimStart();
    remaining = carry && !tail.startsWith(carry) ? `${carry}\n${tail}` : tail;
  }
  if (remaining.trim()) pieces.push(remaining.trim());
  return pieces;
}

function proseCut(content: string, target: number): number {
  const safeTarget = Math.min(target, content.length - 1);
  const boundary = Math.max(content.lastIndexOf(" ", safeTarget), content.lastIndexOf("\n", safeTarget));
  return boundary > safeTarget / 2 ? boundary : safeTarget;
}

function splitCode(content: string, hardCap: number): string[] {
  if (content.length <= hardCap) return [content];
  const pieces: string[] = [];
  let remaining = content;
  while (remaining.length > hardCap) {
    let cut = remaining.lastIndexOf("\n", hardCap);
    if (cut <= 0) cut = hardCap;
    cut = safeCut(remaining, cut);
    pieces.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

function boundHeading(value: string): string {
  return truncateSafe(value.trim(), MAX_HEADING_CHARS) || DEFAULT_HEADING;
}

function headingOverflow(value: string): string {
  const normalized = value.trim();
  const bounded = truncateSafe(normalized, MAX_HEADING_CHARS);
  return normalized.slice(bounded.length).trimStart();
}

function truncateSafe(value: string, maxLength: number): string {
  let end = Math.min(value.length, maxLength);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end).trimEnd();
}

function safeCut(value: string, requested: number): number {
  let cut = Math.max(1, Math.min(requested, value.length - 1));
  if (isHighSurrogate(value.charCodeAt(cut - 1))) cut -= 1;
  return Math.max(1, cut);
}

function suffixSafe(value: string, maxLength: number): string {
  let start = Math.max(0, value.length - maxLength);
  if (start > 0 && isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
