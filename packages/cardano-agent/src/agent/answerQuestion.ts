import {
  findWalletSecret,
  findWalletSecretInFragments,
} from "../security/walletSecrets.js";

export const RETENTION_NOTICE =
  "Vennek lưu lịch sử hội thoại vô thời hạn để duy trì ngữ cảnh; dữ liệu không được dùng để huấn luyện nếu chưa có sự đồng ý riêng. Đừng gửi seed phrase hoặc private key.";

export type QuestionInput = {
  telegramUserId: string;
  telegramChatId: string;
  text: string;
};

export type QuestionEvidenceTrustTier = "official" | "community" | "unverified";

export type QuestionEvidence = {
  id: string;
  sourceId: string;
  trustTier: QuestionEvidenceTrustTier;
  title: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
  retrievedAt: string;
  versionHash: string;
  score: number;
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

export type QuestionCompletionInput = {
  question: string;
  language: QuestionLanguage;
  evidence: readonly QuestionEvidence[];
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
  if (!firstInteraction) return answer;
  const withoutDuplicateNotice = answer.split(RETENTION_NOTICE).join("").trim();
  return `${RETENTION_NOTICE}\n\n${withoutDuplicateNotice}`;
}

const MISSING = Symbol("missing");
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 16_384;
const MAX_EVIDENCE_COUNT = 10;
const MAX_EVIDENCE_RECORD_BYTES = 16_384;
const MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024;
const MAX_EVIDENCE_WINDOW_BYTES = 16_384;
const EVIDENCE_WINDOW_OVERLAP = 4_096;
const FIELD_LIMITS = {
  id: 256,
  sourceId: 256,
  title: 2_048,
  url: 2_048,
  excerpt: 16_384,
  publishedAt: 64,
  retrievedAt: 64,
  versionHash: 256,
} as const;

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

function hasOwnProperty(value: object, key: PropertyKey): boolean {
  try {
    return Object.getOwnPropertyDescriptor(value, key) !== undefined;
  } catch {
    return true;
  }
}

function boundedText(value: unknown, limit: number, requireContent = true): string | undefined {
  if (typeof value !== "string" || value.length > limit || Buffer.byteLength(value, "utf8") > limit) {
    return undefined;
  }
  if (requireContent && !value.trim()) return undefined;
  return value;
}

function canonicalQuestionInput(value: unknown): QuestionInput | undefined {
  if (!isPlainRecord(value)) return undefined;
  const telegramUserId = readOwnDataProperty(value, "telegramUserId");
  const telegramChatId = readOwnDataProperty(value, "telegramChatId");
  const text = readOwnDataProperty(value, "text");
  const userId = boundedText(telegramUserId, MAX_ID_LENGTH);
  const chatId = boundedText(telegramChatId, MAX_ID_LENGTH);
  const questionText = boundedText(text, MAX_TEXT_LENGTH);
  if (!userId || !chatId || !questionText) return undefined;
  return Object.freeze({ telegramUserId: userId, telegramChatId: chatId, text: questionText }) as QuestionInput;
}

function questionContainsWalletSecret(question: QuestionInput): boolean {
  const fields = [question.telegramUserId, question.telegramChatId, question.text];
  if (fields.some((field) => findWalletSecret(field) !== undefined)) return true;
  return scanBoundedText(fields.join(" "));
}

function validTimestamp(value: unknown, limit: number): value is string {
  const text = boundedText(value, limit);
  return text !== undefined && Number.isFinite(Date.parse(text));
}

type CanonicalUrl = {
  value: string;
  decodedParts: readonly string[];
};

const MAX_URL_DECODE_DEPTH = 3;
const MAX_URL_PARTS = 64;

function decodeUrlPart(value: string, plusAsSpace = false): string | undefined {
  let current = plusAsSpace ? value.replace(/\+/g, " ") : value;
  for (let depth = 0; depth < MAX_URL_DECODE_DEPTH; depth += 1) {
    if (/%(?![0-9a-f]{2})/iu.test(current)) return undefined;
    if (!/%[0-9a-f]{2}/iu.test(current)) return current;
    try {
      current = decodeURIComponent(current);
    } catch {
      return undefined;
    }
  }
  return /%(?![0-9a-f]{2})/iu.test(current) || /%[0-9a-f]{2}/iu.test(current)
    ? undefined
    : current;
}

function canonicalUrl(value: unknown): CanonicalUrl | undefined {
  const text = boundedText(value, FIELD_LIMITS.url);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return undefined;
    }
    const decodedParts: string[] = [];
    const addPart = (part: string, plusAsSpace = false): boolean => {
      const decoded = decodeUrlPart(part, plusAsSpace);
      if (decoded === undefined) return false;
      if (decodedParts.length >= MAX_URL_PARTS) return false;
      if (Buffer.byteLength(decoded, "utf8") > FIELD_LIMITS.url) return false;
      decodedParts.push(decoded);
      return true;
    };

    if (!addPart(url.pathname)) return undefined;
    const rawQuery = url.search.slice(1);
    if (rawQuery) {
      const queryParts = rawQuery.split("&");
      if (queryParts.length > MAX_URL_PARTS) return undefined;
      for (const part of queryParts) {
        const separator = part.indexOf("=");
        const key = separator < 0 ? part : part.slice(0, separator);
        const queryValue = separator < 0 ? "" : part.slice(separator + 1);
        if (!addPart(key, true) || !addPart(queryValue, true)) return undefined;
      }
    }
    if (!addPart(url.hash.slice(1))) return undefined;

    const canonical = boundedText(url.toString(), FIELD_LIMITS.url);
    return canonical ? { value: canonical, decodedParts } : undefined;
  } catch {
    return undefined;
  }
}

