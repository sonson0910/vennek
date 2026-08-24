import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { createHash } from "node:crypto";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2_000_000;
const ALLOWED_MIME_TYPES = new Set([
  "text/html",
  "text/markdown",
  "text/plain",
  "application/json"
]);

export type ExtractContentInput = {
  mime: string;
  bytes: Uint8Array;
};

export type ExtractedContent = {
  title: string;
  text: string;
  publishedAt?: Date;
};

export async function extractContent(input: ExtractContentInput): Promise<ExtractedContent> {
  const mime = input.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new Error(`Unsupported content-type: ${mime || "missing"}`);
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error("Content input must not exceed 8 MiB.");
  }

  const decoded = decodeUtf8(input.bytes);
  if (mime === "text/html") {
    return extractHtml(decoded);
  }
  if (mime === "application/json") {
    const text = JSON.stringify(JSON.parse(decoded), null, 2);
    return finalizeContent(inferTitle(text), text);
  }
  if (mime === "text/markdown") {
    return extractMarkdown(decoded);
  }
  return finalizeContent(inferTitle(decoded), decoded);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function extractMarkdown(source: string): ExtractedContent {
  const protectedMarkdown = protectMarkdownLiterals(source);
  const $ = cheerio.load(protectedMarkdown.source, {}, false);
  const root = $.root();
  root.children().remove();
  const sanitized = root
    .contents()
    .toArray()
    .filter((node) => node.type === "text")
    .map((node) => $(node).text())
    .join("");
  const text = restoreMarkdownLiterals(sanitized, protectedMarkdown.prefix, protectedMarkdown.literals);
  return finalizeContent(inferTitle(text), text);
}

type MarkdownLiteralSet = {
  source: string;
  prefix: string;
  literals: string[];
};

function protectMarkdownLiterals(source: string): MarkdownLiteralSet {
  const prefix = selectMarkdownLiteralPrefix(source);
  const literals: string[] = [];
  const protectedParts: string[] = [];
  let index = 0;
  let plainStart = 0;
  while (index < source.length) {
    const fenced = readMarkdownFence(source, index);
    if (fenced) {
      protectedParts.push(source.slice(plainStart, index));
      protectedParts.push(addMarkdownLiteral(source.slice(index, fenced), prefix, literals));
      index = fenced;
      plainStart = index;
      continue;
    }

    const inlineCode = readMarkdownCodeSpan(source, index);
    if (inlineCode) {
      protectedParts.push(source.slice(plainStart, index));
      protectedParts.push(addMarkdownLiteral(source.slice(index, inlineCode), prefix, literals));
      index = inlineCode;
      plainStart = index;
      continue;
    }

    const autolink = readMarkdownAutolink(source, index);
    if (autolink) {
      protectedParts.push(source.slice(plainStart, index));
      protectedParts.push(addMarkdownLiteral(source.slice(index, autolink), prefix, literals));
      index = autolink;
      plainStart = index;
      continue;
    }

    index += 1;
  }
  protectedParts.push(source.slice(plainStart));
  return { source: protectedParts.join(""), prefix, literals };
}

function selectMarkdownLiteralPrefix(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex");
  const base = `__CARDANO_MARKDOWN_LITERAL_${digest}_`;
  let prefix = base;
  let attempt = 0;
  while (source.includes(prefix)) {
    attempt += 1;
    prefix = `${base}${attempt}_`;
  }
  return prefix;
}

function addMarkdownLiteral(value: string, prefix: string, literals: string[]): string {
  const index = literals.length;
  literals.push(value);
  return `${prefix}${index}__`;
}

