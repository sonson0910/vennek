import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdf } from "../packages/cardano-agent/src/knowledge/pdfExtractorWorker.js";

function makePdf(text: string, pageCount = 1): Uint8Array {
  const firstPageObject = 3;
  const fontObject = firstPageObject + pageCount;
  const contentObject = fontObject + 1;
  const pageRefs = Array.from({ length: pageCount }, (_, index) => `${firstPageObject + index} 0 R`).join(" ");
  const textCommands = text.length > 1_000
    ? Array.from({ length: Math.ceil(text.length / 6) }, () => "(xxxxxx) Tj 10 0 Td ").join("")
    : `(${text}) Tj `;
  const stream = `BT /F1 18 Tf 72 720 Td ${textCommands}ET`;
  const mediaBox = text.length > 1_000 ? "[0 0 100000000 1000]" : "[0 0 612 792]";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
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

describe("PDF extractor worker", () => {
  it("keeps pdfjs out of the agent package entrypoint", () => {
    expect(readFileSync("packages/cardano-agent/src/index.ts", "utf8")).not.toContain("pdfjs");
  });

  it("extracts text without importing the worker into the agent process", async () => {
    const bytes = makePdf("Cardano works");
    await expect(extractPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).resolves.toMatchObject({
      text: expect.stringContaining("Cardano works")
    });
  });

  it("rejects malformed PDF input", async () => {
    const bytes = Buffer.from("not a pdf");
    await expect(extractPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).rejects.toThrow();
  });

  it("rejects PDFs over the page and output limits", async () => {
    const manyPages = makePdf("page", 301);
    await expect(extractPdf(manyPages.buffer.slice(manyPages.byteOffset, manyPages.byteOffset + manyPages.byteLength) as ArrayBuffer)).rejects.toThrow(/page limit/i);
    const largeOutput = makePdf("x".repeat(2_000_001));
    await expect(extractPdf(largeOutput.buffer.slice(largeOutput.byteOffset, largeOutput.byteOffset + largeOutput.byteLength) as ArrayBuffer)).rejects.toThrow(/output limit/i);
  }, 15_000);
});
