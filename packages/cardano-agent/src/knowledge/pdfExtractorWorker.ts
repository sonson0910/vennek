import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parentPort } from "node:worker_threads";
import {
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_OUTPUT_CHARS,
  PDF_MAX_TITLE_CHARS,
  type PdfExtractionResult,
} from "./pdfExtractorProtocol.js";

const MAX_PAGES = 300;

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
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
          total += item.str.length;
          if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
          parts.push(item.str);
        }
        if (pageNumber < document.numPages) {
          total += 1;
          if (total > PDF_MAX_OUTPUT_CHARS) throw new Error("PDF output limit exceeded");
          parts.push("\n");
        }
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
