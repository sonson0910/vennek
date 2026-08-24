import { describe, expect, it } from "vitest";
import { extractContent } from "@vennek/cardano-agent";

const encoder = new TextEncoder();

describe("bounded source content extraction", () => {
  it("removes scripts, navigation, footer, and hidden HTML while preserving headings and paragraphs", async () => {
    const result = await extractContent({
      mime: "text/html",
      bytes: encoder.encode(`
        <html><head><title>Fallback title</title><meta property="article:published_time" content="2026-08-01T12:00:00Z"></head>
        <body><nav>menu</nav><h1>Ouroboros</h1><p>Proof of stake.</p>
        <p hidden>hidden text</p><p aria-hidden="true">also hidden</p><script>ignore()</script><footer>footer</footer></body>
      `)
    });

    expect(result).toEqual({
      title: "Ouroboros",
      text: "# Ouroboros\n\nProof of stake.",
      publishedAt: new Date("2026-08-01T12:00:00.000Z")
    });
  });

  it("preserves markdown, plain text, and pretty JSON", async () => {
    await expect(extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("# Consensus\n\nOuroboros\n\n- secure")
    })).resolves.toMatchObject({ title: "Consensus", text: "# Consensus\n\nOuroboros\n\n- secure" });

    await expect(extractContent({
      mime: "text/plain",
      bytes: encoder.encode("Cardano\r\n\r\nfinality")
    })).resolves.toMatchObject({ title: "Cardano", text: "Cardano\n\nfinality" });

    await expect(extractContent({
      mime: "application/json",
      bytes: encoder.encode('{"name":"Cardano","active":true}')
    })).resolves.toMatchObject({
      title: "{",
      text: '{\n  "name": "Cardano",\n  "active": true\n}'
    });
  });

  it("rejects oversized input before PDF parsing and rejects empty output", async () => {
    await expect(extractContent({
      mime: "application/pdf",
      bytes: new Uint8Array(8 * 1024 * 1024 + 1)
    })).rejects.toThrow(/8 MiB/);

    await expect(extractContent({ mime: "text/plain", bytes: encoder.encode(" \n\t") })).rejects.toThrow(/empty/i);
  });

  it("rejects output over the normalized character cap", async () => {
    await expect(extractContent({
      mime: "text/plain",
      bytes: encoder.encode("x".repeat(2_000_001))
    })).rejects.toThrow(/2,000,000/);
  });

  it("extracts PDF text and rejects documents over the page limit", async () => {
    const onePage = makePdf(1);
    await expect(extractContent({ mime: "application/pdf", bytes: onePage })).resolves.toMatchObject({
      title: "Hello Cardano",
      text: "Hello Cardano"
    });

    await expect(extractContent({ mime: "application/pdf", bytes: makePdf(301) })).rejects.toThrow(/300 pages/);
  });
});

function makePdf(pageCount: number): Uint8Array {
  const contentId = pageCount + 3;
  const fontId = pageCount + 4;
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 3);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageIds.map(() => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`),
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 720 Td (Hello Cardano) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
