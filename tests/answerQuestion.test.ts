import { describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  RETENTION_NOTICE,
  type QuestionEvidence,
} from "@vennek/cardano-agent";

const input = (text: string) => ({ telegramUserId: "1", telegramChatId: "2", text });
const evidenceRecord = (overrides: Partial<QuestionEvidence> = {}): QuestionEvidence => ({
  id: "E1",
  sourceId: "cardano-docs",
  trustTier: "official",
  title: "Ouroboros",
  url: "https://docs.cardano.org/ouroboros",
  excerpt: "Ouroboros is proof of stake.",
  retrievedAt: "2026-08-24T00:00:00.000Z",
  versionHash: "v1",
  score: 1,
  ...overrides,
});

describe("natural-language question service", () => {
  it("blocks wallet secrets before persistence, retrieval, or model access", async () => {
    const persist = vi.fn();
    const retrieve = vi.fn();
    const complete = vi.fn();
    const phrase = Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ");

    const answer = await answerQuestion(input(phrase), { persist, retrieve, complete });

    expect(answer).toMatch(/không gửi|wallet secret/i);
    expect(answer).not.toContain(phrase);
    expect(persist).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("persists an accepted user message before retrieving evidence", async () => {
    const events: string[] = [];
    const persist = vi.fn(async () => {
      events.push("persist");
      return { firstInteraction: false };
    });
    const retrieve = vi.fn(async () => {
      events.push("retrieve");
      return [evidenceRecord()];
    });
    const complete = vi.fn(async () => {
      events.push("complete");
      return "Ouroboros uses proof of stake.";
    });

    await answerQuestion(input("How does Ouroboros work?"), { persist, retrieve, complete });

    expect(events).toEqual(["persist", "retrieve", "complete"]);
    expect(persist).toHaveBeenCalledWith(input("How does Ouroboros work?"));
  });

  it("prepends the retention notice only when persistence marks first use", async () => {
    const answer = await answerQuestion(input("Xin chào!"), {
      persist: async () => ({ firstInteraction: true }),
      retrieve: async () => [evidenceRecord()],
      complete: async () => "unused",
    });

    expect(answer).toBe(`${RETENTION_NOTICE}\n\nXin chào! Tôi có thể trả lời các câu hỏi về Cardano.`);
    expect(answer.match(/Vennek lưu lịch sử hội thoại vô thời hạn/g)).toHaveLength(1);
  });

  it("handles greetings deterministically without retrieval or completion", async () => {
    const persist = vi.fn(async () => undefined);
    const retrieve = vi.fn();
    const complete = vi.fn();

    const answer = await answerQuestion(input("  XIN CHÀO!!!  "), { persist, retrieve, complete });

    expect(answer).toMatch(/xin chào/i);
    expect(answer).toMatch(/Cardano/i);
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not ask the model for factual questions without evidence", async () => {
    const complete = vi.fn();

    const answer = await answerQuestion(input("Ouroboros hoạt động thế nào?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [],
      complete,
    });

    expect(answer).toMatch(/chưa có đủ nguồn/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["¿Qué es Cardano?", /fuentes fiables|suficientes fuentes/i],
    ["Cardanoとは何ですか？", /信頼できる情報源|十分/i],
    ["What is the question about Cardano?", /reliable sources|enough/i],
    ["Para que serve Cardano?", /fontes confiáveis|suficientes/i],
  ])("returns zero-evidence responses in the detected language: %s", async (text, expected) => {
    const answer = await answerQuestion(input(text), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [],
      complete: vi.fn(),
    });

    expect(answer).toMatch(expected);
  });

  it.each([
    ["¡Hola!", /hola|cardano/i],
    ["こんにちは！", /こんにちは|Cardano/],
  ])("recognizes supported-language greetings without model work: %s", async (text, expected) => {
    const retrieve = vi.fn();
    const complete = vi.fn();

    const answer = await answerQuestion(input(text), {
      persist: vi.fn(async () => undefined),
      retrieve,
      complete,
    });

    expect(answer).toMatch(expected);
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes an evidence-backed question through the injected dependency", async () => {
    const complete = vi.fn(async ({ evidence }: { evidence: readonly QuestionEvidence[] }) => {
      expect(evidence).toHaveLength(1);
      return "Ouroboros uses proof of stake.";
    });

    const answer = await answerQuestion(input("How does Ouroboros work?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [evidenceRecord()],
      complete,
    });

    expect(answer).toBe("Ouroboros uses proof of stake.");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("fails closed for malformed input and malformed dependency results", async () => {
    const persist = vi.fn();
    const retrieve = vi.fn();
    const complete = vi.fn();

    await expect(
      answerQuestion({ telegramUserId: "1", telegramChatId: "2", text: "   " }, { persist, retrieve, complete }),
    ).resolves.toMatch(/can't process|xử lý/i);
    expect(persist).not.toHaveBeenCalled();

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => undefined,
        retrieve: async () => "not evidence" as never,
        complete,
      }),
    ).resolves.toMatch(/can't process|xử lý/i);
  });

  it("fails closed for dependency failures without exposing raw errors", async () => {
    const secret = "provider-internal-secret-123";
    const persistError = new Error(`database password ${secret}`);
    const retrieveError = new Error(`upstream token ${secret}`);
    const completeError = new Error(`provider response ${secret}`);

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => {
          throw persistError;
        },
        retrieve: async () => [],
        complete: async () => "unused",
      }),
    ).resolves.not.toContain(secret);

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => undefined,
        retrieve: async () => {
          throw retrieveError;
        },
        complete: async () => "unused",
      }),
    ).resolves.not.toContain(secret);

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => undefined,
        retrieve: async () => [evidenceRecord()],
        complete: async () => {
          throw completeError;
        },
      }),
    ).resolves.not.toContain(secret);
  });

  it("keeps the first-use notice on every post-persistence return path", async () => {
    const firstUse = vi.fn(async () => ({ firstInteraction: true }));
    const expectNoticeOnce = (answer: string) => {
      expect(answer.startsWith(RETENTION_NOTICE)).toBe(true);
      expect(answer.match(/Vennek lưu lịch sử hội thoại vô thời hạn/g)).toHaveLength(1);
    };

    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => "malformed",
        complete: async () => "unused",
      }),
    );
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => {
          throw new Error("retrieve failed");
        },
        complete: async () => "unused",
      }),
    );
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [],
        complete: async () => "unused",
      }),
    );
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [evidenceRecord()],
        complete: async () => " ",
      }),
    );
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [evidenceRecord()],
        complete: async () => {
          throw new Error("complete failed");
        },
      }),
    );
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [evidenceRecord()],
        complete: async () => phrase,
      }),
    );
  });

  it("does not show a first-use notice when persistence never succeeds", async () => {
    const beforePersistence = await answerQuestion(input("What is Cardano?"), {
      persist: async () => {
        throw new Error("database unavailable");
      },
      retrieve: async () => [],
      complete: async () => "unused",
    });
    expect(beforePersistence).not.toContain(RETENTION_NOTICE);

    const phrase = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
    const secret = await answerQuestion(input(phrase), {
      persist: vi.fn(),
      retrieve: vi.fn(),
      complete: vi.fn(),
    });
    expect(secret).not.toContain(RETENTION_NOTICE);
  });

  it("blocks signing-key hints and mnemonics split across canonical evidence fields", async () => {
    const phrase = Array.from({ length: 11 }, () => "abandon").concat("about").join(" ");
    const complete = vi.fn(async () => "should not be returned");

    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => ({ firstInteraction: true })),
      retrieve: async () => [
        evidenceRecord({
          title: 'Envelope {"type":"PaymentSigningKeyShelley_ed25519"}',
          excerpt: 'Material {"cborHex":"5820abcdef"}',
        }),
        evidenceRecord({ id: "E2", excerpt: "abandon abandon abandon abandon abandon abandon" }),
        evidenceRecord({ id: "E3", excerpt: "abandon abandon abandon about" }),
      ],
      complete,
    });

    expect(answer).toMatch(/wallet secret|không gửi/i);
    expect(answer).toContain(RETENTION_NOTICE);
    expect(answer).not.toContain(phrase);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps structured correlation across records with large safe excerpts", async () => {
    const complete = vi.fn(async () => "should not be returned");
    const filler = "safe-source-text ".repeat(280);
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [
        evidenceRecord({
          title: '{"type":"PaymentSigningKeyShelley_ed25519"}',
          excerpt: filler,
        }),
        evidenceRecord({
          id: "E2",
          title: "Independent source",
          excerpt: `${filler}{"cborHex":"5820abcdef"}`,
        }),
      ],
      complete,
    });

    expect(answer).toMatch(/wallet secret|không gửi/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects evidence accessors before they can change from safe to secret", async () => {
    const phrase = Array.from({ length: 11 }, () => "abandon").concat("about").join(" ");
    let reads = 0;
    const evidence = evidenceRecord();
    Object.defineProperty(evidence, "excerpt", {
      enumerable: true,
      get: () => (reads++ === 0 ? "safe" : phrase),
    });
    const complete = vi.fn(async () => "should not be returned");

    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [evidence],
      complete,
    });

    expect(answer).toMatch(/can't process|wallet secret/i);
    expect(reads).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects malformed evidence values and aggregate budgets before completion", async () => {
    const complete = vi.fn(async () => "should not be returned");
    for (const value of [null, 42, {}]) {
      const answer = await answerQuestion(input("What is Cardano?"), {
        persist: vi.fn(async () => undefined),
        retrieve: async () => [value],
        complete,
      });
      expect(answer).toMatch(/can't process|wallet secret/i);
    }

    const largeEvidence = Array.from({ length: 10 }, (_, index) =>
      evidenceRecord({ id: `E${index}`, excerpt: "x".repeat(15_000) }),
    );
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => largeEvidence,
      complete,
    });
    expect(answer).toMatch(/can't process|wallet secret/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects malformed canonical fields, credentials, and optional accessors", async () => {
    const complete = vi.fn(async () => "should not be returned");
    const malformed = [
      evidenceRecord({ url: "https://user:password@example.com/source" }),
      evidenceRecord({ url: "https://docs.cardano.org/search?q=%ZZ" }),
      evidenceRecord({ url: "https://docs.cardano.org/search?q=%25252525" }),
      evidenceRecord({ score: Number.NaN }),
      evidenceRecord({ retrievedAt: "not-a-date" }),
    ];
    const optionalAccessor = evidenceRecord();
    Object.defineProperty(optionalAccessor, "publishedAt", {
      enumerable: true,
      get: () => "2026-08-24T00:00:00.000Z",
    });
    malformed.push(optionalAccessor);

    for (const evidence of malformed) {
      const answer = await answerQuestion(input("What is Cardano?"), {
        persist: vi.fn(async () => undefined),
        retrieve: async () => [evidence],
        complete,
      });
      expect(answer).toMatch(/can't process|wallet secret/i);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects million-length or sparse evidence arrays before reading items", async () => {
    let itemReads = 0;
    const hostile = new Proxy([evidenceRecord()], {
      get(target, property, receiver) {
        if (property === "length") return 1_000_000;
        if (property === "0") itemReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const complete = vi.fn(async () => "should not be returned");

    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => hostile,
      complete,
    });

    expect(answer).toMatch(/can't process|wallet secret/i);
    expect(itemReads).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("passes a frozen canonical evidence snapshot and ignores later source mutation", async () => {
    const original = evidenceRecord({ excerpt: "Original source excerpt." });
    const complete = vi.fn(async ({ evidence }: { evidence: readonly QuestionEvidence[] }) => {
      original.excerpt = "Mutated after snapshot";
      return `${evidence[0]!.excerpt} frozen=${Object.isFrozen(evidence[0]) && Object.isFrozen(evidence)}`;
    });

    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [original],
      complete,
    });

    expect(answer).toBe("Original source excerpt. frozen=true");
    expect(original.excerpt).toBe("Mutated after snapshot");
  });

  it("persists only canonical input fields and scans all three own strings", async () => {
    const phrase = Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ");
    const persist = vi.fn(async () => undefined);
    const raw = { ...input("What is Cardano?"), mnemonic: phrase };
    await answerQuestion(raw, {
      persist,
      retrieve: async () => [],
      complete: async () => "unused",
    });
    expect(persist).toHaveBeenCalledWith(input("What is Cardano?"));

    persist.mockClear();
    const blocked = await answerQuestion({ ...input("What is Cardano?"), telegramChatId: phrase }, {
      persist,
      retrieve: async () => [],
      complete: async () => "unused",
    });
    expect(blocked).toMatch(/wallet secret|không gửi/i);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["Oi!", /olá|cardano/i],
    ["Buenas tardes!", /hola|cardano/i],
    ["Bonsoir!", /bonjour|cardano/i],
    ["Guten Tag!", /hallo|cardano/i],
    ["Hai!", /halo|cardano/i],
    ["Selamat pagi!", /halo|cardano/i],
    ["Selam!", /merhaba|cardano/i],
    ["GÜNAYDIN!", /merhaba|cardano/i],
    ["Xin Cha\u0300o!", /xin chào|cardano/i],
  ])("recognizes normalized localized greeting: %s", async (text, expected) => {
    const retrieve = vi.fn();
    const complete = vi.fn();
    const answer = await answerQuestion(input(text), {
      persist: vi.fn(async () => undefined),
      retrieve,
      complete,
    });
    expect(answer).toMatch(expected);
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts an own undefined publishedAt as an omitted optional field", async () => {
    const complete = vi.fn(async ({ evidence }: { evidence: readonly QuestionEvidence[] }) => {
      expect(evidence[0]).not.toHaveProperty("publishedAt");
      return "ok";
    });
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [evidenceRecord({ publishedAt: undefined })],
      complete,
    });

    expect(answer).toBe("ok");
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    ["mnemonic", "https://docs.cardano.org/search?q=" + encodeURIComponent(Array.from({ length: 11 }, () => "abandon").concat("about").join(" "))],
    ["signing key", "https://docs.cardano.org/search?q=" + encodeURIComponent('{"type":"PaymentSigningKeyShelley_ed25519","cborHex":"5820abcdef"}')],
  ])("blocks percent-encoded %s secrets in evidence URLs", async (_kind, url) => {
    const complete = vi.fn(async () => "should not be returned");
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => ({ firstInteraction: true })),
      retrieve: async () => [evidenceRecord({ url })],
      complete,
    });

    expect(answer).toMatch(/wallet secret|không gửi/i);
    expect(answer).toContain(RETENTION_NOTICE);
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed on cyclic or throwing evidence without calling completion", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwing = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("untrusted getter");
      },
    });
    const complete = vi.fn(async () => "should not be returned");

    for (const evidence of [cyclic, throwing]) {
      const answer = await answerQuestion(input("What is Cardano?"), {
        persist: vi.fn(async () => undefined),
        retrieve: async () => [evidence],
        complete,
      });
      expect(answer).toMatch(/wallet secret|can't process/i);
    }
    expect(complete).not.toHaveBeenCalled();
  });
});
