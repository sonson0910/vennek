import type { ConversationRepository } from "@vennek/cardano-agent";
import { answerQuestion, type QuestionInput } from "@vennek/cardano-agent";
import { WALLET_SECRET_JOB_MARKER, type TelegramAnswerJob } from "./agentQueue.js";

export const WALLET_SECRET_WARNING =
  "Do not send wallet secrets such as a seed phrase or private key here. Please remove them from the conversation.";

type AgentAnswerInput = QuestionInput & { updateId?: number };

export type AgentAnswer = (input: AgentAnswerInput) => Promise<string>;

export type AgentJobSender = (
  telegramChatId: string,
  text: string,
) => Promise<{ delivered: boolean; attempts: number } | void>;

export type AgentWorkerDependencies = {
  answer: AgentAnswer;
  send: AgentJobSender;
};

export type AgentJobOutcome = {
  delivered: boolean;
  attempts: number;
};

export async function processAgentJob(
  job: TelegramAnswerJob,
  dependencies: AgentWorkerDependencies,
): Promise<AgentJobOutcome> {
  const response = job.walletSecretDetected || job.text === WALLET_SECRET_JOB_MARKER ? WALLET_SECRET_WARNING : await dependencies.answer({
    telegramUserId: job.telegramUserId,
    telegramChatId: job.telegramChatId,
    text: job.text,
    updateId: job.updateId,
  });
  const delivery = await dependencies.send(job.telegramChatId, response);
  return delivery && "delivered" in delivery ? delivery : { delivered: true, attempts: 1 };
}

export function createAgentAnswer(repository: ConversationRepository): AgentAnswer {
  return async (input) => {
    const { updateId, telegramUserId, telegramChatId, text } = input;
    const question: QuestionInput = { telegramUserId, telegramChatId, text };
    const persistenceInput = updateId === undefined ? question : { ...question, telegramUpdateId: updateId };
    let persisted = false;
    const answer = await answerQuestion(question, {
      persist: async () => {
        const result = await repository.append({ ...persistenceInput, role: "user" });
        persisted = true;
        return result;
      },
      retrieve: async () => [],
    });
    if (persisted) await repository.append({ ...persistenceInput, role: "assistant", text: answer });
    return answer;
  };
}
