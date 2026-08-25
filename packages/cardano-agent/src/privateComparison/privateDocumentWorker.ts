import { fileTypeFromBuffer } from "file-type";
import * as yauzl from "yauzl";
import { Readable } from "node:stream";
import { parentPort } from "node:worker_threads";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_TEXT_BYTES,
  validatePrivateExtractionResult,
  type PrivateDocumentType,
  type PrivateExtractionResult,
} from "./privateDocumentProtocol.js";

const PDF_MAX_PAGES = 300;
const DOCX_MAX_ENTRIES = 2_048;
const DOCX_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const DOCX_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DOCX_MAX_XML_BYTES = 1024 * 1024;
const DOCX_MAX_COMPRESSION_RATIO = 100;
const MAX_TEXT_CODE_UNITS = PRIVATE_DOCUMENT_MAX_TEXT_BYTES;

const MIME_BY_TYPE: Record<PrivateDocumentType, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "text/plain",
  markdown: "text/markdown",
};

const EXTENSIONS_BY_TYPE: Record<PrivateDocumentType, ReadonlySet<string>> = {
  pdf: new Set(["pdf"]),
  docx: new Set(["docx"]),
  text: new Set(["txt"]),
  markdown: new Set(["md", "markdown"]),
};

export type PrivateDocumentMetadata = Readonly<{
  fileName: string;
  mime: string;
}>;

type ZipPreflight = Readonly<{
  contentTypes: string;
  relationships: ReadonlyMap<string, string>;
}>;

export async function extractPrivateDocument(
  bytes: Uint8Array,
  metadata: PrivateDocumentMetadata,
): Promise<PrivateExtractionResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PRIVATE_DOCUMENT_MAX_BYTES) {
    throw new Error("Private document input must be between 1 byte and 20 MiB");
  }
  const advisoryType = advisoryDocumentType(metadata);
  const buffer = Buffer.from(bytes);
  const detected = await fileTypeFromBuffer(buffer);

  if (detected?.ext === "pdf") {
    if (advisoryType !== "pdf") throw new Error("Document type mismatch");
    return extractPdf(buffer, metadata);
  }
  if (detected?.ext === "zip" || detected?.ext === "docx") {
    if (advisoryType !== "docx") throw new Error("Document type mismatch");
    return extractDocx(buffer, metadata);
  }
  if (detected !== undefined) throw new Error("Document type mismatch");
  if (advisoryType !== "text" && advisoryType !== "markdown") {
    throw new Error("Document type mismatch");
  }
  return extractText(buffer, advisoryType, metadata);
}

function advisoryDocumentType(metadata: PrivateDocumentMetadata): PrivateDocumentType {
  if (
    metadata === null || typeof metadata !== "object" ||
    typeof metadata.fileName !== "string" || typeof metadata.mime !== "string"
  ) {
    throw new Error("Document type mismatch");
  }
  const fileName = metadata.fileName.trim();
  const mime = metadata.mime.trim().toLowerCase();
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  for (const type of Object.keys(MIME_BY_TYPE) as PrivateDocumentType[]) {
    if (mime === MIME_BY_TYPE[type] && extension !== undefined && EXTENSIONS_BY_TYPE[type].has(extension)) {
      return type;
    }
  }
  throw new Error("Document type mismatch");
}

function extractText(buffer: Buffer, type: "text" | "markdown", metadata: PrivateDocumentMetadata): PrivateExtractionResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("Text unavailable");
  }
  text = normalizeText(text);
  if (isRawHtml(text) || hasDisallowedTextControl(text)) throw new Error("Document type mismatch");
  return finalize(type, titleFromMetadata(metadata, type === "markdown" ? "Markdown document" : "Text document"), text);
}

