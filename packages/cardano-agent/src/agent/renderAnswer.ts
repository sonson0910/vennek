import type { QuestionLanguage } from "./answerQuestion.js";
import type { GeneratedAnswer, GeneratedClaim, GroundedEvidence } from "./groundedPrompt.js";

const MAX_ANSWER_CHARS = 3_900;

type RenderLabels = {
  communityOnly: string;
  mixedUnverified: string;
  conflict: string;
  stale: string;
  sources: string;
};

const LABELS: Record<QuestionLanguage, RenderLabels> = {
  vi: { communityOnly: "chỉ cộng đồng", mixedUnverified: "hỗn hợp/chưa xác minh", conflict: "mâu thuẫn", stale: "cũ", sources: "Nguồn" },
  en: { communityOnly: "community-only", mixedUnverified: "mixed/unverified", conflict: "conflict", stale: "stale", sources: "Sources" },
  es: { communityOnly: "solo comunidad", mixedUnverified: "mixto/sin verificar", conflict: "conflicto", stale: "obsoleto", sources: "Fuentes" },
  ja: { communityOnly: "コミュニティのみ", mixedUnverified: "混在/未検証", conflict: "矛盾", stale: "古い", sources: "出典" },
  zh: { communityOnly: "仅社区", mixedUnverified: "混合/未验证", conflict: "冲突", stale: "过时", sources: "来源" },
  ko: { communityOnly: "커뮤니티만", mixedUnverified: "혼합/미검증", conflict: "충돌", stale: "오래됨", sources: "출처" },
  ru: { communityOnly: "только сообщество", mixedUnverified: "смешанные/непроверенные", conflict: "конфликт", stale: "устарело", sources: "Источники" },
  ar: { communityOnly: "مجتمع فقط", mixedUnverified: "مختلطة/غير موثقة", conflict: "تعارض", stale: "قديمة", sources: "المصادر" },
  hi: { communityOnly: "केवल समुदाय", mixedUnverified: "मिश्रित/असत्यापित", conflict: "विरोधाभास", stale: "पुराना", sources: "स्रोत" },
  th: { communityOnly: "ชุมชนเท่านั้น", mixedUnverified: "ผสม/ยังไม่ยืนยัน", conflict: "ขัดแย้ง", stale: "เก่า", sources: "แหล่งที่มา" },
  fr: { communityOnly: "communauté uniquement", mixedUnverified: "mixte/non vérifié", conflict: "conflit", stale: "obsolète", sources: "Sources" },
  de: { communityOnly: "nur Community", mixedUnverified: "gemischt/ungeprüft", conflict: "Konflikt", stale: "veraltet", sources: "Quellen" },
  pt: { communityOnly: "apenas comunidade", mixedUnverified: "misto/não verificado", conflict: "conflito", stale: "desatualizado", sources: "Fontes" },
  id: { communityOnly: "hanya komunitas", mixedUnverified: "campuran/belum terverifikasi", conflict: "konflik", stale: "lama", sources: "Sumber" },
  tr: { communityOnly: "yalnızca topluluk", mixedUnverified: "karma/doğrulanmamış", conflict: "çelişki", stale: "eski", sources: "Kaynaklar" },
};

function safeLabel(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
}

function provenanceKey(item: GroundedEvidence): string {
  return `${item.sourceId}\u0000${item.versionHash}\u0000${item.url}`;
}

function dateLabel(item: GroundedEvidence): string {
  return (item.publishedAt ?? item.retrievedAt).slice(0, 10);
}

function sourceLine(item: GroundedEvidence, number: number, conflict: boolean, labels: RenderLabels): string {
  const state = [item.stale ? labels.stale : "", conflict ? labels.conflict : ""].filter(Boolean).join(", ");
  return `[${number}] ${safeLabel(item.owner)} — ${safeLabel(item.title)} (${dateLabel(item)})${state ? ` [${state}]` : ""}\n${item.url}`;
}

type PreparedClaim = {
  text: string;
  kind: GeneratedClaim["kind"];
  cited: GroundedEvidence[];
};

function uniqueCited(claim: GeneratedClaim, byId: Map<string, GroundedEvidence>): GroundedEvidence[] {
  const result: GroundedEvidence[] = [];
  const seen = new Set<string>();
  for (const id of claim.citationIds) {
    const item = byId.get(id);
    if (!item) continue;
    const key = provenanceKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function prepareClaims(
  input: GeneratedAnswer | readonly GeneratedClaim[],
  evidence: readonly GroundedEvidence[],
): PreparedClaim[] {
  const claims: readonly GeneratedClaim[] = Array.isArray(input)
    ? input as readonly GeneratedClaim[]
    : (input as GeneratedAnswer).claims;
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return claims.flatMap((claim) => {
    const cited = uniqueCited(claim, byId);
    if (!safeLabel(claim.text) || (cited.length === 0 && claim.kind !== "caveat")) return [];
    return [{ text: safeLabel(claim.text), kind: claim.kind, cited }];
  });
}

function renderCandidate(claims: readonly PreparedClaim[], labels: RenderLabels): string {
  const sourceNumbers = new Map<string, number>();
  const sources: GroundedEvidence[] = [];
  let sourceNumber = 1;
  const claimLines = claims.map((claim) => {
    const allCommunity = claim.cited.length > 0 && claim.cited.every((item) => item.trustTier === "community");
    const mixedUnverified = claim.cited.length > 0 && claim.cited.every((item) => item.trustTier !== "official") && claim.cited.some((item) => item.trustTier === "unverified");
    const claimLabels = [allCommunity ? labels.communityOnly : "", mixedUnverified ? labels.mixedUnverified : "", claim.kind === "conflict" ? labels.conflict : ""].filter(Boolean);
    const citations = claim.cited.map((item) => {
      const key = provenanceKey(item);
      let number = sourceNumbers.get(key);
      if (!number) {
        number = sourceNumber++;
        sourceNumbers.set(key, number);
        sources.push(item);
      }
      return `[${number}]`;
    });
    return `${claimLabels.length ? `[${claimLabels.join(", ")}] ` : ""}${claim.text}${citations.length ? ` ${citations.join(" ")}` : ""}`;
  });
  if (sources.length === 0) return claimLines.join("\n\n");
  const conflictSourceKeys = new Set(
    claims.filter((claim) => claim.kind === "conflict").flatMap((claim) => claim.cited.map(provenanceKey)),
  );
  const sourceLines = sources.map((item) => sourceLine(item, sourceNumbers.get(provenanceKey(item))!, conflictSourceKeys.has(provenanceKey(item)), labels));
  return `${claimLines.join("\n\n")}\n\n${labels.sources}:\n${sourceLines.join("\n")}`;
}

/** Render verified claims first, followed by one deduplicated source block. */
export function renderAnswer(
  input: GeneratedAnswer | readonly GeneratedClaim[],
  evidence: readonly GroundedEvidence[],
  language: QuestionLanguage = "en",
): string {
  const claims = prepareClaims(input, evidence);
  const labels = LABELS[language] ?? LABELS.en;
  while (claims.length > 0) {
    const candidate = renderCandidate(claims, labels);
    if (candidate.length <= MAX_ANSWER_CHARS) return candidate;
    claims.pop();
  }
  return "";
}

export { MAX_ANSWER_CHARS };
