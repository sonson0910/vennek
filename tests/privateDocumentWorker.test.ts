import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractPrivateDocument } from "../packages/cardano-agent/src/privateComparison/privateDocumentWorker.js";
import { PRIVATE_DOCUMENT_MAX_BYTES, PRIVATE_DOCUMENT_MAX_CODE_POINTS } from "../packages/cardano-agent/src/privateComparison/privateDocumentProtocol.js";

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

type ZipEntry = { name: string; data: Buffer; flags?: number; attributes?: number };

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
    const compressed = deflateRawSync(entry.data);
    const flags = entry.flags ?? 0;
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc32(entry.data), 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
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
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
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

function docx(extra: ZipEntry[] = []): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>") },
    { name: "_rels/.rels", data: Buffer.from("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>") },
    { name: "word/document.xml", data: Buffer.from("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Cardano document</w:t></w:r></w:p></w:body></w:document>") },
    ...extra,
  ]);
}

function pdf(options: { text?: string; catalog?: string } = {}): Uint8Array {
  const content = options.text === undefined ? "BT /F1 18 Tf 72 720 Td (Cardano PDF) Tj ET" : options.text;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ""}>>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

  it("rejects active and scanned PDFs while extracting text PDFs", async () => {
    await expect(extractPrivateDocument(pdf(), { fileName: "claim.pdf", mime: "application/pdf" })).resolves.toMatchObject({ type: "pdf", text: "Cardano PDF" });
    await expect(extractPrivateDocument(pdf({ catalog: "/OpenAction 2 0 R " }), { fileName: "claim.pdf", mime: "application/pdf" })).rejects.toThrow(/Unsafe document/);
    await expect(extractPrivateDocument(pdf({ text: "" }), { fileName: "scan.pdf", mime: "application/pdf" })).rejects.toThrow(/Text unavailable/);
  }, 15_000);

  it("keeps exact astral code-point bounds in the protocol validator", async () => {
    const text = "😀".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS);
    await expect(extractPrivateDocument(textBytes(text), { fileName: "astral.txt", mime: "text/plain" })).resolves.toMatchObject({ text });
    await expect(extractPrivateDocument(textBytes(`${text}😀`), { fileName: "astral.txt", mime: "text/plain" })).rejects.toThrow(/Text unavailable/);
  }, 15_000);
});
