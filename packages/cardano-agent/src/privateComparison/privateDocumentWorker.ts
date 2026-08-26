import { fileTypeFromBuffer } from "file-type";
import * as yauzl from "yauzl";
import { Readable } from "node:stream";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_TEXT_BYTES,
  PrivateDocumentExtractionError,
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
const PDF_MAX_INTEGER_OBJECTS = 4_096;
const PDF_MAX_NAME_TOKEN_BYTES = 128;

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

type XmlTag = Readonly<{
  name: string;
  attributes: ReadonlyMap<string, string>;
}>;

export async function extractPrivateDocument(
  bytes: Uint8Array,
  metadata: PrivateDocumentMetadata,
): Promise<PrivateExtractionResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PRIVATE_DOCUMENT_MAX_BYTES) {
    throw new PrivateDocumentExtractionError("unsupported", "Private document input must be between 1 byte and 20 MiB");
  }
  const advisoryType = advisoryDocumentType(metadata);
  const buffer = Buffer.from(bytes);
  const detected = await fileTypeFromBuffer(buffer);

  if (detected?.ext === "pdf") {
    if (advisoryType !== "pdf") throw new PrivateDocumentExtractionError("spoofed", "Document type mismatch");
    return extractPdf(buffer, metadata);
  }
  if (detected?.ext === "zip" || detected?.ext === "docx") {
    if (advisoryType !== "docx") throw new PrivateDocumentExtractionError("spoofed", "Document type mismatch");
    return extractDocx(buffer, metadata);
  }
  if (detected !== undefined) throw new PrivateDocumentExtractionError("unsupported", "Document type mismatch");
  if (advisoryType !== "text" && advisoryType !== "markdown") {
    throw new PrivateDocumentExtractionError("unsupported", "Document type mismatch");
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
  throw new PrivateDocumentExtractionError("unsupported", "Document type mismatch");
}

function extractText(buffer: Buffer, type: "text" | "markdown", metadata: PrivateDocumentMetadata): PrivateExtractionResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
  }
  text = normalizeText(text);
  if (isRawHtml(text) || hasDisallowedTextControl(text)) throw new PrivateDocumentExtractionError("unsafe", "Document type mismatch");
  return finalize(type, titleFromMetadata(metadata, type === "markdown" ? "Markdown document" : "Text document"), text);
}

async function extractDocx(buffer: Buffer, metadata: PrivateDocumentMetadata): Promise<PrivateExtractionResult> {
  const preflight = await preflightDocx(buffer);
  inspectDocxStructure(preflight);

  let result: { value?: unknown };
  try {
    const mammoth = await import("mammoth");
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
  }
  const text = typeof result.value === "string" ? normalizeText(result.value) : "";
  if (!text) throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
  return finalize("docx", titleFromMetadata(metadata, "DOCX document"), text);
}

function inspectDocxStructure(preflight: ZipPreflight): void {
  const contentTypes = parseXml(preflight.contentTypes, "Types");
  const mainType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const mainDocument = contentTypes.find((tag) =>
    localXmlName(tag.name) === "Override" &&
    normalizePartName(tag.attributes.get("PartName")) === "word/document.xml" &&
    tag.attributes.get("ContentType") === mainType
  );
  if (!mainDocument || contentTypes.some((tag) => hasForbiddenDocxSemanticName(tag.attributes.get("ContentType")))) {
    throw new Error("Unsafe document");
  }

  const rootRelationships = parseXml(preflight.relationships.get("_rels/.rels") ?? "", "Relationships")
    .filter((tag) => localXmlName(tag.name) === "Relationship");
  const officeDocumentType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
  const officeDocumentRelationships = rootRelationships.filter((tag) => tag.attributes.get("Type") === officeDocumentType);
  if (
    officeDocumentRelationships.length !== 1 ||
    normalizePartName(officeDocumentRelationships[0]?.attributes.get("Target")) !== "word/document.xml"
  ) {
    throw new Error("Unsafe document");
  }

  for (const xml of preflight.relationships.values()) {
    for (const relationship of parseXml(xml, "Relationships")) {
      if (localXmlName(relationship.name) !== "Relationship") continue;
      const type = relationship.attributes.get("Type")?.toLowerCase() ?? "";
      const target = relationship.attributes.get("Target")?.toLowerCase() ?? "";
      const mode = relationship.attributes.get("TargetMode")?.toLowerCase() ?? "";
      if (
        mode === "external" || /^(?:https?:|file:|data:)/u.test(target) ||
        hasForbiddenDocxSemanticName(type) || hasForbiddenDocxSemanticName(target)
      ) {
        throw new Error("Unsafe document");
      }
    }
  }
}

