import { findWalletSecret } from "../security/walletSecrets.js";
import type { ChatMessage, CompletionOutput } from "../llm/liteLlmClient.js";
import { selectModelProfile, type ModelProfile } from "../llm/modelRouter.js";
import {
  buildGroundedMessages,
  parseGeneratedAnswer,
  snapshotEvidence,
  type GroundedEvidence,
} from "./groundedPrompt.js";
import { renderAnswer } from "./renderAnswer.js";
import { verifyClaims } from "./verifyClaims.js";

export const RETENTION_NOTICE =
  "Vennek lưu lịch sử hội thoại vô thời hạn để duy trì ngữ cảnh; dữ liệu không được dùng để huấn luyện nếu chưa có sự đồng ý riêng. Đừng gửi seed phrase hoặc private key.";

export type QuestionInput = {
  telegramUserId: string;
  telegramChatId: string;
  text: string;
};

export type QuestionLanguage =
  | "vi"
  | "en"
  | "es"
  | "ja"
  | "zh"
  | "ko"
  | "ru"
  | "ar"
  | "hi"
  | "th"
  | "fr"
  | "de"
  | "pt"
  | "id"
  | "tr";

export type QuestionPersistenceResult = {
  firstInteraction?: boolean;
};

export type QuestionRetrievalInput = {
  question: string;
  language: QuestionLanguage;
};

export type AnswerUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

export type AnswerCompletionInput = {
  model: string;
  messages: ChatMessage[];
  temperature: 0;
};

export type AnswerQuestionDependencies = {
  persist: (
    input: QuestionInput,
  ) => Promise<QuestionPersistenceResult | void>;
  retrieve: (input: QuestionRetrievalInput) => Promise<unknown>;
  discover?: (input: QuestionRetrievalInput) => Promise<void>;
  complete?: (input: AnswerCompletionInput) => Promise<CompletionOutput>;
  models?: Record<ModelProfile, string>;
  recordUsage?: (usage: AnswerUsage) => Promise<void> | void;
};

type LocalizedMessages = {
  invalid: string;
  dependency: string;
  insufficient: string;
  secret: string;
  greeting: string;
};

