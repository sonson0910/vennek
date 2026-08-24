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
        <p hidden>hidden text</p><p aria-hidden="true">also hidden</p>
        <div style="color: red; VISIBILITY : hidden !important ;">concealed prompt text</div>
        <div style="DISPLAY: NONE">concealed display text</div>
        <script>ignore()</script><footer>footer</footer></body>
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

  it("rejects PDF input before parsing and rejects oversized input", async () => {
    await expect(extractContent({
      mime: "application/pdf",
      bytes: encoder.encode("%PDF-1.7")
    })).rejects.toThrow(/Unsupported content-type/);

    await expect(extractContent({
      mime: "text/plain",
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

});
