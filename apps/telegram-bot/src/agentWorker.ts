import type { ConversationRepository } from "@vennek/cardano-agent";
import {
  answerQuestion,
  type AnswerCompletionInput,
  type AnswerUsage,
  type CompletionOutput,
  type ModelProfile,
  type QuestionInput,
  type QuestionRetrievalInput,
} from "@vennek/cardano-agent";
import { WALLET_SECRET_JOB_MARKER, type TelegramAnswerJob } from "./agentQueue.js";

export const WALLET_SECRET_WARNING =
  "Do not send wallet secrets such as a seed phrase or private key here. Please remove them from the conversation.";

type AgentAnswerInput = QuestionInput & { updateId?: number };

export type AgentAnswer = (input: AgentAnswerInput) => Promise<string>;

export type AgentAnswerDependencies = {
  retrieve: (input: QuestionRetrievalInput) => Promise<unknown>;
  complete: (input: AnswerCompletionInput) => Promise<CompletionOutput>;
  models: Readonly<Record<ModelProfile, string>>;
  recordUsage: (telegramUserId: string, usage: AnswerUsage) => Promise<void> | void;
};

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

export function createAgentAnswer(
  repository: ConversationRepository,
  dependencies: AgentAnswerDependencies,
): AgentAnswer {
  return async (input) => {
    const { updateId, telegramUserId, telegramChatId, text } = input;
    const question: QuestionInput = { telegramUserId, telegramChatId, text };
    const persistenceInput = updateId === undefined ? question : { ...question, telegramUpdateId: updateId };
    let persisted = false;
    let existingAssistant = false;
    let retryBlocked = false;
    const answer = await answerQuestion(question, {
      persist: async () => {
        const result = await repository.append({ ...persistenceInput, role: "user" });
        let existingAnswer: string | undefined;
        if (updateId !== undefined) {
          const stored = await repository.findForUpdate({
            telegramUpdateId: updateId,
            telegramUserId: question.telegramUserId,
            telegramChatId: question.telegramChatId,
            role: "assistant",
          });
          if (stored === null) {
            retryBlocked = true;
          } else if (stored) {
            existingAssistant = true;
            existingAnswer = stored.text;
          }
        }
        persisted = true;
        return retryBlocked
          ? { ...result, retryBlocked: true }
          : existingAnswer === undefined ? result : { ...result, existingAnswer };
      },
      retrieve: dependencies.retrieve,
      complete: dependencies.complete,
      models: dependencies.models as Record<ModelProfile, string>,
      recordUsage: (usage: AnswerUsage) => dependencies.recordUsage(question.telegramUserId, usage),
    });
    if (retryBlocked) {
      // ponytail: operator repair/requeue is the bounded path for legacy in-flight updates.
      throw new Error("Stored answer recovery is unavailable; operator repair is required.");
    }
    if (persisted && !existingAssistant) await repository.append({ ...persistenceInput, role: "assistant", text: answer });
    return answer;
  };
}
