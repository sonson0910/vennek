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

  it("removes Markdown comments and raw HTML elements with their contents", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode(`# Visible heading\n\nVisible Cardano text.\n<!-- HIDDEN_INSTRUCTION_COMMENT -->\n<div hidden>HIDDEN_INSTRUCTION_ELEMENT</div>\n\n**Visible Markdown**`)
    });

    expect(result.text).toContain("# Visible heading");
    expect(result.text).toContain("Visible Cardano text.");
    expect(result.text).toContain("Visible Markdown");
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
  });

  it("preserves Markdown autolinks and code literals while removing raw HTML outside them", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode(`# Cardano links and literals

See <https://docs.cardano.org> followed by text.

Use \`Array<string>\` inline.

\`\`\`\`html
<div>literal tag</div>
<!-- literal comment -->
\`\`\`\`\`

Visible after backtick fence.

~~~html
<span>tilde literal</span>
~~~

Visible after tilde fence.

<div>HIDDEN_INSTRUCTION_RAW_ELEMENT</div>
<!-- HIDDEN_INSTRUCTION_RAW_COMMENT -->`)
    });

    expect(result.text).toBe(`# Cardano links and literals

See https://docs.cardano.org followed by text.

Use Array<string> inline.

<div>literal tag</div>
<!-- literal comment -->

Visible after backtick fence.

<span>tilde literal</span>

Visible after tilde fence.`);
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
  });

  it("renders URI and email autolinks, inline code, and keeps visible text", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("Links: <https://docs.cardano.org> and <team@example.com> followed by visible text.\n\nUse `Array<string>` safely.")
    });

    expect(result.text).toBe("Links: https://docs.cardano.org and team@example.com followed by visible text.\n\nUse Array<string> safely.");
  });

  it("keeps fenced and indented Markdown code plus paragraphs after each fence", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("````html\n<div>backtick literal</div>\n`````\n\nAfter backtick fence.\n\n~~~~html\n<span>tilde literal</span>\n~~~~~\n\nAfter tilde fence.\n\n    <section>indented literal</section>\n\nAfter indented code.\n\n> ~~~html\n> <aside>quoted tilde literal</aside>\n> ~~~\n\nAfter quoted tilde fence.")
    });

    expect(result.text).toBe("<div>backtick literal</div>\n\nAfter backtick fence.\n\n<span>tilde literal</span>\n\nAfter tilde fence.\n\n<section>indented literal</section>\n\nAfter indented code.\n\n<aside>quoted tilde literal</aside>\n\nAfter quoted tilde fence.");
  });

  it("sanitizes raw HTML and comments without losing escaped Markdown or visible text", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("Escaped \\` marker remains.\n\n<!-- HIDDEN_INSTRUCTION_COMMENT -->\n<div hidden>HIDDEN_INSTRUCTION_DIV</div>\n\n<span>HIDDEN_INSTRUCTION_SPAN</span>\n\nVisible paragraph.")
    });

    expect(result.text).toBe("Escaped ` marker remains.\n\nVisible paragraph.");
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
  });

  it("drops raw HTML blocks with stray closing tags before later Markdown", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("<div>stray </div></div><span>HIDDEN_INSTRUCTION_BLOCK</span></div>\n\nVisible after block.")
    });

    expect(result.text).toBe("Visible after block.");
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
  });

  it("does not close an inline raw sentinel on a mismatched closing tag", async () => {
    const result = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("Before <span>DROP</div> SHOULD_DROP_TOO\n\nVisible after boundary.")
    });

    expect(result.text).toBe("Before\n\nVisible after boundary.");
    expect(result.text).not.toMatch(/DROP|SHOULD_DROP_TOO/);
  });

  it("preserves image alternative text and hard-break separation", async () => {
    const markdown = await extractContent({
      mime: "text/markdown",
      bytes: encoder.encode("![Generated alt](https://example.com/cardano.png)")
    });
    const html = await extractContent({
      mime: "text/html",
      bytes: encoder.encode("<p>Direct <img src=\"cardano.png\" alt=\"Direct alt\">.</p><p>first<br>second</p>")
    });

    expect(markdown.text).toBe("Generated alt");
    expect(html.text).toBe("Direct Direct alt.\n\nfirst second");
  });

  it("handles 400,000 short code spans within the bounded extraction deadline", async () => {
    const source = Array.from({ length: 400_000 }, () => "`x`").join(" ");
    const expected = `${"x ".repeat(399_999)}x`;
    const result = await extractContent({ mime: "text/markdown", bytes: encoder.encode(source) });

    expect(result.text).toBe(expected);
  }, 10_000);

  it("removes explicitly concealed HTML styles and semantic hidden classes", async () => {
    const hidden = [
      ["display: NONE !important", "HIDDEN_INSTRUCTION_DISPLAY"],
      [" VISIBILITY : hidden ;", "HIDDEN_INSTRUCTION_VISIBILITY"],
      ["opacity: 0", "HIDDEN_INSTRUCTION_OPACITY"],
      ["content-visibility: hidden", "HIDDEN_INSTRUCTION_CONTENT_VISIBILITY"],
      ["font-size: 0 !important", "HIDDEN_INSTRUCTION_FONT_SIZE"],
      ["color: transparent", "HIDDEN_INSTRUCTION_COLOR"]
    ];
    const styleNodes = hidden.map(([style, text]) => `<div style="${style}">${text}</div>`).join("");
    const classNodes = ["hidden", "invisible", "visually-hidden", "sr-only", "screen-reader-only", "d-none"]
      .map((className) => `<div class="prefix ${className.toUpperCase()} suffix">HIDDEN_INSTRUCTION_${className.toUpperCase()}</div>`)
      .join("");
    const result = await extractContent({
      mime: "text/html",
      bytes: encoder.encode(`<main><h1>Visible title</h1><p>VISIBLE_CARDANO_CONTENT</p>${styleNodes}${classNodes}</main>`)
    });

    expect(result.text).toContain("# Visible title");
    expect(result.text).toContain("VISIBLE_CARDANO_CONTENT");
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
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

  it("bounds an oversized Unicode h1 without truncating the body", async () => {
    const heading = "😀".repeat(400);
    const result = await extractContent({
      mime: "text/html",
      bytes: encoder.encode(`<h1>${heading}</h1><p>body evidence remains</p>`),
    });
    expect(Array.from(result.title)).toHaveLength(300);
    expect(result.title).toBe("😀".repeat(300));
    expect(result.text).toContain("body evidence remains");
  });

  it("delegates configured PDF extraction without loading a local parser", async () => {
    const bytes = encoder.encode("%PDF-1.7");
    const extractor = { extract: async (received: Uint8Array) => ({ title: "Remote PDF", text: `bytes:${received.byteLength}` }) };
    await expect(extractContent({ mime: "application/pdf", bytes, pdfExtractor: extractor })).resolves.toEqual({
      title: "Remote PDF",
      text: "bytes:8"
    });
  });

});