function isTrustTier(value: unknown): value is QuestionEvidenceTrustTier {
  return value === "official" || value === "community" || value === "unverified";
}

type CanonicalEvidence = {
  record: QuestionEvidence;
  sourceValues: readonly string[];
  decodedUrlParts: readonly string[];
};

function canonicalEvidenceRecord(value: unknown): CanonicalEvidence | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = boundedText(readOwnDataProperty(value, "id"), FIELD_LIMITS.id);
  const sourceId = boundedText(readOwnDataProperty(value, "sourceId"), FIELD_LIMITS.sourceId);
  const trustTier = readOwnDataProperty(value, "trustTier");
  const title = boundedText(readOwnDataProperty(value, "title"), FIELD_LIMITS.title);
  const url = canonicalUrl(readOwnDataProperty(value, "url"));
  const excerpt = boundedText(readOwnDataProperty(value, "excerpt"), FIELD_LIMITS.excerpt);
  const publishedAt = readOwnDataProperty(value, "publishedAt");
  const retrievedAt = readOwnDataProperty(value, "retrievedAt");
  const versionHash = boundedText(readOwnDataProperty(value, "versionHash"), FIELD_LIMITS.versionHash);
  const score = readOwnDataProperty(value, "score");

  if (
    !id ||
    !sourceId ||
    !isTrustTier(trustTier) ||
    !title ||
    !url ||
    !excerpt ||
    !validTimestamp(retrievedAt, FIELD_LIMITS.retrievedAt) ||
    !versionHash ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) {
    return undefined;
  }
  if (
    hasOwnProperty(value, "publishedAt") &&
    (publishedAt === MISSING ||
      (publishedAt !== undefined && !validTimestamp(publishedAt, FIELD_LIMITS.publishedAt)))
  ) {
    return undefined;
  }

  const canonical: QuestionEvidence = {
    id,
    sourceId,
    trustTier,
    title,
    url: url.value,
    excerpt,
    retrievedAt,
    versionHash,
    score,
  };
  if (publishedAt !== MISSING && publishedAt !== undefined) canonical.publishedAt = publishedAt as string;
  const sourceValues = [
    canonical.id,
    canonical.sourceId,
    canonical.title,
    canonical.url,
    canonical.excerpt,
    canonical.versionHash,
  ];
  return {
    record: Object.freeze(canonical),
    sourceValues: Object.freeze(sourceValues),
    decodedUrlParts: Object.freeze(url.decodedParts),
  };
}

function evidenceRecordText(record: QuestionEvidence): string {
  return [
    "id", record.id,
    "sourceId", record.sourceId,
    "trustTier", record.trustTier,
    "title", record.title,
    "url", record.url,
    "excerpt", record.excerpt,
    ...(record.publishedAt ? ["publishedAt", record.publishedAt] : []),
    "retrievedAt", record.retrievedAt,
    "versionHash", record.versionHash,
    "score", String(record.score),
  ].join(" ");
}

function nextWindowEnd(text: string, start: number): number {
  let end = start;
  let bytes = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_EVIDENCE_WINDOW_BYTES) break;
    bytes += characterBytes;
    end += character.length;
  }
  return end;
}