function hasForbiddenDocxSemanticName(value: string | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return /(?:macroenabled|template|vnd\.ms-word|vbaproject|activex|oleobject|afchunk|attachedtemplate)/u.test(normalized) || normalized.endsWith("/package");
}

function parseXml(xml: string, expectedRoot: string): XmlTag[] {
  if (xml.length > DOCX_MAX_XML_BYTES) {
    throw new Error("Unsafe document");
  }
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/gu, "");
  if (/<!--|-->/u.test(withoutComments)) throw new Error("Unsafe document");
  const withoutProcessingInstructions = withoutComments.replace(/<\?[\s\S]*?\?>/gu, "");
  if (/<\?/u.test(withoutProcessingInstructions)) throw new Error("Unsafe document");
  if (/<!/u.test(withoutProcessingInstructions)) throw new Error("Unsafe document");
  const tags: XmlTag[] = [];
  const tagPattern = /<\s*([A-Za-z_][\w:.-]*)([^<>]*?)(?:\/\s*)?>/gu;
  for (const match of withoutProcessingInstructions.matchAll(tagPattern)) {
    const attributes = parseXmlAttributes(match[2] ?? "");
    tags.push({ name: match[1]!, attributes });
  }
  if (tags.length === 0 || localXmlName(tags[0]!.name) !== expectedRoot) throw new Error("Unsafe document");
  return tags;
}

function parseXmlAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  let offset = 0;
  const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gy;
  while (offset < source.length) {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
    if (offset >= source.length) break;
    attributePattern.lastIndex = offset;
    const match = attributePattern.exec(source);
    if (!match || attributes.has(match[1]!)) throw new Error("Unsafe document");
    attributes.set(match[1]!, decodeXmlAttribute(match[3]!));
    offset = attributePattern.lastIndex;
  }
  return attributes;
}

function decodeXmlAttribute(value: string): string {
  const entityPattern = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu;
  let output = "";
  let offset = 0;
  for (const match of value.matchAll(entityPattern)) {
    if (value.slice(offset, match.index).includes("&")) throw new Error("Unsafe document");
    output += value.slice(offset, match.index);
    const body = match[1]!;
    if (body === "amp") output += "&";
    else if (body === "lt") output += "<";
    else if (body === "gt") output += ">";
    else if (body === "quot") output += "\"";
    else if (body === "apos") output += "'";
    else {
      const codePoint = body.toLowerCase().startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) throw new Error("Unsafe document");
      output += String.fromCodePoint(codePoint);
    }
    offset = (match.index ?? 0) + match[0].length;
  }
  if (value.slice(offset).includes("&")) throw new Error("Unsafe document");
  return output + value.slice(offset);
}

