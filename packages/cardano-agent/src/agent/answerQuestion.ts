import { findWalletSecret } from "../security/walletSecrets.js";

export const RETENTION_NOTICE =
  "Vennek lưu lịch sử hội thoại vô thời hạn để duy trì ngữ cảnh; dữ liệu không được dùng để huấn luyện nếu chưa có sự đồng ý riêng. Đừng gửi seed phrase hoặc private key.";

export type QuestionInput = {
  telegramUserId: string;
  telegramChatId: string;
  text: string;
};

export type QuestionLanguage = "vi" | "en";

export type QuestionEvidence = unknown;

export type QuestionPersistenceResult = {
  firstInteraction?: boolean;
};

export type QuestionCompletionInput = {
  question: string;
  language: QuestionLanguage;
  evidence: QuestionEvidence[];
};

export type QuestionRetrievalInput = {
  question: string;
  language: QuestionLanguage;
};

export type AnswerQuestionDependencies = {
  persist: (
    input: QuestionInput,
  ) => Promise<QuestionPersistenceResult | void>;
  retrieve: (input: QuestionRetrievalInput) => Promise<unknown>;
  complete: (input: QuestionCompletionInput) => Promise<unknown>;
};

const INVALID_INPUT = {
  vi: "Xin lỗi, tôi chưa thể xử lý yêu cầu này an toàn.",
  en: "Sorry, I can't process this request safely.",
} as const;

const DEPENDENCY_FAILURE = {
  vi: "Xin lỗi, hiện chưa thể xử lý câu hỏi này an toàn.",
  en: "Sorry, I can't process this question safely right now.",
} as const;

const INSUFFICIENT_EVIDENCE = {
  vi: "Hiện chưa có đủ nguồn đáng tin cậy để trả lời câu hỏi này.",
  en: "I don't have enough reliable sources to answer this question yet.",
} as const;

const SECRET_WARNING = {
  vi: "Đừng gửi seed phrase hoặc private key vào đây. Vui lòng xóa nội dung đó khỏi cuộc trò chuyện.",
  en: "Do not send wallet secrets such as a seed phrase or private key here. Please remove them from the conversation.",
} as const;

const GREETING = {
  vi: "Xin chào! Tôi có thể trả lời các câu hỏi về Cardano.",
  en: "Hello! I can answer questions about Cardano.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function languageFor(text: unknown): QuestionLanguage {
  if (typeof text !== "string") return "en";
  return /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu.test(text) ||
    /\b(xin\s+chao|chao|toi|ban|la|gi|khong|duoc|the\s+nao|cam\s+on)\b/iu.test(
      text.normalize("NFD").replace(/\p{Diacritic}/gu, ""),
    )
    ? "vi"
    : "en";
}

function normalizedGreeting(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isGreeting(text: string): boolean {
  return /^(?:xin chao|chao(?: ban)?|hello(?: there| cardano)?|hi|hey)$/u.test(
    normalizedGreeting(text),
  );
}

function validQuestionInput(value: unknown): value is QuestionInput {
  if (!isRecord(value)) return false;
  return ["telegramUserId", "telegramChatId", "text"].every((field) => {
    const fieldValue = value[field];
    return typeof fieldValue === "string" && fieldValue.trim().length > 0 && fieldValue.length <= 16_384;
  });
}

function validDependencies(value: unknown): value is AnswerQuestionDependencies {
  return (
    isRecord(value) &&
    typeof value.persist === "function" &&
    typeof value.retrieve === "function" &&
    typeof value.complete === "function"
  );
}

function firstInteractionFrom(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) throw new Error("Persistence result is invalid");
  if (value.firstInteraction !== undefined && typeof value.firstInteraction !== "boolean") {
    throw new Error("Persistence result is invalid");
  }
  return value.firstInteraction === true;
}

function withNotice(answer: string, firstInteraction: boolean): string {
  return firstInteraction ? `${RETENTION_NOTICE}\n\n${answer}` : answer;
}

export async function answerQuestion(
  input: unknown,
  dependencies: unknown,
): Promise<string> {
  let language: QuestionLanguage = "en";
  try {
    language = languageFor(isRecord(input) ? input.text : undefined);
    if (!validQuestionInput(input)) return INVALID_INPUT[language];

    const question = { ...input };
    const secretKind = findWalletSecret(question.text);
    if (secretKind) return SECRET_WARNING[language];
    if (!validDependencies(dependencies)) return DEPENDENCY_FAILURE[language];

    const persisted = await dependencies.persist(question);
    const firstInteraction = firstInteractionFrom(persisted);
    if (findWalletSecret(question.text)) return SECRET_WARNING[language];

    if (isGreeting(question.text)) {
      return withNotice(GREETING[language], firstInteraction);
    }

    const retrieved = await dependencies.retrieve({
      question: question.text,
      language,
    });
    if (!Array.isArray(retrieved)) return DEPENDENCY_FAILURE[language];
    if (retrieved.length === 0) {
      return withNotice(INSUFFICIENT_EVIDENCE[language], firstInteraction);
    }

    if (findWalletSecret(question.text)) return SECRET_WARNING[language];
    const completed = await dependencies.complete({
      question: question.text,
      language,
      evidence: retrieved,
    });
    if (typeof completed !== "string" || !completed.trim()) {
      return DEPENDENCY_FAILURE[language];
    }
    if (findWalletSecret(completed)) return SECRET_WARNING[language];
    return withNotice(completed.trim(), firstInteraction);
  } catch {
    return DEPENDENCY_FAILURE[language];
  }
}
