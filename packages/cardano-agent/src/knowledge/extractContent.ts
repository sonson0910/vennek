import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { marked, Renderer, type Tokens } from "marked";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2_000_000;
const MARKDOWN_RAW_ATTRIBUTE = "data-cardano-markdown-raw";
const MARKDOWN_RAW_SELECTOR = `[${MARKDOWN_RAW_ATTRIBUTE}]`;
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
  const inlineRawTagStack: string[] = [];
  const renderer = new Renderer();
  renderer.html = (token: Tokens.HTML | Tokens.Tag): string => {
    const raw = token.text.trim();
    if (isDroppedMarkdownHtml(raw)) return "";
    if (token.block) return "";
    if (isRawHtmlPair(raw)) {
      return "";
    }
    if (isRawHtmlClosingTag(raw)) {
      const closingTag = rawHtmlTagName(raw);
      if (closingTag && inlineRawTagStack[inlineRawTagStack.length - 1] === closingTag) {
        inlineRawTagStack.pop();
        return "</span>";
      }
      return "";
    }
    if (isRawHtmlOpeningTag(raw)) {
      if (isVoidOrSelfClosingRawTag(raw)) return "";
      const openingTag = rawHtmlTagName(raw);
      if (!openingTag) return "";
      inlineRawTagStack.push(openingTag);
      return `<span ${MARKDOWN_RAW_ATTRIBUTE}>`;
    }
    return "";
  };
  const rendered = marked.parse(source, { renderer, async: false });
  return extractHtml(rendered);
}

function isDroppedMarkdownHtml(value: string): boolean {
  return value.startsWith("<!--") || value.startsWith("<!") || value.startsWith("<?");
}

function rawHtmlTagName(value: string): string | undefined {
  return value.match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b/)?.[1]?.toLowerCase();
}

function isRawHtmlOpeningTag(value: string): boolean {
  return value.startsWith("<") && !value.startsWith("</") && value.endsWith(">");
}

function isRawHtmlClosingTag(value: string): boolean {
  return /^<\s*\/\s*[A-Za-z][A-Za-z0-9:-]*[\s\S]*>$/.test(value);
}

function isRawHtmlPair(value: string): boolean {
  const tag = rawHtmlTagName(value);
  return Boolean(tag && new RegExp(`^<\\s*${tag}\\b[\\s\\S]*<\\/\\s*${tag}\\s*>$`, "i").test(value));
}

function isVoidOrSelfClosingRawTag(value: string): boolean {
  if (/\/\s*>$/.test(value)) return true;
  const tag = rawHtmlTagName(value);
  return Boolean(tag && VOID_RAW_HTML_TAGS.has(tag));
}

const VOID_RAW_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
]);

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
  $(MARKDOWN_RAW_SELECTOR).remove();
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
  if (tag === "img") {
    const alt = normalizeInline(element.attr("alt") ?? "");
    return alt ? [alt] : [];
  }
  if (tag === "br") {
    return ["\n"];
  }
  if (/^h[1-6]$/.test(tag)) {
    const text = normalizeInline(renderInlineHtmlChildren($, node));
    return text ? [`${"#".repeat(Number(tag.slice(1)))} ${text}`] : [];
  }
  if (tag === "pre") {
    const text = renderInlineHtmlChildren($, node).replace(/\r\n?/g, "\n").trim();
    return text ? [text] : [];
  }
  if (tag === "p" || tag === "blockquote") {
    const text = normalizeInline(renderInlineHtmlChildren($, node));
    return text ? [text] : [];
  }
  if (tag === "li") {
    const clone = element.clone();
    clone.children("ul, ol").remove();
    const ownText = clone.contents().toArray().map((child) => renderInlineHtmlNode($, child)).join("");
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

function renderInlineHtmlChildren($: cheerio.CheerioAPI, node: AnyNode): string {
  if (node.type !== "tag") return "";
  return node.children.map((child: AnyNode) => renderInlineHtmlNode($, child)).join("");
}

function renderInlineHtmlNode($: cheerio.CheerioAPI, node: AnyNode): string {
  if (node.type === "text") return $(node).text();
  if (node.type !== "tag") return "";
  const element = $(node);
  const tag = node.name.toLowerCase();
  if (tag === "img") return element.attr("alt") ?? "";
  if (tag === "br") return "\n";
  return renderInlineHtmlChildren($, node);
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
