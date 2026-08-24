import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parentPort } from "node:worker_threads";
import {
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_OUTPUT_CHARS,
  PDF_MAX_TITLE_CHARS,
  type PdfExtractionResult,
} from "./pdfExtractorProtocol.js";

const MAX_PAGES = 300;

export function appendTextItem(parts: string[], item: { str: string; hasEOL?: boolean }, total: number, hasFollowingContent: boolean): number {
  if (item.str.length > 0) {
    total += item.str.length;
    if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
    parts.push(item.str);
  }
  if (!hasFollowingContent) return total;
  if (item.hasEOL) {
    total += 1;
    if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
    parts.push("\n");
  } else if (item.str.length > 0) {
    total += 1;
    if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
    parts.push(" ");
  }
  return total;
}

export function appendTextItems(
  parts: string[],
  items: ReadonlyArray<{ str: string; hasEOL?: boolean }>,
  total: number
): { total: number; hasContent: boolean } {
  const followsContent = new Array<boolean>(items.length);
  let contentFollows = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    followsContent[index] = contentFollows;
    if (items[index].str.length > 0) contentFollows = true;
  }
  let hasContent = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    total = appendTextItem(parts, item, total, followsContent[index]);
    hasContent ||= item.str.length > 0 || item.hasEOL === true;
  }
  return { total, hasContent };
}

export async function extractPdf(bytes: ArrayBuffer): Promise<PdfExtractionResult> {
  if (bytes.byteLength < 1 || bytes.byteLength > PDF_MAX_INPUT_BYTES) throw new Error("PDF input limit exceeded");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) {
      throw new Error("PDF page limit exceeded");
    }
    const parts: string[] = [];
    let total = 0;
    let pageBreakPending = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const textItems = content.items.map((item) => ({
          str: "str" in item && typeof item.str === "string" ? item.str : "",
          hasEOL: "hasEOL" in item && item.hasEOL === true
        }));
        const hasContent = textItems.some((item) => item.str.length > 0 || item.hasEOL === true);
        if (pageBreakPending && hasContent) {
            total += 1;
            if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
            parts.push("\n");
            pageBreakPending = false;
        }
        const appended = appendTextItems(parts, textItems, total);
        total = appended.total;
        if (appended.hasContent && pageNumber < document.numPages) pageBreakPending = true;
      } finally {
        page.cleanup();
      }
    }
    const text = parts.join("").trim();
    if (!text) throw new Error("PDF text is empty");
    const metadata = await document.getMetadata().catch(() => undefined);
    const info = metadata && typeof metadata === "object" && "info" in metadata && metadata.info && typeof metadata.info === "object"
      ? metadata.info as Record<string, unknown>
      : undefined;
    const rawTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
    return { title: rawTitle.slice(0, PDF_MAX_TITLE_CHARS) || "PDF document", text };
  } finally {
    if (document) await document.cleanup();
    await loadingTask.destroy();
  }
}

if (parentPort) {
  parentPort.on("message", (bytes: ArrayBuffer) => {
    void extractPdf(bytes)
      .then((result) => parentPort!.postMessage({ ok: true, result }))
      .catch(() => parentPort!.postMessage({ ok: false, error: "PDF parsing failed" }));
  });
}
