import { describe, expect, it, vi } from "vitest";
import { answerQuestion, RETENTION_NOTICE } from "@vennek/cardano-agent";

const input = (text: string) => ({ telegramUserId: "1", telegramChatId: "2", text });

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

  it("persists an accepted user message before retrieval", async () => {
    const events: string[] = [];
    const persist = vi.fn(async () => {
      events.push("persist");
      return { firstInteraction: false };
    });
    const retrieve = vi.fn(async () => {
      events.push("retrieve");
      return [];
    });

    const answer = await answerQuestion(input("How does Ouroboros work?"), { persist, retrieve });

    expect(events).toEqual(["persist", "retrieve"]);
    expect(answer).toMatch(/reliable sources/i);
    expect(persist).toHaveBeenCalledWith(input("How does Ouroboros work?"));
  });

  it("prepends the retention notice only when persistence marks first use", async () => {
    const answer = await answerQuestion(input("Xin chào!"), {
      persist: async () => ({ firstInteraction: true }),
      retrieve: async () => [],
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

  it.each([
    ["Ouroboros hoạt động thế nào?", /chưa có đủ nguồn/i],
    ["¿Qué es Cardano?", /fuentes fiables|suficientes fuentes/i],
    ["Cardanoとは何ですか？", /信頼できる情報源|十分/i],
    ["What is the question about Cardano?", /reliable sources|enough/i],
    ["Para que serve Cardano?", /fontes confiáveis|suficientes/i],
  ])("returns localized insufficient evidence without model work: %s", async (text, expected) => {
    const retrieve = vi.fn(async () => []);
    const complete = vi.fn();
    const answer = await answerQuestion(input(text), {
      persist: vi.fn(async () => undefined),
      retrieve,
      complete,
    });

    expect(answer).toMatch(expected);
    expect(retrieve).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses factual completion even when retrieval returns nonempty evidence", async () => {
    const complete = vi.fn(async () => "malicious provider answer");
    const answer = await answerQuestion(input("How does Ouroboros work?"), {
      persist: vi.fn(async () => undefined),
      retrieve: async () => [{ title: "valid-looking source", excerpt: "untrusted" }],
      complete,
    });

    expect(answer).toMatch(/reliable sources|đủ nguồn/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["¡Hola!", /hola|cardano/i],
    ["こんにちは！", /こんにちは|Cardano/],
    ["Oi!", /olá|cardano/i],
    ["Buenas tardes!", /hola|cardano/i],
    ["Bonsoir!", /bonjour|cardano/i],
    ["Guten Tag!", /hallo|cardano/i],
    ["Hai!", /halo|cardano/i],
    ["Selamat pagi!", /halo|cardano/i],
    ["Selam!", /merhaba|cardano/i],
    ["GÜNAYDIN!", /merhaba|cardano/i],
    ["Xin Cha\u0300o!", /xin chào|cardano/i],
  ])("recognizes localized greetings without retrieval: %s", async (text, expected) => {
    const retrieve = vi.fn();
    const answer = await answerQuestion(input(text), {
      persist: vi.fn(async () => undefined),
      retrieve,
    });

    expect(answer).toMatch(expected);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("fails closed for malformed input and non-array retrieval", async () => {
    const persist = vi.fn();
    const retrieve = vi.fn();

    await expect(
      answerQuestion({ telegramUserId: "1", telegramChatId: "2", text: "   " }, { persist, retrieve }),
    ).resolves.toMatch(/can't process|xử lý/i);
    expect(persist).not.toHaveBeenCalled();

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => undefined,
        retrieve: async () => "not evidence",
      }),
    ).resolves.toMatch(/can't process|xử lý/i);
  });

  it("fails closed for dependency failures without exposing raw errors", async () => {
    const secret = "provider-internal-secret-123";
    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => {
          throw new Error(`database password ${secret}`);
        },
        retrieve: async () => [],
      }),
    ).resolves.not.toContain(secret);

    await expect(
      answerQuestion(input("What is Cardano?"), {
        persist: async () => undefined,
        retrieve: async () => {
          throw new Error(`upstream token ${secret}`);
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

    expectNoticeOnce(await answerQuestion(input("What is Cardano?"), {
      persist: firstUse,
      retrieve: async () => "malformed",
    }));
    expectNoticeOnce(await answerQuestion(input("What is Cardano?"), {
      persist: firstUse,
      retrieve: async () => {
        throw new Error("retrieve failed");
      },
    }));
    expectNoticeOnce(await answerQuestion(input("What is Cardano?"), {
      persist: firstUse,
      retrieve: async () => [],
    }));
    expectNoticeOnce(await answerQuestion(input("What is Cardano?"), {
      persist: firstUse,
      retrieve: async () => [{ malicious: true }],
    }));
  });

  it("does not show a first-use notice when persistence never succeeds", async () => {
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: async () => {
        throw new Error("database unavailable");
      },
      retrieve: async () => [],
    });
    expect(answer).not.toContain(RETENTION_NOTICE);
  });

  it("persists only canonical input fields and scans all three own strings", async () => {
    const persist = vi.fn(async () => undefined);
    const raw = { ...input("What is Cardano?"), mnemonic: "not persisted" };
    await answerQuestion(raw, { persist, retrieve: async () => [] });
    expect(persist).toHaveBeenCalledWith(input("What is Cardano?"));

    persist.mockClear();
    const phrase = Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ");
    const blocked = await answerQuestion(
      { ...input("What is Cardano?"), telegramChatId: phrase },
      { persist, retrieve: async () => [] },
    );
    expect(blocked).toMatch(/wallet secret|không gửi/i);
    expect(persist).not.toHaveBeenCalled();
  });
});
