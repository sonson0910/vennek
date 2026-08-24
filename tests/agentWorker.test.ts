import { describe, expect, it, vi } from "vitest";
import {
  createAgentAnswer,
  processAgentJob,
  WALLET_SECRET_WARNING,
  type AgentAnswer,
  type AgentJobSender,
} from "@vennek/telegram-bot";

describe("agent worker", () => {
  it("answers a queued update once and sends the answer once", async () => {
    const answer = vi.fn<AgentAnswer>().mockResolvedValue("Xin chào Cardano");
    const send = vi.fn<AgentJobSender>().mockResolvedValue({ delivered: true, attempts: 1 });

    await processAgentJob(
      { updateId: 7, telegramUserId: "1", telegramChatId: "2", text: "xin chào" },
      { answer, send },
    );

    expect(answer).toHaveBeenCalledOnce();
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
    const answer = createAgentAnswer({ append } as never);

    const result = await answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" });

    expect(result).toContain("Cardano");
    expect(append).toHaveBeenNthCalledWith(1, { telegramUserId: "1", telegramChatId: "2", text: "xin chào", role: "user" });
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ telegramUserId: "1", telegramChatId: "2", role: "assistant" }));
  });

  it("does not persist a wallet secret, then marks the next safe contact as first use", async () => {
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;
    const append = vi.fn().mockResolvedValueOnce({ firstInteraction: true }).mockResolvedValueOnce({ firstInteraction: false });
    const answer = createAgentAnswer({ append } as never);

    await expect(answer({ telegramUserId: "1", telegramChatId: "2", text: mnemonic })).resolves.toMatch(/wallet|secret|seed|private/i);
    const safe = await answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" });

    expect(append).toHaveBeenCalledTimes(2);
    expect(safe).toContain("Vennek lưu lịch sử hội thoại vô thời hạn");
    expect(append).toHaveBeenNthCalledWith(1, { telegramUserId: "1", telegramChatId: "2", text: "xin chào", role: "user" });
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: "assistant" }));
  });

  it("does not append an assistant response when user persistence fails", async () => {
    const append = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const answer = createAgentAnswer({ append } as never);

    await expect(answer({ telegramUserId: "1", telegramChatId: "2", text: "xin chào" })).resolves.toMatch(/safely|xử lý/i);
    expect(append).toHaveBeenCalledOnce();
  });
});
