import { describe, expect, it, vi } from "vitest";
import { answerQuestion, RETENTION_NOTICE } from "@vennek/cardano-agent";

const input = (text: string) => ({ telegramUserId: "1", telegramChatId: "2", text });

describe("natural-language question service", () => {
  it("blocks wallet secrets before persistence, retrieval, or model access", async () => {
    const persist = vi.fn();
    const retrieve = vi.fn();
    const complete = vi.fn();
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");

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
      return [{ id: "E1", text: "Ouroboros is proof of stake." }];
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
      retrieve: async () => [{ id: "unused" }],
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
    const complete = vi.fn(async ({ evidence }: { evidence: unknown[] }) => {
      expect(evidence).toHaveLength(1);
      return "Ouroboros uses proof of stake.";
    });

    const answer = await answerQuestion(input("How does Ouroboros work?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [{ id: "E1", text: "Ouroboros is proof of stake." }],
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
        retrieve: async () => [{ id: "E1" }],
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
        retrieve: async () => [{ id: "E1" }],
        complete: async () => " ",
      }),
    );
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [{ id: "E1" }],
        complete: async () => {
          throw new Error("complete failed");
        },
      }),
    );
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
    expectNoticeOnce(
      await answerQuestion(input("What is Cardano?"), {
        persist: firstUse,
        retrieve: async () => [{ id: "E1" }],
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

  it("blocks a wallet secret nested in retrieved evidence before completion", async () => {
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(" ");
    const signingKey = JSON.stringify({
      type: "PaymentSigningKeyShelley_ed25519",
      description: "nested evidence",
      cborHex: "5820abcdef",
    });
    const complete = vi.fn(async () => "should not be returned");

    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: vi.fn(async () => ({ firstInteraction: true })),
      retrieve: async () => [{ source: { snippets: ["safe context", { raw: phrase, key: signingKey }] } }],
      complete,
    });

    expect(answer).toMatch(/wallet secret|không gửi/i);
    expect(answer).toContain(RETENTION_NOTICE);
    expect(answer).not.toContain(phrase);
    expect(answer).not.toContain(signingKey);
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
