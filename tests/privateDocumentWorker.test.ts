import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { extractPrivateDocument } from "../packages/cardano-agent/src/privateComparison/privateDocumentWorker.js";
import { PRIVATE_DOCUMENT_MAX_BYTES, PRIVATE_DOCUMENT_MAX_CODE_POINTS } from "../packages/cardano-agent/src/privateComparison/privateDocumentProtocol.js";

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

type ZipEntry = { name: string; data: Buffer; flags?: number; attributes?: number; declaredSize?: number; declaredCompressedSize?: number; compressionLevel?: number };

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data, entry.compressionLevel === undefined ? undefined : { level: entry.compressionLevel });
    const flags = entry.flags ?? 0;
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = entry.declaredSize ?? entry.data.length;
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc32(entry.data), 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    name.copy(localHeader, 30);
    local.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc32(entry.data), 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.attributes ?? 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    central.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const DOCX_CONTENT_TYPES = "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>";
const DOCX_ROOT_RELS = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
const DOCX_DOCUMENT = "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Cardano document</w:t></w:r></w:p></w:body></w:document>";

function docx(extra: ZipEntry[] = [], contentTypes = DOCX_CONTENT_TYPES, rootRels = DOCX_ROOT_RELS): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "word/document.xml", data: Buffer.from(DOCX_DOCUMENT) },
    ...extra,
  ]);
}

function pdf(options: { text?: string; pages?: string[]; catalog?: string; page?: string; extraObjects?: string[]; objectStream?: boolean; indirectLength?: boolean } = {}): Uint8Array {
  const content = options.text === undefined ? "BT /F1 18 Tf 72 720 Td (Cardano PDF) Tj ET" : options.text;
  const pageContents = options.pages?.map((text) => `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`) ?? [content];
  const pageCount = pageContents.length;
  const fontObject = pageCount + 3;
  const contentObject = fontObject + 1;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ""}>>`,
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageContents.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject + index} 0 R ${options.page ?? ""}>>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageContents.map((pageContent) => `<< /Length ${options.indirectLength ? `${contentObject + pageContents.length} 0 R` : Buffer.byteLength(pageContent)} >>\nstream\n${pageContent}\nendstream`),
    ...(options.indirectLength ? [`${Buffer.byteLength(pageContents[0]!)}\n`] : []),
    ...(options.extraObjects ?? []),
  ];
  if (options.objectStream) {
    const objectStreamBody = Buffer.from("6 0 << /A << /S /GoTo /D [3 0 R /Fit] >> >>");
    const compressedBody = deflateRawSync(objectStreamBody);
    objects.push(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressedBody.length} >>\nstream\n${compressedBody.toString("latin1")}\nendstream`);
  }
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

