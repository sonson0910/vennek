import { describe, expect, it } from "vitest";
import { routeTelegramCommand, routeTelegramText } from "@vennek/telegram-bot";

const fixtureContext = { enableFixtures: true, now: new Date("2026-07-04T00:00:00.000Z") };

describe("telegram router", () => {
  it("routes P0 commands when fixtures are explicitly enabled", async () => {
    await expect(routeTelegramCommand("/proposal catalyst-review-workbench", fixtureContext)).resolves.toMatchObject({ command: "proposal", ok: true });
    await expect(routeTelegramCommand("/compare catalyst-review-workbench drep-rationale-kit", fixtureContext)).resolves.toMatchObject({ command: "compare", ok: true });
    await expect(routeTelegramCommand("/vote-draft drep-rationale-kit support", fixtureContext)).resolves.toMatchObject({ command: "vote-draft", ok: true });
    await expect(routeTelegramCommand("/sources catalyst-review-workbench", fixtureContext)).resolves.toMatchObject({ command: "sources", ok: true });
  });

  it("routes BotFather-compatible underscore aliases", async () => {
    await expect(routeTelegramCommand("/vote_draft drep-rationale-kit support", fixtureContext)).resolves.toMatchObject({ command: "vote-draft", ok: true });
    await expect(routeTelegramText(`/proof_verify ${"a".repeat(64)}`, fixtureContext)).resolves.toMatch(/requires <tx_hash> <expected_content_hash>/i);
  });

  it("formats unknown commands as Telegram-safe errors", async () => {
    const output = await routeTelegramText("/unknown");
    expect(output).toContain("Draft analysis; human decides.");
    expect(output).toContain("Unknown command");
    expect(output.length).toBeLessThanOrEqual(3900);
  });

  it("formats command argument errors as Telegram-safe responses", async () => {
    await expect(routeTelegramText("/compare only-one", fixtureContext)).resolves.toMatch(/Draft analysis; human decides.[\s\S]*requires two proposal/i);
    await expect(routeTelegramText("/vote-draft drep-rationale-kit", fixtureContext)).resolves.toMatch(/requires <id> <support\|oppose\|abstain>/i);
    await expect(routeTelegramText("/vote-draft drep-rationale-kit yes", fixtureContext)).resolves.toMatch(/human-selected stance/i);
    await expect(routeTelegramText("/proof", fixtureContext)).resolves.toMatch(/proof requires text/i);
    await expect(routeTelegramText(`/proof-verify ${"a".repeat(64)}`, fixtureContext)).resolves.toMatch(/requires <tx_hash> <expected_content_hash>/i);
  });

  it("keeps production Telegram routes from loading demo fixtures by default", async () => {
    const output = await routeTelegramText("/proposal catalyst-review-workbench");
    expect(output).toContain("Draft analysis; human decides.");
    expect(output).toContain("Proposal: catalyst-review-workbench");
    expect(output).not.toContain("Catalyst Reviewer Workbench");
  });
});