const MESSAGES: Record<QuestionLanguage, LocalizedMessages> = {
  vi: {
    invalid: "Xin lỗi, tôi chưa thể xử lý yêu cầu này an toàn.",
    dependency: "Xin lỗi, hiện chưa thể xử lý câu hỏi này an toàn.",
    insufficient: "Hiện chưa có đủ nguồn đáng tin cậy để trả lời câu hỏi này.",
    secret: "Đừng gửi seed phrase hoặc private key vào đây. Vui lòng xóa nội dung đó khỏi cuộc trò chuyện.",
    greeting: "Xin chào! Tôi có thể trả lời các câu hỏi về Cardano.",
  },
  en: {
    invalid: "Sorry, I can't process this request safely.",
    dependency: "Sorry, I can't process this question safely right now.",
    insufficient: "I don't have enough reliable sources to answer this question yet.",
    secret: "Do not send wallet secrets such as a seed phrase or private key here. Please remove them from the conversation.",
    greeting: "Hello! I can answer questions about Cardano.",
  },
  es: {
    invalid: "Lo siento, no puedo procesar esta solicitud de forma segura.",
    dependency: "Lo siento, ahora no puedo procesar esta pregunta de forma segura.",
    insufficient: "Todavía no tengo suficientes fuentes fiables para responder a esta pregunta.",
    secret: "No envíes secretos de la cartera, como una seed phrase o una clave privada. Elimina ese contenido de la conversación.",
    greeting: "¡Hola! Puedo responder preguntas sobre Cardano.",
  },
  ja: {
    invalid: "申し訳ありません。このリクエストは安全に処理できません。",
    dependency: "申し訳ありません。今はこの質問を安全に処理できません。",
    insufficient: "この質問に答えるための信頼できる情報源がまだ十分にありません。",
    secret: "シードフレーズや秘密鍵などのウォレット秘密情報を送らないでください。会話からその内容を削除してください。",
    greeting: "こんにちは！Cardanoについて質問に答えられます。",
  },
  zh: {
    invalid: "抱歉，无法安全处理此请求。",
    dependency: "抱歉，目前无法安全处理这个问题。",
    insufficient: "目前没有足够可靠的来源来回答这个问题。",
    secret: "请勿发送助记词或私钥等钱包秘密信息，并从对话中删除这些内容。",
    greeting: "你好！我可以回答关于 Cardano 的问题。",
  },
  ko: {
    invalid: "죄송합니다. 이 요청을 안전하게 처리할 수 없습니다.",
    dependency: "죄송합니다. 지금은 이 질문을 안전하게 처리할 수 없습니다.",
    insufficient: "이 질문에 답할 신뢰할 수 있는 출처가 아직 충분하지 않습니다.",
    secret: "시드 문구나 개인 키 같은 지갑 비밀 정보를 보내지 말고 대화에서 삭제해 주세요.",
    greeting: "안녕하세요! Cardano에 관한 질문에 답할 수 있습니다.",
  },
  ru: {
    invalid: "Извините, этот запрос нельзя безопасно обработать.",
    dependency: "Извините, сейчас нельзя безопасно обработать этот вопрос.",
    insufficient: "Пока недостаточно надёжных источников, чтобы ответить на этот вопрос.",
    secret: "Не отправляйте seed-фразу или закрытый ключ. Удалите эти данные из переписки.",
    greeting: "Здравствуйте! Я могу отвечать на вопросы о Cardano.",
  },
  ar: {
    invalid: "عذراً، لا يمكن معالجة هذا الطلب بأمان.",
    dependency: "عذراً، لا يمكن معالجة هذا السؤال بأمان الآن.",
    insufficient: "لا توجد مصادر موثوقة كافية للإجابة عن هذا السؤال حتى الآن.",
    secret: "لا ترسل عبارة الاسترداد أو المفتاح الخاص. احذف هذه البيانات من المحادثة.",
    greeting: "مرحباً! يمكنني الإجابة عن أسئلة Cardano.",
  },
  hi: {
    invalid: "क्षमा करें, इस अनुरोध को सुरक्षित रूप से संसाधित नहीं किया जा सकता।",
    dependency: "क्षमा करें, अभी इस प्रश्न को सुरक्षित रूप से संसाधित नहीं किया जा सकता।",
    insufficient: "इस प्रश्न का उत्तर देने के लिए अभी पर्याप्त विश्वसनीय स्रोत नहीं हैं।",
    secret: "सीड वाक्यांश या निजी कुंजी जैसी वॉलेट गोपनीय जानकारी न भेजें और इसे बातचीत से हटा दें।",
    greeting: "नमस्ते! मैं Cardano के बारे में प्रश्नों का उत्तर दे सकता हूँ।",
  },
  th: {
    invalid: "ขออภัย ไม่สามารถประมวลผลคำขอนี้อย่างปลอดภัยได้",
    dependency: "ขออภัย ขณะนี้ไม่สามารถประมวลผลคำถามนี้อย่างปลอดภัยได้",
    insufficient: "ยังมีแหล่งข้อมูลที่น่าเชื่อถือไม่เพียงพอสำหรับตอบคำถามนี้",
    secret: "อย่าส่ง seed phrase หรือ private key และโปรดลบข้อมูลนี้ออกจากการสนทนา",
    greeting: "สวัสดี! ฉันตอบคำถามเกี่ยวกับ Cardano ได้",
  },
  fr: {
    invalid: "Désolé, cette demande ne peut pas être traitée en toute sécurité.",
    dependency: "Désolé, cette question ne peut pas être traitée en toute sécurité pour le moment.",
    insufficient: "Je n'ai pas encore assez de sources fiables pour répondre à cette question.",
    secret: "N'envoyez pas de seed phrase ou de clé privée. Supprimez ces données de la conversation.",
    greeting: "Bonjour ! Je peux répondre aux questions sur Cardano.",
  },
  de: {
    invalid: "Entschuldigung, diese Anfrage kann nicht sicher verarbeitet werden.",
    dependency: "Entschuldigung, diese Frage kann derzeit nicht sicher verarbeitet werden.",
    insufficient: "Es gibt noch nicht genügend verlässliche Quellen für eine Antwort auf diese Frage.",
    secret: "Senden Sie keine Seed-Phrase oder keinen privaten Schlüssel. Löschen Sie diese Daten aus dem Chat.",
    greeting: "Hallo! Ich kann Fragen zu Cardano beantworten.",
  },
  pt: {
    invalid: "Desculpe, não é possível processar este pedido com segurança.",
    dependency: "Desculpe, não é possível processar esta pergunta com segurança agora.",
    insufficient: "Ainda não tenho fontes confiáveis suficientes para responder a esta pergunta.",
    secret: "Não envie seed phrase ou chave privada. Remova esses dados da conversa.",
    greeting: "Olá! Posso responder a perguntas sobre Cardano.",
  },
  id: {
    invalid: "Maaf, permintaan ini tidak dapat diproses dengan aman.",
    dependency: "Maaf, pertanyaan ini belum dapat diproses dengan aman.",
    insufficient: "Belum ada cukup sumber tepercaya untuk menjawab pertanyaan ini.",
    secret: "Jangan kirim seed phrase atau private key. Hapus data tersebut dari percakapan.",
    greeting: "Halo! Saya dapat menjawab pertanyaan tentang Cardano.",
  },
  tr: {
    invalid: "Üzgünüm, bu istek güvenli şekilde işlenemiyor.",
    dependency: "Üzgünüm, bu soru şu anda güvenli şekilde işlenemiyor.",
    insufficient: "Bu soruyu yanıtlamak için henüz yeterli güvenilir kaynak yok.",
    secret: "Seed phrase veya özel anahtar göndermeyin. Bu bilgileri sohbetten silin.",
    greeting: "Merhaba! Cardano hakkındaki soruları yanıtlayabilirim.",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LANGUAGE_DETECTORS: ReadonlyArray<readonly [QuestionLanguage, RegExp]> = [
  ["vi", /[ăâđôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉĩịọỏốồổỗộớờởỡợụủũứừửữựỷỹỵ]/iu],
  ["vi", /\b(xin\s+ch(?:a|à)o|ch(?:a|à)o\s+b(?:a|ạ)n|kh(?:o|ô)ng|được|duoc|th(?:e|ế)\s+nao|c(?:a|ả)m\s+ơn)\b/iu],
  ["ja", /[ぁ-ゖァ-ヺ]/u],
  ["ko", /[가-힣]/u],
  ["ar", /[\u0600-\u06ff]/u],
  ["hi", /[\u0900-\u097f]/u],
  ["th", /[\u0e00-\u0e7f]/u],
  ["ru", /[а-яё]/iu],
  ["zh", /[一-龯]/u],
  ["es", /[¿¡]|\b(qué|cómo|dónde|por\s+qué|hola|gracias|español)\b/iu],
  ["fr", /\b(bonjour|salut|merci|français|réponse|pourquoi|être)\b/iu],
  ["pt", /\b(para\s+que|olá|você|não|obrigad[oa]|português)\b/iu],
  ["id", /\b(halo|apa|terima|kasih|sumber|pertanyaan|bahasa)\b/iu],
  ["tr", /[ğıış]|\b(merhaba|teşekkür|kaynak|soru|türkçe|nasıl)\b/iu],
  ["de", /[äöüß]|\b(hallo|danke|bitte|deutsch|antwort|warum)\b/iu],
];

function normalizedGreeting(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const GREETING_PATTERNS: Record<QuestionLanguage, RegExp> = {
  vi: /^(?:xin chào|xin chao|chào(?: bạn)?|chao(?: ban)?)$/u,
  en: /^(?:hello(?: there| cardano)?|hi|hey)$/u,
  es: /^(?:hola|buenas(?: días| dias| tardes| noches)?)$/u,
  ja: /^(?:こんにちは|こんばんは|おはよう(?:ございます)?)$/u,
  zh: /^(?:你好|您好|嗨|早上好|晚上好)$/u,
  ko: /^(?:안녕하세요|안녕|반가워요)$/u,
  ru: /^(?:привет|здравствуйте|добрый день)$/u,
  ar: /^(?:مرحبا|أهلا|السلام عليكم)$/u,
  hi: /^(?:नमस्ते|नमस्कार|हैलो)$/u,
  th: /^(?:สวัสดี)$/u,
  fr: /^(?:bonjour|salut|bonsoir)$/u,
  de: /^(?:hallo|guten morgen|guten tag|guten abend)$/u,
  pt: /^(?:olá|ola|oi|bom dia|boa tarde|boa noite)$/u,
  id: /^(?:halo|hai|selamat pagi|selamat siang|selamat malam)$/u,
  tr: /^(?:merhaba|selam|günaydın|günaydin|gunaydin)$/u,
};

const GREETING_LANGUAGES = (Object.entries(GREETING_PATTERNS) as Array<
  [QuestionLanguage, RegExp]
>);

function languageFor(text: unknown): QuestionLanguage {
  if (typeof text !== "string") return "en";
  if (text.length > 16_384) return "en";
  const normalized = text.normalize("NFC");
  const greeting = normalizedGreeting(normalized);
  for (const [language, pattern] of GREETING_LANGUAGES) {
    if (pattern.test(greeting)) return language;
  }
  for (const [language, detector] of LANGUAGE_DETECTORS) {
    if (detector.test(normalized)) return language;
  }
  return "en";
}

function isGreeting(text: string, language: QuestionLanguage): boolean {
  return GREETING_PATTERNS[language].test(normalizedGreeting(text));
}

function validDependencies(value: unknown): value is AnswerQuestionDependencies {
  return (
    isRecord(value) &&
    typeof value.persist === "function" &&
    typeof value.retrieve === "function"
  );
}

type ModelSnapshot = Readonly<Record<ModelProfile, string>>;
class WalletSecretConfigurationError extends Error {}

function snapshotModels(value: AnswerQuestionDependencies): ModelSnapshot | undefined {
  if (value.discover !== undefined && typeof value.discover !== "function") {
    throw new Error("Answer discovery dependency is invalid");
  }
  const hasComplete = value.complete !== undefined;
  const configuredModels = value.models;
  const hasModels = configuredModels !== undefined;
  const hasUsage = value.recordUsage !== undefined;
  if (!hasComplete && !hasModels && !hasUsage) return undefined;
  if (!hasComplete || !hasModels || typeof value.complete !== "function" || !isPlainRecord(configuredModels)) {
    throw new Error("Answer generation dependencies are invalid");
  }
  const snapshot: Record<ModelProfile, string> = {
    fast: "",
    quality: "",
    verifier: "",
  };
  for (const profile of ["fast", "quality", "verifier"] as const) {
    // Read each configured model exactly once, including accessor-backed configuration,
    // then use only the frozen snapshot for all provider calls.
    const configured = configuredModels[profile];
    if (
      typeof configured !== "string" ||
      !configured ||
      configured.trim() !== configured ||
      Array.from(configured).length > 128 ||
      Buffer.byteLength(configured, "utf8") > 128 ||
      /[\p{Cc}\p{Cf}]/u.test(configured)
    ) {
      throw new Error("Answer model configuration is invalid");
    }
    if (findWalletSecret(configured)) throw new WalletSecretConfigurationError("Answer model configuration contains a wallet secret");
    snapshot[profile] = configured;
  }
  if (value.recordUsage !== undefined && typeof value.recordUsage !== "function") {
    throw new Error("Answer usage dependency is invalid");
  }
  return Object.freeze(snapshot);
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
  if (!firstInteraction) return answer;
  const withoutDuplicateNotice = answer.split(RETENTION_NOTICE).join("").trim();
  return `${RETENTION_NOTICE}\n\n${withoutDuplicateNotice}`;
}

const MISSING = Symbol("missing");
const MAX_ID_LENGTH = 20;
const MAX_TEXT_LENGTH = 16_384;
const USER_ID_PATTERN = /^[1-9][0-9]*$/u;
const CHAT_ID_PATTERN = /^-?[1-9][0-9]*$/u;
const SIGNED_INT64_MIN = BigInt("-9223372036854775808");
const SIGNED_INT64_MAX = BigInt("9223372036854775807");
const ZERO = BigInt(0);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwnDataProperty(value: object, key: PropertyKey): unknown | typeof MISSING {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      return MISSING;
    }
    return descriptor.value;
  } catch {
    return MISSING;
  }
}

function boundedText(value: unknown, limit: number, requireContent = true): string | undefined {
  if (typeof value !== "string" || value.length > limit || Buffer.byteLength(value, "utf8") > limit) {
    return undefined;
  }
  if (requireContent && !value.trim()) return undefined;
  return value;
}

function validTelegramIdentifier(value: unknown, userId: boolean): string | undefined {
  const text = boundedText(value, MAX_ID_LENGTH);
  const pattern = userId ? USER_ID_PATTERN : CHAT_ID_PATTERN;
  if (!text || !pattern.test(text)) return undefined;
  try {
    const number = BigInt(text);
    if (number < SIGNED_INT64_MIN || number > SIGNED_INT64_MAX) return undefined;
    if (userId ? number <= ZERO : number === ZERO) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function canonicalQuestionInput(value: unknown): QuestionInput | undefined {
  if (!isPlainRecord(value)) return undefined;
  const telegramUserId = readOwnDataProperty(value, "telegramUserId");
  const telegramChatId = readOwnDataProperty(value, "telegramChatId");
  const text = readOwnDataProperty(value, "text");
  const userId = validTelegramIdentifier(telegramUserId, true);
  const chatId = validTelegramIdentifier(telegramChatId, false);
  const questionText = boundedText(text, MAX_TEXT_LENGTH);
  if (!userId || !chatId || !questionText) return undefined;
  return Object.freeze({ telegramUserId: userId, telegramChatId: chatId, text: questionText }) as QuestionInput;
}

function questionContainsWalletSecret(question: QuestionInput): boolean {
  const fields = [question.telegramUserId, question.telegramChatId, question.text];
  return fields.some((field) => findWalletSecret(field) !== undefined);
}

function canonicalCompletionOutput(value: unknown, requestedModel: string): CompletionOutput | undefined {
  if (!isPlainRecord(value)) return undefined;
  const text = readOwnDataProperty(value, "text");
  const model = readOwnDataProperty(value, "model");
  const promptTokens = readOwnDataProperty(value, "promptTokens");
  const completionTokens = readOwnDataProperty(value, "completionTokens");
  if (typeof text !== "string" || text.length > 16 * 1024 || Buffer.byteLength(text, "utf8") > 16 * 1024 ||
      typeof model !== "string" || model !== requestedModel || !model.trim() || model !== model.trim() ||
      model.length > 128 || Buffer.byteLength(model, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(model) ||
      typeof promptTokens !== "number" || typeof completionTokens !== "number" ||
      !Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(completionTokens) || promptTokens < 0 || completionTokens < 0) {
    return undefined;
  }
  return Object.freeze({ text, model, promptTokens, completionTokens });
}

class WalletSecretOutputError extends Error {}

async function canonicalComplete(
  dependencies: AnswerQuestionDependencies,
  input: AnswerCompletionInput,
): Promise<CompletionOutput> {
  const output = canonicalCompletionOutput(await dependencies.complete!(input), input.model);
  if (!output) throw new Error("Completion output is invalid");
  return output;
}

async function recordUsage(value: AnswerQuestionDependencies, output: CompletionOutput, startedAt: number): Promise<void> {
  if (!value.recordUsage) return;
  if (findWalletSecret(output.text) || findWalletSecret(output.model)) return;
  const usage = Object.freeze({
    model: output.model,
    promptTokens: output.promptTokens,
    completionTokens: output.completionTokens,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
  try {
    await value.recordUsage(usage);
  } catch {
    // Usage telemetry must never discard an otherwise safe answer.
  }
}

function safeSnapshot(value: unknown): readonly GroundedEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return Object.freeze([]);
  try {
    return snapshotEvidence(value);
  } catch {
    return undefined;
  }
}

function snapshotContainsWalletSecret(evidence: readonly GroundedEvidence[]): boolean {
  try {
    return findWalletSecret(JSON.stringify(evidence)) !== undefined;
  } catch {
    return true;
  }
}

export async function answerQuestion(
  input: unknown,
  dependencies: unknown,
): Promise<string> {
  let language: QuestionLanguage = "en";
  let persisted = false;
  let firstInteraction = false;
  try {
    const inputText = isPlainRecord(input) ? readOwnDataProperty(input, "text") : MISSING;
    language = languageFor(inputText === MISSING ? undefined : inputText);
    const question = canonicalQuestionInput(input);
    if (!question) return MESSAGES[language].invalid;

    if (questionContainsWalletSecret(question)) return MESSAGES[language].secret;
    if (!validDependencies(dependencies)) return MESSAGES[language].dependency;

    const persistenceResult = await dependencies.persist(question);
    firstInteraction = firstInteractionFrom(persistenceResult);
    persisted = true;
    if (questionContainsWalletSecret(question)) return withNotice(MESSAGES[language].secret, firstInteraction);

    if (isGreeting(question.text, language)) {
      return withNotice(MESSAGES[language].greeting, firstInteraction);
    }

    let retrieved = await dependencies.retrieve({
      question: question.text,
      language,
    });
    let evidence = safeSnapshot(retrieved);
    if (!evidence) {
      return withNotice(
        Array.isArray(retrieved) ? MESSAGES[language].insufficient : MESSAGES[language].dependency,
        firstInteraction,
      );
    }
    if ((evidence.length === 0 || evidence.some((item) => item.stale)) && dependencies.discover) {
      try {
        await dependencies.discover({ question: question.text, language });
        retrieved = await dependencies.retrieve({ question: question.text, language });
        const refreshed = safeSnapshot(retrieved);
        if (refreshed && refreshed.length > 0) evidence = refreshed;
      } catch {
        // Keep the bounded original evidence and render stale labels if discovery is unavailable.
      }
    }
    if (evidence.length === 0) return withNotice(MESSAGES[language].insufficient, firstInteraction);
    if (snapshotContainsWalletSecret(evidence)) return withNotice(MESSAGES[language].secret, firstInteraction);
    let models: ModelSnapshot | undefined;
    try {
      models = snapshotModels(dependencies);
    } catch (error) {
      if (error instanceof WalletSecretConfigurationError) {
        return withNotice(MESSAGES[language].secret, firstInteraction);
      }
      throw error;
    }
    if (!models) return withNotice(MESSAGES[language].insufficient, firstInteraction);
    const profile = selectModelProfile({ sourceCount: evidence.length, hasConflicts: false, technical: false });
    const model = models[profile];
    const messages = buildGroundedMessages(question.text, language, evidence);
    const generatedStartedAt = Date.now();
    let generatedOutput: CompletionOutput;
    try {
      generatedOutput = await canonicalComplete(dependencies, { model, messages, temperature: 0 });
    } catch {
      return withNotice(MESSAGES[language].insufficient, firstInteraction);
    }
    if (findWalletSecret(generatedOutput.text) || findWalletSecret(generatedOutput.model)) {
      return withNotice(MESSAGES[language].secret, firstInteraction);
    }
    await recordUsage(dependencies, generatedOutput, generatedStartedAt);
    const generated = parseGeneratedAnswer(generatedOutput.text, language, evidence);
    if (!generated) return withNotice(MESSAGES[language].insufficient, firstInteraction);

    const verifierStartedAt = Date.now();
    let verification: Awaited<ReturnType<typeof verifyClaims>>;
    try {
      verification = await verifyClaims(
        generated,
        evidence,
        (input) => canonicalComplete(dependencies, input),
        models.verifier,
        (output) => {
          if (findWalletSecret(output.text) || findWalletSecret(output.model)) throw new WalletSecretOutputError("Completion output contains wallet secret");
          return recordUsage(dependencies, output, verifierStartedAt);
        },
      );
    } catch (error) {
      if (error instanceof WalletSecretOutputError) return withNotice(MESSAGES[language].secret, firstInteraction);
      return withNotice(MESSAGES[language].insufficient, firstInteraction);
    }
    if (!verification) return withNotice(MESSAGES[language].insufficient, firstInteraction);
    const rendered = renderAnswer(verification.claims, evidence, language);
    if (!rendered || findWalletSecret(rendered)) return withNotice(MESSAGES[language].insufficient, firstInteraction);
    return withNotice(rendered, firstInteraction);
  } catch {
    const failure = MESSAGES[language].dependency;
    return persisted ? withNotice(failure, firstInteraction) : failure;
  }
}
