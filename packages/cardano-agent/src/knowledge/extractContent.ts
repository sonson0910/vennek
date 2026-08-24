import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_PDF_PAGES = 300;
const ALLOWED_MIME_TYPES = new Set([
  "text/html",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/pdf"
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
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error("Content input must not exceed 8 MiB.");
  }

  const mime = input.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new Error(`Unsupported content-type: ${mime || "missing"}`);
  }

  if (mime === "application/pdf") {
    return extractPdf(input.bytes);
  }

  const decoded = decodeUtf8(input.bytes);
  if (mime === "text/html") {
    return extractHtml(decoded);
  }
  if (mime === "application/json") {
    const text = JSON.stringify(JSON.parse(decoded), null, 2);
    return finalizeContent(inferTitle(text), text);
  }
  return finalizeContent(inferTitle(decoded), decoded);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function extractHtml(source: string): ExtractedContent {
  const $ = cheerio.load(source);
  $("script, style, nav, footer").remove();
  $("[hidden], [aria-hidden], [style]").each((_, element) => {
    const node = $(element);
    const ariaHidden = node.attr("aria-hidden")?.trim().toLowerCase();
    const style = node.attr("style") ?? "";
    if (
      node.attr("hidden") !== undefined ||
      ariaHidden === "true" ||
      /(?:^|;)\s*(?:display|visibility)\s*:\s*none(?:\s*!important)?(?:\s*;|$)/i.test(style)
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

async function extractPdf(bytes: Uint8Array): Promise<ExtractedContent> {
  type PdfLoadingTask = ReturnType<typeof getDocument>;
  let loadingTask: PdfLoadingTask | undefined;
  let document: Awaited<PdfLoadingTask["promise"]> | undefined;
  try {
    loadingTask = getDocument({ data: bytes });
    document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF contains more than ${MAX_PDF_PAGES} pages.`);
    }

    const pages: string[] = [];
    let extractedChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => "str" in item ? item.str : "")
          .filter(Boolean)
          .join(" ");
        extractedChars += pageText.length;
        if (extractedChars > MAX_OUTPUT_CHARS) {
          throw new Error("Extracted content exceeds 2,000,000 characters.");
        }
        pages.push(pageText);
      } finally {
        page.cleanup();
      }
    }
    return finalizeContent(inferTitle(pages.join("\n\n")), pages.join("\n\n"));
  } finally {
    try {
      document?.cleanup();
    } finally {
      await loadingTask?.destroy().catch(() => undefined);
    }
  }
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