function scanBoundedText(text: string): boolean {
  let start = 0;
  while (start < text.length) {
    const end = nextWindowEnd(text, start);
    if (end <= start || findWalletSecret(text.slice(start, end))) return true;
    if (end === text.length) return false;
    start = Math.max(start + 1, end - EVIDENCE_WINDOW_OVERLAP);
  }
  return false;
}

type EvidenceSnapshot = {
  records: readonly QuestionEvidence[];
  containsSecret: boolean;
};

function containsStructuredSecret(groups: readonly (readonly string[])[]): boolean {
  for (const group of groups) {
    if (findWalletSecretInFragments(group) !== undefined) return true;
  }
  return false;
}

function snapshotEvidence(value: unknown): EvidenceSnapshot | undefined {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return undefined;
  }
  if (!isArray || typeof value !== "object" || value === null) return undefined;

  const lengthValue = readOwnDataProperty(value, "length");
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > MAX_EVIDENCE_COUNT) {
    return undefined;
  }
  try {
    if ((value as { length: unknown }).length !== lengthValue || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  } catch {
    return undefined;
  }

  const records: QuestionEvidence[] = [];
  const canonicalRecords: CanonicalEvidence[] = [];
  const fieldGroups: string[][] = Array.from({ length: 6 }, () => []);
  const flattenedValues: string[] = [];
  const decodedUrlValues: string[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < lengthValue; index += 1) {
    const item = readOwnDataProperty(value, String(index));
    if (item === MISSING) return undefined;
    const canonical = canonicalEvidenceRecord(item);
    if (!canonical) return undefined;
    const recordText = evidenceRecordText(canonical.record);
    const recordBytes = Buffer.byteLength(recordText, "utf8");
    const decodedBytes = canonical.decodedUrlParts.reduce(
      (total, part) => total + Buffer.byteLength(part, "utf8"),
      0,
    );
    if (
      recordBytes > MAX_EVIDENCE_RECORD_BYTES ||
      recordBytes + decodedBytes > MAX_EVIDENCE_RECORD_BYTES ||
      aggregateBytes + recordBytes + decodedBytes + 1 > MAX_EVIDENCE_TOTAL_BYTES
    ) {
      return undefined;
    }
    aggregateBytes += recordBytes + decodedBytes + 1;
    records.push(canonical.record);
    canonicalRecords.push(canonical);
    flattenedValues.push(...canonical.sourceValues);
    decodedUrlValues.push(...canonical.decodedUrlParts);
    for (let fieldIndex = 0; fieldIndex < canonical.sourceValues.length; fieldIndex += 1) {
      fieldGroups[fieldIndex]!.push(canonical.sourceValues[fieldIndex]!);
    }
  }

  const frozenRecords = Object.freeze(records);
  const recordGroups = canonicalRecords.map(({ sourceValues, decodedUrlParts }) => [
    ...sourceValues,
    ...decodedUrlParts,
  ]);
  if (
    containsStructuredSecret(recordGroups) ||
    containsStructuredSecret(fieldGroups) ||
    containsStructuredSecret([flattenedValues]) ||
    containsStructuredSecret([[...flattenedValues, ...decodedUrlValues]]) ||
    containsStructuredSecret([decodedUrlValues])
  ) {
    return { records: frozenRecords, containsSecret: true };
  }
  return { records: frozenRecords, containsSecret: false };
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

    const retrieved = await dependencies.retrieve({
      question: question.text,
      language,
    });
    const evidenceSnapshot = snapshotEvidence(retrieved);
    if (!evidenceSnapshot) return withNotice(MESSAGES[language].dependency, firstInteraction);
    if (evidenceSnapshot.records.length === 0) {
      return withNotice(MESSAGES[language].insufficient, firstInteraction);
    }

    if (questionContainsWalletSecret(question)) return withNotice(MESSAGES[language].secret, firstInteraction);
    if (evidenceSnapshot.containsSecret) {
      return withNotice(MESSAGES[language].secret, firstInteraction);
    }
    const completed = await dependencies.complete({
      question: question.text,
      language,
      evidence: evidenceSnapshot.records,
    });
    if (typeof completed !== "string" || !completed.trim()) {
      return withNotice(MESSAGES[language].dependency, firstInteraction);
    }
    if (findWalletSecret(completed)) return withNotice(MESSAGES[language].secret, firstInteraction);
    return withNotice(completed.trim(), firstInteraction);
  } catch {
    const failure = MESSAGES[language].dependency;
    return persisted ? withNotice(failure, firstInteraction) : failure;
  }
}
