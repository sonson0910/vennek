import { findWalletSecret } from "../security/walletSecrets.js";

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
  ["vi", /[ăâđêôơưạảãấầẩẫậắằẳẵặẹẻẽếềểễệỉĩịọỏõốồổỗộớờởỡợụủũứừửữựỷỹỵ]/iu],
  ["ja", /[ぁ-ゖァ-ヺ]/u],
  ["ko", /[가-힣]/u],
  ["ar", /[\u0600-\u06ff]/u],
  ["hi", /[\u0900-\u097f]/u],
  ["th", /[\u0e00-\u0e7f]/u],
  ["ru", /[а-яё]/iu],
  ["zh", /[一-龯]/u],
  ["es", /[¿¡]|\b(qué|cómo|hola|gracias|fuentes|fiables|para|pregunta)\b/iu],
  ["fr", /\b(bonjour|salut|merci|sources|fiables|question|réponse)\b/iu],
  ["de", /[äöüß]|\b(hallo|danke|quellen|frage|antwort)\b/iu],
  ["pt", /\b(olá|você|não|obrigado|fontes|pergunta)\b/iu],
  ["id", /\b(halo|apa|terima|kasih|sumber|pertanyaan)\b/iu],
  ["tr", /[çğıöşü]|\b(merhaba|teşekkür|kaynak|soru)\b/iu],
];

function languageFor(text: unknown): QuestionLanguage {
  if (typeof text !== "string") return "en";
  if (text.length > 16_384) return "en";
  for (const [language, detector] of LANGUAGE_DETECTORS) {
    if (detector.test(text)) return language;
  }
  if (/\b(xin\s+chao|chao|toi|ban|la|gi|khong|duoc|the\s+nao|cam\s+on)\b/iu.test(
    text.normalize("NFD").replace(/\p{Diacritic}/gu, ""),
  )) {
    return "vi";
  }
  return "en";
}

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
  tr: /^(?:merhaba|selam|günaydın|gunaydin)$/u,
};

function isGreeting(text: string, language: QuestionLanguage): boolean {
  return GREETING_PATTERNS[language].test(normalizedGreeting(text));
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
  if (!firstInteraction) return answer;
  const withoutDuplicateNotice = answer.split(RETENTION_NOTICE).join("").trim();
  return `${RETENTION_NOTICE}\n\n${withoutDuplicateNotice}`;
}

const MAX_EVIDENCE_DEPTH = 8;
const MAX_EVIDENCE_NODES = 256;
const MAX_EVIDENCE_STRING_BYTES = 16_384;

function evidenceContainsWalletSecret(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) return true;
    if (++nodes > MAX_EVIDENCE_NODES) return true;

    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_EVIDENCE_STRING_BYTES) return true;
      if (findWalletSecret(current.value)) return true;
      continue;
    }
    if (current.value === null || current.value === undefined) continue;
    if (typeof current.value !== "object") {
      if (typeof current.value === "function") return true;
      continue;
    }
    if (current.depth >= MAX_EVIDENCE_DEPTH || visited.has(current.value)) return true;
    visited.add(current.value);

    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(current.value);
    } catch {
      return true;
    }
    if (keys.length > MAX_EVIDENCE_NODES) return true;
    for (const key of keys) {
      if (typeof key === "string") {
        if (Buffer.byteLength(key, "utf8") > MAX_EVIDENCE_STRING_BYTES) return true;
        if (findWalletSecret(key)) return true;
      }
      try {
        if (pending.length >= MAX_EVIDENCE_NODES) return true;
        pending.push({ value: Reflect.get(current.value, key), depth: current.depth + 1 });
      } catch {
        return true;
      }
    }
  }
  return false;
}

export async function answerQuestion(
  input: unknown,
  dependencies: unknown,
): Promise<string> {
  let language: QuestionLanguage = "en";
  let persisted = false;
  let firstInteraction = false;
  try {
    language = languageFor(isRecord(input) ? input.text : undefined);
    if (!validQuestionInput(input)) return MESSAGES[language].invalid;

    const question = { ...input };
    const secretKind = findWalletSecret(question.text);
    if (secretKind) return MESSAGES[language].secret;
    if (!validDependencies(dependencies)) return MESSAGES[language].dependency;

    const persistenceResult = await dependencies.persist(question);
    firstInteraction = firstInteractionFrom(persistenceResult);
    persisted = true;
    if (findWalletSecret(question.text)) return withNotice(MESSAGES[language].secret, firstInteraction);

    if (isGreeting(question.text, language)) {
      return withNotice(MESSAGES[language].greeting, firstInteraction);
    }

    const retrieved = await dependencies.retrieve({
      question: question.text,
      language,
    });
    if (!Array.isArray(retrieved)) return withNotice(MESSAGES[language].dependency, firstInteraction);
    if (retrieved.length === 0) {
      return withNotice(MESSAGES[language].insufficient, firstInteraction);
    }

    if (findWalletSecret(question.text)) return withNotice(MESSAGES[language].secret, firstInteraction);
    if (evidenceContainsWalletSecret(retrieved)) {
      return withNotice(MESSAGES[language].secret, firstInteraction);
    }
    const completed = await dependencies.complete({
      question: question.text,
      language,
      evidence: retrieved,
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