describe("private document worker", () => {
  it("extracts strict UTF-8 text and Markdown from matching advisory metadata", async () => {
    await expect(extractPrivateDocument(textBytes("Cardano uses proof of stake."), {
      fileName: "claim.txt",
      mime: "text/plain",
    })).resolves.toMatchObject({
      type: "text",
      text: "Cardano uses proof of stake.",
    });

    await expect(extractPrivateDocument(textBytes("# Consensus\n\nOuroboros"), {
      fileName: "claim.md",
      mime: "text/markdown",
    })).resolves.toMatchObject({
      type: "markdown",
      text: "# Consensus\n\nOuroboros",
    });
  });

  it("requires exact input bounds, strict UTF-8, and matching type metadata", async () => {
    const exact = Buffer.concat([Buffer.from("Cardano"), Buffer.alloc(PRIVATE_DOCUMENT_MAX_BYTES - 7, 0x20)]);
    await expect(extractPrivateDocument(exact, { fileName: "claim.txt", mime: "text/plain" })).resolves.toMatchObject({ type: "text", text: "Cardano" });
    await expect(extractPrivateDocument(Buffer.concat([exact, Buffer.from("x")]), { fileName: "claim.txt", mime: "text/plain" })).rejects.toThrow(/20 MiB/);
    await expect(extractPrivateDocument(Buffer.from([0xc3, 0x28]), { fileName: "claim.txt", mime: "text/plain" })).rejects.toThrow(/Text unavailable/);
    await expect(extractPrivateDocument(pdf(), { fileName: "fake.txt", mime: "text/plain" })).rejects.toThrow(/Document type mismatch/);
    await expect(extractPrivateDocument(textBytes("<div>not a text upload</div>"), { fileName: "claim.txt", mime: "text/plain" })).rejects.toThrow(/Document type mismatch/);
  });

  it("preflights DOCX archives before raw text extraction", async () => {
    await expect(extractPrivateDocument(docx(), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).resolves.toMatchObject({ type: "docx", text: "Cardano document" });

    await expect(extractPrivateDocument(docx([{ name: "word/_rels/document.xml.rels", data: Buffer.from("<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.test\"/></Relationships>") }]), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(docx([{ name: "word/vbaProject.bin", data: Buffer.from("macro") }]), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(docx([{ name: "word/document.xml", data: Buffer.alloc(16 * 1024 * 1024 + 1) }]), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);
  }, 15_000);

  it("rejects ambiguous OOXML relationships and structurally non-Word ZIPs", async () => {
    const externalEntity = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship TargetMode=\"Ext&#x65;rnal\" Target=\"https://example.test\"/></Relationships>";
    await expect(extractPrivateDocument(docx([{ name: "word/_rels/document.xml.rels", data: Buffer.from(externalEntity) }]), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);

    const packageRelationship = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/package\" Target=\"word/embedded.bin\"/></Relationships>";
    await expect(extractPrivateDocument(docx([{ name: "word/_rels/document.xml.rels", data: Buffer.from(packageRelationship) }]), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);

    const wrongRoot = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"urn:not-a-word-document\" Target=\"word/document.xml\"/></Relationships>";
    await expect(extractPrivateDocument(docx([], DOCX_CONTENT_TYPES, wrongRoot), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);

    const duplicateRoot = DOCX_ROOT_RELS.replace("</Relationships>", "<Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"./word/document.xml\"/></Relationships>");
    await expect(extractPrivateDocument(docx([], DOCX_CONTENT_TYPES, duplicateRoot), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);

    const nonWordContentTypes = DOCX_CONTENT_TYPES.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/xml");
    await expect(extractPrivateDocument(docx([], nonWordContentTypes), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);

    for (const type of ["oleObject", "vbaProject", "activeX", "aFChunk", "attachedTemplate"]) {
      const relationship = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="word/part.bin"/></Relationships>`;
      await expect(extractPrivateDocument(docx([{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationship) }]), {
        fileName: "claim.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })).rejects.toThrow(/Unsafe document/);
    }
    for (const type of ["oleObj&#x65;ct", "activ&#x65;X", "vbaProj&#x65;ct", "aFChun&#x6B;"]) {
      const encodedForbidden = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="word/part.bin"/></Relationships>`;
      await expect(extractPrivateDocument(docx([{ name: "word/_rels/document.xml.rels", data: Buffer.from(encodedForbidden) }]), {
        fileName: "claim.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })).rejects.toThrow(/Unsafe document/);
    }
    const encodedMacroContentTypes = DOCX_CONTENT_TYPES.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.macro&#x45;nabled.main+xml");
    await expect(extractPrivateDocument(docx([], encodedMacroContentTypes), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);
    const templateContentTypes = DOCX_CONTENT_TYPES.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml");
    await expect(extractPrivateDocument(docx([], templateContentTypes), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document|Document type mismatch/);

    const decoratedContentTypes = `<?xml version="1.0"?>\n<!-- SYSTEM <NotTypes/> -->${DOCX_CONTENT_TYPES}`;
    const decoratedRootRels = `<!-- PUBLIC <NotRelationships/> --><?xml version="1.0"?>${DOCX_ROOT_RELS}`;
    await expect(extractPrivateDocument(docx([], decoratedContentTypes, decoratedRootRels), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).resolves.toMatchObject({ type: "docx" });

    const entityContentTypes = `<!DOCTYPE Types [<!ENTITY x SYSTEM "https://example.test/entity">]>${DOCX_CONTENT_TYPES}`;
    await expect(extractPrivateDocument(docx([], entityContentTypes), {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toThrow(/Unsafe document/);
  });

  it("rejects the bounded ZIP attack matrix", async () => {
    const metadata = {
      fileName: "claim.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    for (const name of ["../escape", "/escape", "C:/escape", "word/../escape", "word/./escape", "word\\escape"]) {
      await expect(extractPrivateDocument(docx([{ name, data: Buffer.from("x") }]), metadata)).rejects.toThrow(/Unsafe document/);
    }
    await expect(extractPrivateDocument(docx([{ name: "encrypted.bin", data: Buffer.from("x"), flags: 1 }]), metadata)).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(docx([{ name: "ratio.bin", data: Buffer.alloc(10_000, 0x41) }]), metadata)).rejects.toThrow(/Unsafe document/);
    const declaredExpanded = 13 * 1024 * 1024;
    await expect(extractPrivateDocument(docx(Array.from({ length: 5 }, (_, index) => ({
      name: `word/expanded-${index}.bin`,
      data: Buffer.from("x"),
      declaredSize: declaredExpanded,
      declaredCompressedSize: Math.ceil(declaredExpanded / 100),
    }))), metadata)).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(docx([{ name: "word/link", data: Buffer.from("x"), attributes: 0xa0000000 }]), metadata)).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(docx(Array.from({ length: 2_046 }, (_, index) => ({ name: `word/extra-${index}.xml`, data: Buffer.from("x") }))), metadata)).rejects.toThrow(/Unsafe document/);
    for (const name of ["word/activeX/active.bin", "word/embeddings/oleObject1.bin", "word/altChunk1.xml"]) {
      await expect(extractPrivateDocument(docx([{ name, data: Buffer.from("x") }]), metadata)).rejects.toThrow(/Unsafe document/);
    }
    await expect(extractPrivateDocument(docx([{ name: "word/settings.xml", data: Buffer.from("<w:attachedTemplate xmlns:w=\"urn:w\"/>") }]), metadata)).rejects.toThrow(/Unsafe document/);
    const block = Buffer.alloc(1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < block.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      block[index] = (state & 1) === 0 ? 0x41 : 0x42;
    }
    const expanded = Buffer.concat(Array.from({ length: 16 }, () => block));
    await expect(extractPrivateDocument(docx([
      ...Array.from({ length: 4 }, (_, index) => ({ name: `word/actual-expanded-${index}.bin`, data: expanded, compressionLevel: 1 })),
      { name: "word/actual-expanded-overflow.bin", data: Buffer.from("x") },
    ]), metadata)).rejects.toThrow(/Unsafe document/);
  }, 15_000);

  it("rejects active and scanned PDFs while extracting text PDFs", async () => {
    await expect(extractPrivateDocument(pdf(), { fileName: "claim.pdf", mime: "application/pdf" })).resolves.toMatchObject({ type: "pdf", text: "Cardano PDF" });
    await expect(extractPrivateDocument(pdf({ catalog: "/OpenAction 2 0 R " }), { fileName: "claim.pdf", mime: "application/pdf" })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ text: "" }), { fileName: "scan.pdf", mime: "application/pdf" })).rejects.toThrow(/Text unavailable/);
  }, 15_000);

  it("separates text-bearing PDF pages and resolves safe indirect stream lengths", async () => {
    await expect(extractPrivateDocument(pdf({ pages: ["Cardano page one", "Cardano page two"] }), {
      fileName: "pages.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf", text: "Cardano page one\nCardano page two" });
    await expect(extractPrivateDocument(pdf({ indirectLength: true }), {
      fileName: "indirect-length.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf", text: "Cardano PDF" });
    const indirectSource = Buffer.from(pdf({ indirectLength: true })).toString("latin1");
    const lengthObject = /\n6 0 obj\n\d+\n\nendobj\n/u;
    for (const [name, source] of [
      ["missing", indirectSource.replace(lengthObject, "\n")],
      ["non-integer", indirectSource.replace(lengthObject, "\n6 0 obj\n(42)\n\nendobj\n")],
      ["cyclic", indirectSource.replace(lengthObject, "\n6 0 obj\n6 0 R\n\nendobj\n")],
      ["duplicate", `${indirectSource}\n6 0 obj\n42\nendobj\n`],
    ] as const) {
      await expect(extractPrivateDocument(Buffer.from(source, "latin1"), {
        fileName: `${name}-length.pdf`,
        mime: "application/pdf",
      })).rejects.toThrow(/Unsafe document/);
    }
  }, 15_000);

  it("rejects escaped catalog AA and semantic page/annotation actions", async () => {
    await expect(extractPrivateDocument(pdf({ catalog: "/#41A << /O << /S /GoTo /D [3 0 R /Fit] >> >> " }), {
      fileName: "catalog-aa.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ page: "/Annots [6 0 R] ", extraObjects: ["<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /GoTo /D [3 0 R /Fit] >> >>"] }), {
      fileName: "annotation-action.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ page: "/AA << /E << /S /GoTo /D [3 0 R /Fit] >> >> " }), {
      fileName: "page-aa.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ extraObjects: ["<< /S /URI /URI (https://example.test) >>"] }), {
      fileName: "uri-action.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ objectStream: true }), {
      fileName: "object-stream-action.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ extraObjects: ["stream\n/A /OpenAction\nendstream"] }), {
      fileName: "ambiguous-stream.pdf",
      mime: "application/pdf",
    })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ extraObjects: ["<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /Type /Encoding /Differences [65 /A] >> >>"] }), {
      fileName: "font-name.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf" });
    await expect(extractPrivateDocument(pdf({ text: "BT /F1 18 Tf 72 720 Td (Cardano /A PDF) Tj ET" }), {
      fileName: "visible-name.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ text: "Cardano /A PDF" });
    await expect(extractPrivateDocument(Buffer.concat([Buffer.from(pdf()), Buffer.from("% /A /OpenAction\n")]), {
      fileName: "comment-names.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf" });
    await expect(extractPrivateDocument(Buffer.concat([Buffer.from(pdf()), Buffer.from("<2F41>\n")]), {
      fileName: "hex-name.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf" });
    const nameHeavy = `<< ${Array.from({ length: 50_000 }, (_, index) => `/Name${index} 0`).join(" ")} >>`;
    await expect(extractPrivateDocument(pdf({ extraObjects: [nameHeavy] }), {
      fileName: "name-heavy.pdf",
      mime: "application/pdf",
    })).resolves.toMatchObject({ type: "pdf" });
  }, 15_000);

  it("keeps the pure extractor free of worker-thread listeners", () => {
    const pureSource = readFileSync("packages/cardano-agent/src/privateComparison/privateDocumentWorker.ts", "utf8");
    const threadSource = readFileSync("packages/cardano-agent/src/privateComparison/privateDocumentWorkerThread.ts", "utf8");
    expect(pureSource).not.toContain("parentPort");
    expect(threadSource).toContain("parentPort");
  });

  it("keeps exact astral code-point bounds in the protocol validator", async () => {
    const text = "😀".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS);
    await expect(extractPrivateDocument(textBytes(text), { fileName: "astral.txt", mime: "text/plain" })).resolves.toMatchObject({ text });
    await expect(extractPrivateDocument(textBytes(`${text}😀`), { fileName: "astral.txt", mime: "text/plain" })).rejects.toThrow(/Text unavailable/);
  }, 15_000);
});