function restoreMarkdownLiterals(value: string, prefix: string, literals: string[]): string {
  if (literals.length === 0) return value;
  const restored: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const tokenStart = value.indexOf(prefix, cursor);
    if (tokenStart < 0) {
      restored.push(value.slice(cursor));
      break;
    }
    restored.push(value.slice(cursor, tokenStart));
    let tokenEnd = tokenStart + prefix.length;
    while (tokenEnd < value.length && value[tokenEnd] >= "0" && value[tokenEnd] <= "9") {
      tokenEnd += 1;
    }
    if (tokenEnd === tokenStart + prefix.length || !value.startsWith("__", tokenEnd)) {
      restored.push(value.slice(tokenStart, tokenEnd));
      cursor = tokenEnd;
      continue;
    }
    const literalIndex = Number(value.slice(tokenStart + prefix.length, tokenEnd));
    if (!Number.isSafeInteger(literalIndex) || literalIndex < 0 || literalIndex >= literals.length) {
      restored.push(value.slice(tokenStart, tokenEnd + 2));
      cursor = tokenEnd + 2;
      continue;
    }
    restored.push(literals[literalIndex]);
    cursor = tokenEnd + 2;
  }
  return restored.join("");
}

function readMarkdownFence(source: string, start: number): number | undefined {
  if (start !== 0 && source[start - 1] !== "\n") return undefined;
  let cursor = start;
  let indentation = 0;
  while (source[cursor] === " " && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3 || (source[cursor] !== "`" && source[cursor] !== "~")) return undefined;

  const fenceCharacter = source[cursor];
  const openingStart = cursor;
  while (source[cursor] === fenceCharacter) cursor += 1;
  const fenceLength = cursor - openingStart;
  if (fenceLength < 3) return undefined;

  const openingLineEnd = findMarkdownLineEnd(source, cursor);
  if (fenceCharacter === "`" && source.slice(cursor, openingLineEnd).includes("`")) return undefined;
  if (openingLineEnd >= source.length) return source.length;

  let lineStart = openingLineEnd + 1;
  while (lineStart < source.length) {
    const lineEnd = findMarkdownLineEnd(source, lineStart);
    let closingCursor = lineStart;
    let closingIndentation = 0;
    while (source[closingCursor] === " " && closingIndentation < 4) {
      closingCursor += 1;
      closingIndentation += 1;
    }
    if (closingIndentation <= 3 && source[closingCursor] === fenceCharacter) {
      const closingStart = closingCursor;
      while (source[closingCursor] === fenceCharacter) closingCursor += 1;
      const closingLength = closingCursor - closingStart;
      if (closingLength >= fenceLength && source.slice(closingCursor, lineEnd).trim() === "") {
        return lineEnd < source.length ? lineEnd + 1 : lineEnd;
      }
    }
    if (lineEnd >= source.length) break;
    lineStart = lineEnd + 1;
  }
  return source.length;
}

function findMarkdownLineEnd(source: string, start: number): number {
  const lineEnd = source.indexOf("\n", start);
  return lineEnd < 0 ? source.length : lineEnd;
}

function readMarkdownCodeSpan(source: string, start: number): number | undefined {
  if (source[start] !== "`") return undefined;
  let openingCursor = start;
  while (source[openingCursor] === "`") openingCursor += 1;
  const runLength = openingCursor - start;
  let cursor = openingCursor;
  while (cursor < source.length) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const closingStart = cursor;
    while (source[cursor] === "`") cursor += 1;
    if (cursor - closingStart === runLength) return cursor;
  }
  return undefined;
}

function readMarkdownAutolink(source: string, start: number): number | undefined {
  if (source[start] !== "<") return undefined;
  const close = source.indexOf(">", start + 1);
  if (close < 0) return undefined;
  const value = source.slice(start + 1, close);
  return /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ <>]+$/.test(value) ? close + 1 : undefined;
}

const HIDDEN_CLASS_TOKENS = new Set([
  "hidden",
  "invisible",
  "visually-hidden",
  "sr-only",
  "screen-reader-only",
  "d-none"
]);

function hasHiddenClass(value: string | undefined): boolean {
  return (value ?? "")
    .trim()
    .split(/\s+/)
    .some((token) => HIDDEN_CLASS_TOKENS.has(token.toLowerCase()));
}

