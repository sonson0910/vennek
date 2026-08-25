import { describe, expect, it, vi } from "vitest";
import { provisionAgentQueues } from "../scripts/migrate-agent.js";

describe("agent queue provisioning", () => {
  it("provisions the private comparison queue with bounded retry and retention", async () => {
    const boss = { createQueue: vi.fn().mockResolvedValue(undefined) };
    await provisionAgentQueues(boss as never);

    expect(boss.createQueue).toHaveBeenCalledWith("telegram-private-compare", expect.objectContaining({
      retryLimit: 3,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: 300,
      retentionSeconds: 300,
      deleteAfterSeconds: 1,
    }));
  });
});