function localXmlName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function normalizePartName(value: string | undefined): string {
  if (!value) return "";
  const parts = value.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.some((part) => part === "..")) return "";
  return parts.filter((part) => part !== ".").join("/");
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
      const result = {
        contentTypes: xmlParts.get("[Content_Types].xml") ?? "",
        relationships: new Map([...xmlParts.entries()].filter(([name]) => name.endsWith(".rels"))),
      };
      settled = true;
      zip?.close();
      resolve(result);
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
      if (markerScan.includes("altchunk") || markerScan.includes("vbaproject") || markerScan.includes("activex") || markerScan.includes("oleobject") || markerScan.includes("attachedtemplate")) {
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
  if (hasUnsafePdfSyntax(buffer)) throw new Error("Unsafe document");
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
    if (document.numPages < 1 || document.numPages > PDF_MAX_PAGES) throw new PrivateDocumentExtractionError("unsupported", "PDF page limit exceeded");
    const [openAction, attachments, documentActions] = await Promise.all([
      document.getOpenAction(),
      document.getAttachments(),
      document.getJSActions(),
    ]);
    if (openAction || attachments || hasActionValue(documentActions)) throw new Error("Unsafe document");

    const parts: string[] = [];
    let total = 0;
    let hasText = false;
    let pageBreakPending = false;
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
        const hasPageContent = items.some((item) => item.str.length > 0 || item.hasEOL === true);
        if (pageBreakPending && hasPageContent) {
          total += 1;
          if (total > MAX_TEXT_CODE_UNITS) throw new Error("Text unavailable");
          parts.push("\n");
          pageBreakPending = false;
        }
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
        if (hasPageContent && pageNumber < document.numPages) pageBreakPending = true;
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
    if (error instanceof PrivateDocumentExtractionError) throw error;
    if (error instanceof Error && (/Unsafe document|page limit|Text unavailable/u.test(error.message))) throw error;
    throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
  } finally {
    if (document) await document.cleanup();
    await loadingTask.destroy();
  }
}

function hasUnsafePdfSyntax(buffer: Buffer): boolean {
  return pdfNameTokens(buffer);
}

function collectPdfIntegerObjects(source: string): ReadonlyMap<number, number> | undefined {
  const objects = new Map<number, number>();
  const objectPattern = /(?:^|[\r\n])(\d+)[ \t]+0[ \t]+obj[ \t\r\n]+(-?\d+)[ \t\r\n]+endobj(?=[ \t\r\n]|$)/gu;
  for (const match of source.matchAll(objectPattern)) {
    const objectNumber = Number(match[1]);
    const value = Number(match[2]);
    if (
      !Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(value) ||
      objectNumber < 0 || objectNumber > 0x7fffffff || objects.has(objectNumber) || objects.size >= PDF_MAX_INTEGER_OBJECTS
    ) return undefined;
    objects.set(objectNumber, value);
  }
  return objects;
}