async function extractDocx(buffer: Buffer, metadata: PrivateDocumentMetadata): Promise<PrivateExtractionResult> {
  const preflight = await preflightDocx(buffer);
  if (
    /macroenabled|vbaproject|template\.main|application\/vnd\.ms-word|attachedtemplate|external/iu.test(preflight.contentTypes) ||
    [...preflight.relationships.values()].some((xml) => /targetmode\s*=\s*["']external["']|attachedtemplate|external/iu.test(xml))
  ) {
    throw new Error("Unsafe document");
  }

  let result: { value?: unknown };
  try {
    const mammoth = await import("mammoth");
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw new Error("Text unavailable");
  }
  const text = typeof result.value === "string" ? normalizeText(result.value) : "";
  if (!text) throw new Error("Text unavailable");
  return finalize("docx", titleFromMetadata(metadata, "DOCX document"), text);
}

function preflightDocx(buffer: Buffer): Promise<ZipPreflight> {
  return new Promise((resolve, reject) => {
    let zip: yauzl.ZipFile | undefined;
    let settled = false;
    let entryCount = 0;
    let totalExpanded = 0;
    const names = new Set<string>();
    const xmlParts = new Map<string, string>();

    const fail = (error: Error = new Error("Unsafe document")) => {
      if (settled) return;
      settled = true;
      zip?.close();
      reject(error.message === "Unsafe document" ? error : new Error("Unsafe document"));
    };
    const finish = () => {
      if (settled) return;
      if (!names.has("[Content_Types].xml") || !names.has("_rels/.rels") || !names.has("word/document.xml")) {
        fail();
        return;
      }
      settled = true;
      resolve({
        contentTypes: xmlParts.get("[Content_Types].xml") ?? "",
        relationships: new Map([...xmlParts.entries()].filter(([name]) => name.endsWith(".rels"))),
      });
    };

    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, opened) => {
      if (error || !opened) {
        fail();
        return;
      }
      zip = opened;
      opened.on("error", () => fail());
      opened.on("end", finish);
      opened.on("entry", (entry) => {
        if (settled) return;
        entryCount += 1;
        if (
          entryCount > DOCX_MAX_ENTRIES ||
          entry.fileName.length === 0 ||
          entry.fileName.startsWith("/") ||
          /^[A-Za-z]:\//u.test(entry.fileName) ||
          entry.fileName.includes("\\") ||
          entry.fileName.split("/").some((part: string) => part === "." || part === "..") ||
          isSymlink(entry) ||
          entry.isEncrypted() ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          entry.uncompressedSize > DOCX_MAX_ENTRY_BYTES ||
          (entry.compressedSize === 0 && entry.uncompressedSize > 0) ||
          entry.uncompressedSize / Math.max(entry.compressedSize, 1) > DOCX_MAX_COMPRESSION_RATIO ||
          hasForbiddenDocxPart(entry.fileName)
        ) {
          fail();
          return;
        }
        totalExpanded += entry.uncompressedSize;
        if (totalExpanded > DOCX_MAX_TOTAL_BYTES) {
          fail();
          return;
        }
        names.add(entry.fileName);
        opened.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail();
            return;
          }
          void consumeZipEntry(stream, entry.fileName, (part) => {
            if (part !== undefined) xmlParts.set(entry.fileName, part);
          }).then(() => {
            if (!settled) opened.readEntry();
          }).catch(() => fail());
        });
      });
      opened.readEntry();
    });
  });
}

async function consumeZipEntry(
  stream: Readable,
  name: string,
  onXml: (part: string | undefined) => void,
): Promise<void> {
  const shouldReadXml = name === "[Content_Types].xml" || name.endsWith(".rels");
  const shouldScanXml = shouldReadXml || name.endsWith(".xml");
  let read = 0;
  const chunks: Buffer[] = [];
  let markerTail = "";
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    read += bytes.byteLength;
    if (read > DOCX_MAX_ENTRY_BYTES) throw new Error("Unsafe document");
    if (shouldScanXml) {
      const markerScan = `${markerTail}${bytes.toString("utf8")}`.toLowerCase();
      if (markerScan.includes("altchunk") || markerScan.includes("vbaproject") || markerScan.includes("activex") || markerScan.includes("oleobject")) {
        throw new Error("Unsafe document");
      }
      markerTail = markerScan.slice(-64);
    }
    if (shouldReadXml) {
      if (read > DOCX_MAX_XML_BYTES) throw new Error("Unsafe document");
      chunks.push(bytes);
    }
  }
  if (shouldReadXml) onXml(Buffer.concat(chunks).toString("utf8"));
}

function isSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function hasForbiddenDocxPart(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("vbaproject") ||
    lower.includes("activex") ||
    lower.includes("embeddings/") ||
    lower.includes("oleobject") ||
    lower.includes("altchunk") ||
    lower.includes("attachedtemplate") ||
    lower.endsWith(".docm") ||
    lower.endsWith(".dotm") ||
    lower.endsWith(".dotx")
  );
}

