import type { CommandContext, CommandResult } from "@vennek/shared";
import {
  compareCommand,
  persistCommandResult,
  proofCommand,
  proofVerifyCommand,
  proposalCommand,
  sourcesCommand,
  voteDraftCommand
} from "@vennek/cardano-governance-skills";
import { formatErrorForTelegram, formatForTelegram } from "./formatters.js";

export async function routeTelegramCommand(input: string, context: CommandContext = {}): Promise<CommandResult> {
  const safeContext: CommandContext = { ...context, enableFixtures: context.enableFixtures ?? false, allowLocalFiles: context.allowLocalFiles ?? false };
  const trimmed = input.trim();
  const [command, ...parts] = trimmed.split(/\s+/);
  const rest = trimmed.slice(command.length).trim();
  let result: CommandResult;

  if (command === "/proposal") {
    result = await proposalCommand(rest, safeContext);
    return auditAndReturn(input, result, safeContext);
  }

  if (command === "/compare") {
    if (parts.length < 2) {
      throw new Error("/compare requires two proposal ids or sources.");
    }
    result = await compareCommand(parts[0], parts[1], safeContext);
    return auditAndReturn(input, result, safeContext);
  }

  if (command === "/vote-draft") {
    if (parts.length < 2) {
      throw new Error("/vote-draft requires <id> <support|oppose|abstain>.");
    }
    result = await voteDraftCommand(parts[0], parts[1], safeContext);
    return auditAndReturn(input, result, safeContext);
  }

  if (command === "/sources") {
    result = await sourcesCommand(rest, safeContext);
    return auditAndReturn(input, result, safeContext);
  }

  if (command === "/proof") {
    result = proofCommand(rest, safeContext.now);
    return auditAndReturn(input, result, safeContext);
  }

  if (command === "/proof-verify") {
    result = await proofVerifyCommand(rest, {
      projectId: safeContext.blockfrostProjectId,
      network: safeContext.blockfrostNetwork
    });
    return auditAndReturn(input, result, safeContext);
  }

  throw new Error(`Unknown command: ${command || "(empty)"}`);
}

export async function routeTelegramText(input: string, context: CommandContext = {}): Promise<string> {
  try {
    return formatForTelegram(await routeTelegramCommand(input, context));
  } catch (error) {
    return formatErrorForTelegram(error);
  }
}

function auditAndReturn(rawInput: string, result: CommandResult, context: CommandContext): CommandResult {
  try {
    persistCommandResult({ rawInput, result, context });
  } catch (error) {
    console.warn(`Vennek persistence warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}
