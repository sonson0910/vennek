import { routeTelegramText } from "@vennek/telegram-bot";

const commands = [
  "/proposal catalyst-review-workbench",
  "/compare catalyst-review-workbench drep-rationale-kit",
  "/vote-draft drep-rationale-kit abstain",
  "/sources catalyst-review-workbench",
  "/proof DRep draft rationale for catalyst-review-workbench with citations CRW-1 and CRW-2",
  `/proof-verify ${"a".repeat(64)} ${"b".repeat(64)}`
];

for (const command of commands) {
  console.log(`\n$ ${command}`);
  console.log(await routeTelegramText(command, { now: new Date("2026-07-04T00:00:00.000Z"), enableFixtures: true }));
}