async function extractPdf(buffer: Buffer, metadata: PrivateDocumentMetadata): Promise<PrivateExtractionResult> {
  if (hasUnsafePdfMarker(buffer)) throw new Error("Unsafe document");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > PDF_MAX_PAGES) throw new Error("PDF page limit exceeded");
    const [openAction, attachments, documentActions] = await Promise.all([
      document.getOpenAction(),
      document.getAttachments(),
      document.getJSActions(),
    ]);
    if (openAction || attachments || hasActionValue(documentActions)) throw new Error("Unsafe document");

    const parts: string[] = [];
    let total = 0;
    let hasText = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const [content, annotations, pageActions] = await Promise.all([
          page.getTextContent(),
          page.getAnnotations({ intent: "display" }),
          page.getJSActions(),
        ]);
        if (hasActionValue(pageActions) || annotations.some(hasActiveAnnotation)) throw new Error("Unsafe document");
        const items = content.items.map((item) => ({
          str: "str" in item && typeof item.str === "string" ? item.str : "",
          hasEOL: "hasEOL" in item && item.hasEOL === true,
        }));
        const follows = new Array<boolean>(items.length);
        let following = false;
        for (let index = items.length - 1; index >= 0; index -= 1) {
          follows[index] = following;
          if (items[index].str.length > 0) following = true;
        }
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item.str.length > 0) {
            total += item.str.length;
            if (total > MAX_TEXT_CODE_UNITS) throw new Error("Text unavailable");
            parts.push(item.str);
            hasText = true;
          }
          if (follows[index] && (item.hasEOL || item.str.length > 0)) {
            total += 1;
            if (total > MAX_TEXT_CODE_UNITS) throw new Error("Text unavailable");
            parts.push(item.hasEOL ? "\n" : " ");
          }
        }
      } finally {
        page.cleanup();
      }
    }
    if (!hasText) throw new Error("Text unavailable");
    const metadataResult = await document.getMetadata().catch(() => undefined);
    const info = metadataResult && typeof metadataResult === "object" && "info" in metadataResult && metadataResult.info && typeof metadataResult.info === "object"
      ? metadataResult.info as Record<string, unknown>
      : undefined;
    const pdfTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
    return finalize("pdf", pdfTitle || titleFromMetadata(metadata, "PDF document"), parts.join(""));
  } catch (error) {
    if (error instanceof Error && (/Unsafe document|page limit|Text unavailable/u.test(error.message))) throw error;
    throw new Error("Text unavailable");
  } finally {
    if (document) await document.cleanup();
    await loadingTask.destroy();
  }
}

function hasUnsafePdfMarker(buffer: Buffer): boolean {
  const source = buffer.toString("latin1");
  return /\/(?:OpenAction|AA|JavaScript|JS|EmbeddedFiles|Filespec|EF|AF|RichMedia|FileAttachment|Launch|SubmitForm|ImportData|GoToR|GoToE)\b/iu.test(source) ||
    /\/S\s*\/(?:JavaScript|Launch|SubmitForm|ImportData|GoToR|GoToE|Rendition|Movie|Sound)\b/iu.test(source);
}

function hasActionValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "object") return false;
  return Reflect.ownKeys(value).length > 0;
}

function hasActiveAnnotation(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasActiveAnnotation);
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:action|js|javascript|unsafeurl|url|attachment|file|filename)$/iu.test(key)) return true;
    if (key === "hasJSActions" && child === true) return true;
    if (typeof child === "object" && hasActiveAnnotation(child)) return true;
  }
  return false;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function isRawHtml(value: string): boolean {
  return /^(?:<!doctype\s+html\b|<!--|<html(?:\s|>)|<\/?[A-Za-z][\w:-]*(?:\s|\/?>))/iu.test(value);
}

function hasDisallowedTextControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function titleFromMetadata(metadata: PrivateDocumentMetadata, fallback: string): string {
  const name = metadata.fileName.replace(/^.*[\\/]/u, "").replace(/\.[^.]+$/u, "").trim();
  return name && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : fallback;
}

function finalize(type: PrivateDocumentType, title: string, text: string): PrivateExtractionResult {
  const normalizedText = normalizeText(text);
  try {
    return validatePrivateExtractionResult({ type, title, text: normalizedText });
  } catch {
    if (title !== "Text document" && title !== "Markdown document" && title !== "DOCX document" && title !== "PDF document") {
      const fallback = type === "text" ? "Text document" : type === "markdown" ? "Markdown document" : type === "docx" ? "DOCX document" : "PDF document";
      try {
        return validatePrivateExtractionResult({ type, title: fallback, text: normalizedText });
      } catch {
        throw new Error("Text unavailable");
      }
    }
    throw new Error("Text unavailable");
  }
}

if (parentPort) {
  parentPort.on("message", (message: { bytes: ArrayBuffer; metadata: PrivateDocumentMetadata }) => {
    void extractPrivateDocument(new Uint8Array(message.bytes), message.metadata)
      .then((result) => parentPort!.postMessage({ ok: true, result }))
      .catch(() => parentPort!.postMessage({ ok: false, error: "Private document extraction failed" }));
  });
}
