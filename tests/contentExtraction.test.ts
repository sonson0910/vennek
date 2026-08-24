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
    expect(result.text).toContain("**Visible Markdown**");
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

Visible after tilde fence.`);
    expect(result.text).not.toMatch(/HIDDEN_INSTRUCTION/);
  });

  it("preserves many literals without placeholder collisions or quadratic restoration", async () => {
    const literals = Array.from({ length: 40_000 }, (_, index) => `\`Array<Tag${index}>\``).join(" ");
    const source = `# Many literals\n\n__CARDANO_MARKDOWN_LITERAL_0__ ${literals}\n\n<div>HIDDEN_INSTRUCTION_BULK_RAW</div>`;
    const result = await extractContent({ mime: "text/markdown", bytes: encoder.encode(source) });

    expect(result.text).toBe(`# Many literals\n\n__CARDANO_MARKDOWN_LITERAL_0__ ${literals}`);
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

});