function hasConcealedStyle(style: string): boolean {
  return style.split(";").some((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .replace(/\s*!\s*important\s*$/i, "")
      .trim()
      .toLowerCase();
    if (property === "display") return value === "none";
    if (property === "visibility" || property === "content-visibility") return value === "hidden";
    if (property === "opacity") return /^0(?:\.0+)?$/.test(value);
    if (property === "font-size") return /^0(?:\.0+)?(?:[a-z%]+)?$/.test(value);
    if (property === "color") return value === "transparent";
    return false;
  });
}

function extractHtml(source: string): ExtractedContent {
  const $ = cheerio.load(source);
  // Static extraction is hygiene only; downstream must treat all source text as untrusted.
  $("script, style, nav, footer").remove();
  $("[hidden], [aria-hidden], [style], [class]").each((_, element) => {
    const node = $(element);
    const ariaHidden = node.attr("aria-hidden")?.trim().toLowerCase();
    const style = node.attr("style") ?? "";
    if (
      node.attr("hidden") !== undefined ||
      ariaHidden === "true" ||
      hasConcealedStyle(style) ||
      hasHiddenClass(node.attr("class"))
    ) {
      node.remove();
    }
  });

  const h1 = $("h1").first().text().trim();
  const title = h1 || $("title").first().text().trim() || "Untitled source";
  const blocks = ($("body").length ? $("body").contents().toArray() : $.root().contents().toArray())
    .flatMap((node) => renderHtmlNode($, node));
  const publishedAt = findPublishedAt($);
  return finalizeContent(title, blocks.join("\n\n"), publishedAt);
}

function renderHtmlNode($: cheerio.CheerioAPI, node: AnyNode): string[] {
  if (node.type === "text") {
    const text = normalizeInline($(node).text());
    return text ? [text] : [];
  }
  if (node.type !== "tag") {
    return [];
  }

  const element = $(node);
  const tag = node.name.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const text = normalizeInline(element.text());
    return text ? [`${"#".repeat(Number(tag.slice(1)))} ${text}`] : [];
  }
  if (tag === "pre") {
    const text = element.text().replace(/\r\n?/g, "\n").trim();
    return text ? [text] : [];
  }
  if (tag === "p" || tag === "blockquote") {
    const text = normalizeInline(element.text());
    return text ? [text] : [];
  }
  if (tag === "li") {
    const ownText = element.clone().children("ul, ol").remove().end().text();
    const own = normalizeInline(ownText);
    const nested = element.children("ul, ol").contents().toArray().flatMap((child) => renderHtmlNode($, child));
    return [own ? `- ${own}` : "", ...nested].filter(Boolean);
  }
  if (tag === "ul" || tag === "ol") {
    return element.children("li").toArray().flatMap((child) => renderHtmlNode($, child));
  }

  const children = node.children?.flatMap((child: AnyNode) => renderHtmlNode($, child)) ?? [];
  if (children.length > 0) {
    return children;
  }
  const fallback = normalizeInline(element.text());
  return fallback ? [fallback] : [];
}

function findPublishedAt($: cheerio.CheerioAPI): Date | undefined {
  const values = [
    $("meta[property='article:published_time']").first().attr("content"),
    $("meta[name='published']").first().attr("content"),
    $("meta[name='publishdate']").first().attr("content"),
    $("meta[name='date']").first().attr("content"),
    $("time[datetime]").first().attr("datetime")
  ];
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }
  return undefined;
}

function finalizeContent(title: string, text: string, publishedAt?: Date): ExtractedContent {
  const normalized = normalizeDocumentText(text);
  if (!normalized) {
    throw new Error("Extracted content is empty.");
  }
  if (normalized.length > MAX_OUTPUT_CHARS) {
    throw new Error("Extracted content exceeds 2,000,000 characters.");
  }
  const result: ExtractedContent = {
    title: normalizeInline(title) || inferTitle(normalized),
    text: normalized
  };
  if (publishedAt) {
    result.publishedAt = publishedAt;
  }
  return result;
}

function normalizeDocumentText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferTitle(value: string): string {
  const heading = value.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120) || "Untitled source";
}
