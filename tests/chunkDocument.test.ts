import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vennek/shared";
import { chunkDocument } from "../packages/cardano-agent/src/knowledge/chunkDocument.js";

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("lone low surrogate");
    }
  }
}

describe("chunkDocument", () => {
  it("chunks headings and paragraphs deterministically with stable hashes", () => {
    const input = "Before\r\n\r\n#  Overview  \r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.";
    const chunks = chunkDocument(input);

    expect(chunks).toEqual([
      expect.objectContaining({ ordinal: 0, heading: "Document", content: "Before" }),
      expect.objectContaining({ ordinal: 1, heading: "Overview", content: "First paragraph.\n\nSecond paragraph." }),
    ]);
    expect(chunks.every((chunk) => chunk.content.length <= 1_200)).toBe(true);
    expect(chunks.every((chunk) => /^[0-9a-f]{64}$/.test(chunk.contentHash))).toBe(true);
    expect(chunkDocument(input)).toEqual(chunks);
    expect(chunkDocument(input.replaceAll("\r\n", "\n"))).toEqual(chunks);
  });

  it("rejects empty and whitespace-only documents", () => {
    expect(() => chunkDocument("")).toThrow(/content/i);
    expect(() => chunkDocument(" \t\r\n ")).toThrow(/content/i);
  });

  it("keeps normal fenced code blocks intact and bounds oversized fences", () => {
    const smallFence = ["# Code", "", "```typescript", "const value = 1;", "```"].join("\n");
    const small = chunkDocument(smallFence);
    expect(small).toHaveLength(1);
    expect(small[0]?.content).toContain("```typescript\nconst value = 1;\n```");

    const largeBody = Array.from({ length: 1_500 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const large = chunkDocument(["# Code", "", "```typescript", largeBody, "```"].join("\n"));
    expect(large.length).toBeGreaterThan(1);
    expect(large.every((chunk) => chunk.content.length <= 1_200 && chunk.content.length > 0)).toBe(true);
  });

  it("keeps a short fenced block at the full content cap despite a long heading", () => {
    const heading = "h".repeat(200);
    const body = "x".repeat(1_100);
    const chunks = chunkDocument(`# ${heading}\n\n\`\`\`\n${body}\n\`\`\``);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content.length).toBeLessThanOrEqual(1_200);
    expect(`${chunks[0]?.heading}\n${chunks[0]?.content}`.length).toBeLessThanOrEqual(1_401);
  });

  it("preserves heading text beyond the bounded metadata prefix as content", () => {
    const marker = "heading-overflow-marker";
    const chunks = chunkDocument(`# ${"h".repeat(200)}${marker}\n\nBody`);

    expect(chunks[0]?.heading).toBe("h".repeat(200));
    expect(chunks.map((chunk) => chunk.content).join("\n")).toContain(marker);
    expect(chunks.every((chunk) => chunk.content.length <= 1_200 && `${chunk.heading}\n${chunk.content}`.length <= 1_401)).toBe(true);
  });

  it("preserves overflow markers from consecutive long headings", () => {
    const first = "first-heading-overflow";
    const second = "second-heading-overflow";
    const chunks = chunkDocument([
      `# ${"a".repeat(200)}${first}`,
      `# ${"b".repeat(200)}${second}`,
      "",
      "Body",
    ].join("\n"));
    const source = chunks.map((chunk) => chunk.content).join("\n");

    expect(source).toContain(first);
    expect(source).toContain(second);
  });

  it("rejects documents whose many fenced blocks exceed aggregate chunk bounds", () => {
    const input = Array.from({ length: 2_501 }, (_, index) => [
      `# H${index}`,
      "",
      "```",
      "x",
      "```",
    ].join("\n")).join("\n\n");

    expect(() => chunkDocument(input)).toThrow(/chunk|embedding|budget/i);
  });

  it("keeps prose carry overlap at or below 150 characters", () => {
    const words = Array.from({ length: 500 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkDocument(`# Long\n\n${words}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!.content;
      const current = chunks[index]!.content;
      let overlap = 0;
      for (let size = Math.min(previous.length, current.length); size > 0; size -= 1) {
        if (previous.endsWith(current.slice(0, size))) {
          overlap = size;
          break;
        }
      }
      expect(overlap).toBeLessThanOrEqual(150);
    }
  });

  it("never emits empty chunks and never exceeds the hard cap", () => {
    const content = `# Bounds\n\n${"x".repeat(10_000)}`;
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk, index) => chunk.ordinal === index && chunk.content.trim().length > 0 && chunk.content.length <= 1_200)).toBe(true);
  });

  it("emits a bounded fallback chunk for heading-only documents", () => {
    for (const input of ["# Title", "# One\n## Two\n### Three"]) {
      const chunks = chunkDocument(input);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.every((chunk) => chunk.content.length > 0 && chunk.content.length <= 1_200 && `${chunk.heading}\n${chunk.content}`.length <= 1_401)).toBe(true);
    }
  });

  it("bounds heading amplification and preserves exact hashes", () => {
    const heading = "# " + "Very long heading ".repeat(2_000);
    const paragraphs = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} with Cardano content.`).join("\n\n");
    const input = `${heading}\n\n${paragraphs}`;
    const chunks = chunkDocument(input);
    const totalPayload = chunks.reduce((total, chunk) => total + chunk.heading.length + 1 + chunk.content.length, 0);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading.length <= 200 && chunk.content.length <= 1_200 && `${chunk.heading}\n${chunk.content}`.length <= 1_401)).toBe(true);
    expect(totalPayload).toBeLessThan(input.length * 3);
    expect(chunks.every((chunk) => chunk.contentHash === sha256Hex(`${chunk.heading}\n${chunk.content}`))).toBe(true);
  });

  it("uses the target merge budget independently of heading length", () => {
    const heading = "h".repeat(200);
    const chunks = chunkDocument(`# ${heading}\n\n${"a".repeat(499)}\n\n${"b".repeat(499)}`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toHaveLength(1_000);
    expect(chunks.every((chunk) => chunk.content.length <= 1_200 && `${chunk.heading}\n${chunk.content}`.length <= 1_401)).toBe(true);
    expect(chunks.every((chunk) => chunk.contentHash === sha256Hex(`${chunk.heading}\n${chunk.content}`))).toBe(true);
  });

  it("preserves heading-only source evidence in bounded fallback chunks", () => {
    const chunks = chunkDocument("# One\n## Two\n### Three");
    const source = chunks.map((chunk) => chunk.content).join("\n");

    expect(source).toContain("# One");
    expect(source).toContain("## Two");
    expect(source).toContain("### Three");
    expect(chunks.every((chunk) => chunk.content.length <= 1_200 && `${chunk.heading}\n${chunk.content}`.length <= 1_401)).toBe(true);
    expect(chunks.every((chunk) => chunk.contentHash === sha256Hex(`${chunk.heading}\n${chunk.content}`))).toBe(true);
  });

  it("never splits astral Unicode code points in prose or oversized code", () => {
    const prose = chunkDocument(`# Emoji\n\n${"😀".repeat(1_000)}`);
    const code = chunkDocument(["# Code", "", "```", "😀".repeat(1_000), "```"].join("\n"));

    for (const chunk of [...prose, ...code]) {
      assertNoLoneSurrogates(chunk.heading);
      assertNoLoneSurrogates(chunk.content);
      for (const value of [chunk.heading, chunk.content]) {
        const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value));
        expect(roundTrip).toBe(value);
        expect(roundTrip).not.toContain("\uFFFD");
      }
    }
    expect(prose.reduce((total, chunk) => total + [...chunk.content].filter((value) => value === "😀").length, 0)).toBe(1_000);
    expect(code.reduce((total, chunk) => total + [...chunk.content].filter((value) => value === "😀").length, 0)).toBe(1_000);
    assertNoLoneSurrogates("BMP \uE000 text");
  });
});