function pdfNameTokens(buffer: Buffer): boolean {
  const source = buffer.toString("latin1");
  const integerObjects = collectPdfIntegerObjects(source);
  if (!integerObjects) return true;
  type PdfValue = Readonly<{ kind: "number" | "name" | "container" | "other"; value?: number }>;
  type PdfDictionary = {
    pendingKey?: string;
    lengthValue?: number;
    lengthSeen: boolean;
    malformed: boolean;
    topLevel: boolean;
    endOffset: number;
    lastAssigned?: { key: string; kind: PdfValue["kind"]; value?: number };
    referencePending: boolean;
    referenceGeneration?: number;
  };
  type PdfContainer = { kind: "dict"; dictionary: PdfDictionary } | { kind: "array" };
  const containers: PdfContainer[] = [];
  let streamCandidate: PdfDictionary | undefined;
  let index = 0;

  const unsafe = () => true;
  const current = (): PdfContainer | undefined => containers[containers.length - 1];
  const assign = (value: PdfValue) => {
    const container = current();
    if (container?.kind !== "dict") return;
    if (container.dictionary.pendingKey === undefined) {
      if (value.kind === "number" && container.dictionary.lastAssigned?.kind === "number") {
        container.dictionary.referencePending = true;
        container.dictionary.referenceGeneration = value.value;
      }
      return;
    }
    const key = container.dictionary.pendingKey;
    if (key === "Length") {
      if (container.dictionary.lengthSeen) container.dictionary.malformed = true;
      container.dictionary.lengthSeen = true;
      if (value.kind === "number") container.dictionary.lengthValue = value.value;
    }
    container.dictionary.lastAssigned = { key, kind: value.kind, value: value.value };
    container.dictionary.referencePending = false;
    container.dictionary.referenceGeneration = undefined;
    container.dictionary.pendingKey = undefined;
  };
  const inspectName = (name: string): boolean => {
    const container = current();
    if (name === "A" || name === "AA") {
      if (container?.kind === "dict") return true;
    }
    if (name === "ObjStm") return true;
    if (name === "OpenAction" && container?.kind === "dict" && container.dictionary.pendingKey === undefined) return true;
    if (container?.kind === "dict" && container.dictionary.pendingKey === "Type" && name === "ObjStm") return true;
    if (container?.kind === "dict" && container.dictionary.pendingKey === "S" && ACTION_TYPES.has(name)) return true;
    if (GLOBAL_ACTIVE_NAMES.has(name)) return true;
    return false;
  };

  while (index < source.length) {
    const character = source[index]!;
    if (/\s|\x00/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "%") {
      index = skipPdfComment(source, index + 1);
      continue;
    }
    if (character === "(") {
      index = skipPdfLiteralString(source, index);
      assign({ kind: "other" });
      streamCandidate = undefined;
      continue;
    }
    if (character === "<" && source[index + 1] !== "<") {
      index = skipPdfHexString(source, index);
      assign({ kind: "other" });
      streamCandidate = undefined;
      continue;
    }
    if (source.startsWith("<<", index)) {
      containers.push({ kind: "dict", dictionary: { malformed: false, topLevel: containers.length === 0, endOffset: 0, lengthSeen: false, referencePending: false } });
      index += 2;
      streamCandidate = undefined;
      continue;
    }
    if (source.startsWith(">>", index)) {
      const container = containers.pop();
      if (!container || container.kind !== "dict" || container.dictionary.pendingKey !== undefined || container.dictionary.referencePending) return unsafe();
      const dictionary = container.dictionary;
      dictionary.endOffset = index + 2;
      if (containers.length > 0) assign({ kind: "container" });
      streamCandidate = dictionary;
      index += 2;
      continue;
    }
    if (character === "[") {
      containers.push({ kind: "array" });
      streamCandidate = undefined;
      index += 1;
      continue;
    }
    if (character === "]") {
      const container = containers.pop();
      if (!container || container.kind !== "array") return unsafe();
      if (containers.length > 0) assign({ kind: "container" });
      streamCandidate = undefined;
      index += 1;
      continue;
    }
    if (character === "/") {
      let end = index + 1;
      while (end < source.length && !/[\s\x00\[\]()<>/%]/u.test(source[end]!)) end += 1;
      if (end === index + 1) {
        index += 1;
        streamCandidate = undefined;
        continue;
      }
      if (end - index - 1 > PDF_MAX_NAME_TOKEN_BYTES) {
        streamCandidate = undefined;
        index = end;
        continue;
      }
      const name = decodePdfName(source.slice(index + 1, end));
      if (inspectName(name)) return unsafe();
      const container = current();
      if (container?.kind === "dict") {
        if (container.dictionary.pendingKey === undefined) {
          if (container.dictionary.referencePending) container.dictionary.malformed = true;
          container.dictionary.referencePending = false;
          container.dictionary.pendingKey = name;
        }
        else assign({ kind: "name" });
      }
      streamCandidate = undefined;
      index = end;
      continue;
    }
    const wordStart = index;
    while (index < source.length && !/[\s\x00\[\]()<>/%]/u.test(source[index]!)) index += 1;
    const word = source.slice(wordStart, index);
    if (/^-?\d+$/u.test(word)) {
      assign({ kind: "number", value: Number(word) });
      streamCandidate = undefined;
      continue;
    }
    if (word === "stream") {
      if (!streamCandidate || !streamCandidate.topLevel || streamCandidate.malformed) return unsafe();
      const gap = source.slice(streamCandidate.endOffset ?? 0, wordStart);
      if (!/^[ \t]*(?:\r\n|\r|\n)$/u.test(gap)) return unsafe();
      const lengthValue = streamCandidate.lengthValue;
      if (lengthValue === undefined || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > PRIVATE_DOCUMENT_MAX_BYTES) return unsafe();
      const streamStart = skipPdfLineEnding(source, index);
      if (streamStart === index) return unsafe();
      const contentEnd = streamStart + lengthValue;
      if (contentEnd > source.length) return unsafe();
      let endStream = contentEnd;
      if (source.startsWith("\r\n", endStream)) endStream += 2;
      else if (source[endStream] === "\r" || source[endStream] === "\n") endStream += 1;
      if (!source.startsWith("endstream", endStream) || !isPdfDelimiter(source[endStream + 9])) return unsafe();
      index = endStream + 9;
      streamCandidate = undefined;
      continue;
    }
    const unrecognizedContainer = current();
    if (unrecognizedContainer?.kind === "dict" && word === "R" && unrecognizedContainer.dictionary.referencePending) {
      if (unrecognizedContainer.dictionary.lastAssigned?.key === "Length") {
        if (unrecognizedContainer.dictionary.referenceGeneration !== 0 || unrecognizedContainer.dictionary.lastAssigned.value === undefined) {
          unrecognizedContainer.dictionary.malformed = true;
        } else {
          const resolvedLength = integerObjects.get(unrecognizedContainer.dictionary.lastAssigned.value);
          if (resolvedLength === undefined) unrecognizedContainer.dictionary.malformed = true;
          else unrecognizedContainer.dictionary.lengthValue = resolvedLength;
        }
      }
      unrecognizedContainer.dictionary.referencePending = false;
      unrecognizedContainer.dictionary.referenceGeneration = undefined;
    } else if (unrecognizedContainer?.kind === "dict") {
      unrecognizedContainer.dictionary.malformed = true;
    }
    streamCandidate = undefined;
  }
  if (containers.length > 0) return unsafe();
  return false;
}

