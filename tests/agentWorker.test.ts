import { describe, expect, it, vi } from "vitest";
import {
  createAgentAnswer,
  processAgentJob,
  WALLET_SECRET_WARNING,
  type AgentAnswer,
  type AgentAnswerDependencies,
  type AgentJobSender,
} from "@vennek/telegram-bot";

function answerDependencies(overrides: Partial<AgentAnswerDependencies> = {}): AgentAnswerDependencies {
  const recordUsage = vi.fn<AgentAnswerDependencies["recordUsage"]>().mockResolvedValue(undefined);
  return {
    retrieve: vi.fn().mockResolvedValue([]),
    complete: vi.fn().mockResolvedValue({ text: "", model: "fast", promptTokens: 0, completionTokens: 0 }),
    models: Object.freeze({ fast: "fast", quality: "quality", verifier: "verifier" }),
    recordUsage,
    ...overrides,
  };
}

function repository(append: unknown, findForUpdate = vi.fn().mockResolvedValue(undefined)): never {
  return { append, findForUpdate } as never;
}

describe("agent worker", () => {
  it("answers a queued update once and sends the answer once", async () => {
    const answer = vi.fn<AgentAnswer>().mockResolvedValue("Xin chào Cardano");
    const send = vi.fn<AgentJobSender>().mockResolvedValue({ delivered: true, attempts: 1 });

    await processAgentJob(
      { updateId: 7, telegramUserId: "1", telegramChatId: "2", text: "xin chào" },
      { answer, send },
    );

    expect(answer).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledWith({ telegramUserId: "1", telegramChatId: "2", text: "xin chào", updateId: 7 });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("2", "Xin chào Cardano");
  });

  it("sends only a fixed warning for a wallet-secret marker", async () => {
    const answer = vi.fn<AgentAnswer>();
    const send = vi.fn<AgentJobSender>().mockResolvedValue({ delivered: true, attempts: 1 });
    const job = {
      updateId: 8,
      telegramUserId: "1",
      telegramChatId: "2",
      text: "[vennek-wallet-secret-redacted]",
      walletSecretDetected: true as const,
    };

    await processAgentJob(job, { answer, send });

    expect(answer).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("2", WALLET_SECRET_WARNING);
    expect(JSON.stringify(job)).not.toContain("abandon");
  });

  it("recognizes the fixed marker even without a legacy boolean flag", async () => {
    const answer = vi.fn<AgentAnswer>();
    const send = vi.fn<AgentJobSender>().mockResolvedValue({ delivered: true, attempts: 1 });

    await processAgentJob(
      { updateId: 9, telegramUserId: "1", telegramChatId: "2", text: "[vennek-wallet-secret-redacted]" },
      { answer, send },
    );

    expect(answer).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("2", WALLET_SECRET_WARNING);
  });

  it("persists the accepted user and assistant messages", async () => {
    const append = vi.fn()
      .mockResolvedValueOnce({ firstInteraction: true })
      .mockResolvedValueOnce({ firstInteraction: false });
    const answer = createAgentAnswer(repository(append), answerDependencies());

    const result = await answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" });

    expect(result).toContain("Cardano");
    expect(append).toHaveBeenNthCalledWith(1, { telegramUserId: "1", telegramChatId: "2", text: "xin chào", role: "user" });
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ telegramUserId: "1", telegramChatId: "2", role: "assistant" }));
  });

  it("does not persist a wallet secret, then marks the next safe contact as first use", async () => {
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;
    const append = vi.fn().mockResolvedValueOnce({ firstInteraction: true }).mockResolvedValueOnce({ firstInteraction: false });
    const dependencies = answerDependencies();
    const answer = createAgentAnswer(repository(append), dependencies);

    await expect(answer({ telegramUserId: "1", telegramChatId: "2", text: mnemonic })).resolves.toMatch(/wallet|secret|seed|private/i);
    const safe = await answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" });

    expect(append).toHaveBeenCalledTimes(2);
    expect(safe).toContain("Vennek lưu lịch sử hội thoại vô thời hạn");
    expect(append).toHaveBeenNthCalledWith(1, { telegramUserId: "1", telegramChatId: "2", text: "xin chào", role: "user" });
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: "assistant" }));
  });

  it("does not append an assistant response when user persistence fails", async () => {
    const append = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const answer = createAgentAnswer(repository(append), answerDependencies());

    await expect(answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" })).resolves.toMatch(/safely|xử lý/i);
    expect(append).toHaveBeenCalledOnce();
  });

  it("retries a failed assistant append without duplicating the user or losing first-use notice", async () => {
    const append = vi.fn()
      .mockResolvedValueOnce({ firstInteraction: true })
      .mockRejectedValueOnce(new Error("assistant insert failed"))
      .mockResolvedValueOnce({ firstInteraction: true })
      .mockResolvedValueOnce({ firstInteraction: true });
    const answer = createAgentAnswer(repository(append), answerDependencies());
    const input = { telegramUserId: "1", telegramChatId: "2", text: "xin chào", updateId: 100 };

    await expect(answer(input)).rejects.toThrow("assistant insert failed");
    const retry = await answer(input);

    expect(retry).toContain("Vennek lưu lịch sử hội thoại vô thời hạn");
    expect(append).toHaveBeenCalledTimes(4);
    expect(append).toHaveBeenNthCalledWith(1, expect.objectContaining({ role: "user", telegramUpdateId: 100 }));
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: "assistant", telegramUpdateId: 100 }));
    expect(append).toHaveBeenNthCalledWith(3, expect.objectContaining({ role: "user", telegramUpdateId: 100 }));
    expect(append).toHaveBeenNthCalledWith(4, expect.objectContaining({ role: "assistant", telegramUpdateId: 100 }));
  });

  it("grounds answers through injected retrieval and model aliases, then records content-free usage for the user", async () => {
    const append = vi.fn()
      .mockResolvedValueOnce({ firstInteraction: true })
      .mockResolvedValueOnce({ firstInteraction: false });
    const retrieve = vi.fn().mockResolvedValue([{
      id: "chunk-1",
      sourceId: "docs",
      owner: "Cardano Foundation",
      trustTier: "official",
      title: "Cardano documentation",
      url: "https://docs.cardano.org/guide",
      excerpt: "Cardano uses proof of stake.",
      retrievedAt: "2026-08-25T00:00:00.000Z",
      versionHash: "a".repeat(64),
      stale: false,
    }]);
    const complete = vi.fn().mockImplementation(async (input: { model: string }) => input.model === "fast-alias"
      ? {
        text: JSON.stringify({ language: "en", claims: [{ text: "Cardano uses proof of stake.", citationIds: ["E1"], kind: "fact" }] }),
        model: "fast-alias",
        promptTokens: 11,
        completionTokens: 7,
      }
      : { text: '{"supported":[true]}', model: "verifier-alias", promptTokens: 5, completionTokens: 2 });
    const recordUsage = vi.fn<AgentAnswerDependencies["recordUsage"]>().mockResolvedValue(undefined);
    const answer = createAgentAnswer(repository(append), answerDependencies({
      retrieve,
      complete,
      models: Object.freeze({ fast: "fast-alias", quality: "quality-alias", verifier: "verifier-alias" }),
      recordUsage,
    }));

    const result = await answer({ telegramUserId: "123", telegramChatId: "456", text: "What is Cardano?", updateId: 100 });

    expect(result).toContain("Cardano uses proof of stake.");
    expect(retrieve).toHaveBeenCalledWith({ question: "What is Cardano?", language: "en" });
    expect(complete.mock.calls[0]?.[0].model).toBe("fast-alias");
    expect(complete.mock.calls[1]?.[0].model).toBe("verifier-alias");
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const [telegramUserId, usage] of recordUsage.mock.calls) {
      expect(telegramUserId).toBe("123");
      expect(usage).toEqual(expect.objectContaining({ model: expect.any(String), promptTokens: expect.any(Number), completionTokens: expect.any(Number), latencyMs: expect.any(Number) }));
      expect(usage).not.toHaveProperty("text");
      expect(usage).not.toHaveProperty("messages");
    }
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, { telegramUserId: "123", telegramChatId: "456", text: "What is Cardano?", telegramUpdateId: 100, role: "user" });
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ telegramUserId: "123", telegramChatId: "456", telegramUpdateId: 100, role: "assistant" }));
  });

  it("does not retrieve, complete, or record usage for greetings and wallet secrets", async () => {
    const append = vi.fn().mockResolvedValue({ firstInteraction: false });
    const dependencies = answerDependencies();
    const answer = createAgentAnswer(repository(append), dependencies);
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;

    await answer({ telegramUserId: "1", telegramChatId: "2", text: "hello" });
    await answer({ telegramUserId: "1", telegramChatId: "2", text: mnemonic });

    expect(dependencies.retrieve).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(dependencies.recordUsage).not.toHaveBeenCalled();
  });

  it("reuses an assistant stored before a retry crash without new provider or usage calls", async () => {
    let assistantStored = false;
    const append = vi.fn(async (message: { role: "user" | "assistant" }) => {
      if (message.role === "assistant") {
        assistantStored = true;
        throw new Error("crash after assistant append");
      }
      return { firstInteraction: true };
    });
    const findForUpdate = vi.fn(async () => assistantStored ? { role: "assistant" as const, text: "Answer A" } : undefined);
    const dependencies = answerDependencies({ retrieve: vi.fn().mockResolvedValue([]) });
    const answer = createAgentAnswer(repository(append, findForUpdate), dependencies);
    const input = { telegramUserId: "1", telegramChatId: "2", text: "What is Cardano?", updateId: 101 };

    await expect(answer(input)).rejects.toThrow("crash after assistant append");
    vi.mocked(dependencies.retrieve).mockClear();
    vi.mocked(dependencies.complete).mockClear();
    vi.mocked(dependencies.recordUsage).mockClear();
    await expect(answer(input)).resolves.toContain("Answer A");

    expect(dependencies.retrieve).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(dependencies.recordUsage).not.toHaveBeenCalled();
    expect(findForUpdate).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("fails closed for an unrecoverable legacy assistant reservation", async () => {
    const append = vi.fn().mockResolvedValue({ firstInteraction: false });
    const findForUpdate = vi.fn().mockResolvedValue(null);
    const dependencies = answerDependencies();
    const answer = createAgentAnswer(repository(append, findForUpdate), dependencies);

    await expect(answer({ telegramUserId: "1", telegramChatId: "2", text: "What is Cardano?", updateId: 102 }))
      .rejects.toThrow(/stored answer recovery|operator repair/i);
    expect(dependencies.retrieve).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(dependencies.recordUsage).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
  });
});
