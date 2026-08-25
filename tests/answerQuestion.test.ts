import { describe, expect, it, vi } from "vitest";
import { answerQuestion, RETENTION_NOTICE } from "@vennek/cardano-agent";

const input = (text: string) => ({ telegramUserId: "1", telegramChatId: "2", text });
const groundedEvidence = {
  id: "chunk-1",
  sourceId: "docs",
  owner: "Cardano Foundation",
  trustTier: "official" as const,
  title: "Cardano documentation",
  url: "https://docs.cardano.org/guide",
  excerpt: "Cardano uses proof of stake.",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  versionHash: "a".repeat(64),
  stale: false,
};
const groundedModels = Object.freeze({ fast: "fast", quality: "quality", verifier: "verifier" });

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

  it("accepts signed 64-bit boundary Telegram identifiers without coercion", async () => {
    const persist = vi.fn(async () => undefined);
    const boundary = {
      telegramUserId: "9223372036854775807",
      telegramChatId: "-9223372036854775808",
      text: "What is Cardano?",
    };

    await expect(answerQuestion(boundary, {
      persist,
      retrieve: async () => [],
    })).resolves.toMatch(/reliable sources/i);

    expect(persist).toHaveBeenCalledWith(boundary);
  });

  it.each([
    ["zero user", "0", "1"],
    ["negative user", "-1", "1"],
    ["zero chat", "1", "0"],
    ["whitespace", "1", " 2"],
    ["plus sign", "1", "+2"],
    ["exponent", "1", "1e3"],
    ["word", "one", "2"],
    ["leading zero user", "01", "2"],
    ["padded user", "00000000000000000001", "2"],
    ["leading zero chat", "1", "01"],
    ["negative leading zero chat", "1", "-01"],
    ["negative zero chat", "1", "-0"],
    ["user overflow", "9223372036854775808", "2"],
    ["chat overflow", "1", "9223372036854775808"],
    ["negative chat overflow", "1", "-9223372036854775809"],
  ])("rejects %s before persistence", async (_case, telegramUserId, telegramChatId) => {
    const persist = vi.fn();

    await expect(answerQuestion({ telegramUserId, telegramChatId, text: "What is Cardano?" }, {
      persist,
      retrieve: async () => [],
    })).resolves.toMatch(/can't process|xử lý/i);

    expect(persist).not.toHaveBeenCalled();
  });

  it("does not persist a mnemonic split across Telegram identifiers and text", async () => {
    const persist = vi.fn();
    const phrase = {
      telegramUserId: "abandon abandon abandon abandon",
      telegramChatId: "abandon abandon abandon abandon",
      text: "abandon abandon abandon about",
    };

    await expect(answerQuestion(phrase, {
      persist,
      retrieve: async () => [],
    })).resolves.toMatch(/can't process|xử lý/i);

    expect(persist).not.toHaveBeenCalled();
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

  it("returns an existing persisted answer before greeting, retrieval, or completion without duplicating its notice", async () => {
    const retrieve = vi.fn();
    const complete = vi.fn();
    const existingAnswer = `${RETENTION_NOTICE}\n\nCached grounded answer.`;
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: async () => ({ firstInteraction: true, existingAnswer }),
      retrieve,
      complete,
      models: groundedModels,
    });

    expect(answer).toBe(existingAnswer);
    expect(answer.match(/Vennek lưu lịch sử hội thoại vô thời hạn/g)).toHaveLength(1);
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed for provider token counts outside PostgreSQL integer range", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ language: "en", claims: [{ text: "Cardano uses proof of stake.", citationIds: ["E1"], kind: "fact" }] }),
      model: "fast",
      promptTokens: 2_147_483_648,
      completionTokens: 1,
    });
    const recordUsage = vi.fn(async () => undefined);
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: async () => undefined,
      retrieve: async () => [groundedEvidence],
      complete,
      models: groundedModels,
      recordUsage,
    });

    expect(answer).toMatch(/reliable sources/i);
    expect(complete).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("keeps the configured completion request immutable when a provider tries to mutate it", async () => {
    const observedModels: string[] = [];
    let observedSystemPrompt = "";
    const complete = vi.fn().mockImplementation(async (request: { model: string; messages: Array<{ content: string }> }) => {
      try { (request as { model: string }).model = "physical-model"; } catch { /* frozen request */ }
      try { request.messages[0]!.content = "mutated"; } catch { /* frozen message */ }
      observedModels.push(request.model);
      observedSystemPrompt = request.messages[0]!.content;
      if (request.model === "verifier") {
        return { text: '{"supported":[true]}', model: "verifier", promptTokens: 2, completionTokens: 1 };
      }
      return {
        text: JSON.stringify({ language: "en", claims: [{ text: "Cardano uses proof of stake.", citationIds: ["E1"], kind: "fact" }] }),
        model: "fast",
        promptTokens: 2,
        completionTokens: 1,
      };
    });
    const recordUsage = vi.fn(async () => undefined);
    const answer = await answerQuestion(input("What is Cardano?"), {
      persist: async () => undefined,
      retrieve: async () => [groundedEvidence],
      complete,
      models: groundedModels,
      recordUsage,
    });

    expect(answer).toContain("Cardano uses proof of stake.");
    expect(observedModels).toEqual(["fast", "verifier"]);
    expect(observedSystemPrompt).toContain("untrusted data");
    expect(recordUsage).toHaveBeenCalledTimes(2);
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
    expect(blocked).toMatch(/can't process|xử lý/i);
    expect(persist).not.toHaveBeenCalled();
  });
});