const ACTION_TYPES = new Set([
  "JavaScript", "Launch", "SubmitForm", "ImportData", "GoTo", "GoToR", "GoToE", "Rendition", "Movie", "Sound", "ResetForm",
  "Thread", "URI", "Hide", "Named", "Trans", "GoTo3DView", "RichMediaExecute",
]);
const GLOBAL_ACTIVE_NAMES = new Set(["JavaScript", "JS", "EmbeddedFiles", "Filespec", "EF", "AF", "RichMedia", "FileAttachment"]);

function isPdfDelimiter(value: string | undefined): boolean {
  return value === undefined || /[\s\x00\[\]()<>/%]/u.test(value);
}

function skipPdfComment(source: string, index: number): number {
  while (index < source.length && source[index] !== "\r" && source[index] !== "\n") index += 1;
  return index;
}

function skipPdfLiteralString(source: string, index: number): number {
  let depth = 1;
  index += 1;
  while (index < source.length && depth > 0) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === "(") {
      depth += 1;
      index += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      index += 1;
    } else index += 1;
  }
  return index;
}

function skipPdfHexString(source: string, index: number): number {
  index += 1;
  while (index < source.length && source[index] !== ">") index += 1;
  return Math.min(index + 1, source.length);
}

function skipPdfLineEnding(source: string, index: number): number {
  if (source[index] === "\r" && source[index + 1] === "\n") return index + 2;
  return source[index] === "\r" || source[index] === "\n" ? index + 1 : index;
}

function decodePdfName(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      decoded += value[index];
    }
  }
  return decoded;
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
    if (/^(?:action|js|javascript|unsafeurl|url|attachment|file|filename|dest)$/iu.test(key)) return true;
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
        throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
      }
    }
    throw new PrivateDocumentExtractionError("text-unavailable", "Text unavailable");
  }
}
