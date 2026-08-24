export type TelegramAnswerJob = {
  updateId: number;
  telegramUserId: string;
  telegramChatId: string;
  text: string;
};

type PgBossSendOptions = {
  singletonKey: string;
  retryLimit: number;
  retryBackoff: boolean;
};

export type PgBossLike = {
  send(name: string, data: TelegramAnswerJob, options: PgBossSendOptions): Promise<string | null>;
};

export type AgentQueue = {
  enqueue(job: TelegramAnswerJob): Promise<boolean>;
};

export class PgBossAgentQueue implements AgentQueue {
  constructor(private readonly boss: PgBossLike) {}

  async enqueue(job: TelegramAnswerJob): Promise<boolean> {
    const id = await this.boss.send("telegram-answer", job, {
      singletonKey: String(job.updateId),
      retryLimit: 3,
      retryBackoff: true,
    });
    return id !== null;
  }
}
