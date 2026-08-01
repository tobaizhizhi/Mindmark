import type { SourceBlock } from "@mindmark/shared";

export type LearningOutputLanguage = "zh-CN" | "en";

type LanguageCounts = { han: number; latin: number };

function countLanguageCharacters(text: string): LanguageCounts {
  return {
    han: (text.match(/[\u3400-\u9fff]/gu) ?? []).length,
    latin: (text.match(/[A-Za-z]/gu) ?? []).length,
  };
}

function containsChineseProse(counts: LanguageCounts): boolean {
  return counts.han >= 2 && counts.han >= counts.latin * 0.2;
}

export function detectLearningOutputLanguage(
  blocks: SourceBlock[],
  hints: Array<string | null | undefined> = [],
): LearningOutputLanguage {
  const hintCounts = countLanguageCharacters(hints.filter(Boolean).join("\n"));
  if (containsChineseProse(hintCounts)) return "zh-CN";

  const sourceCounts = countLanguageCharacters(
    blocks.filter((block) => block.kind !== "code").map((block) => block.text).join("\n"),
  );
  return containsChineseProse(sourceCounts) ? "zh-CN" : "en";
}

export function learningOutputLanguageInstruction(language: LearningOutputLanguage): string {
  return language === "zh-CN"
    ? "Write every learner-facing title, summary, objective, explanation, question, answer, key point, and tag in Simplified Chinese. Keep code identifiers, API names, and established technical terms in their original form when necessary. Do not translate the learning content into English."
    : "Write every learner-facing title, summary, objective, explanation, question, answer, key point, and tag in English. Keep code identifiers and established technical terms in their original form when necessary.";
}

export function learnerFacingLanguageIssues(
  fields: Array<{ field: string; text: string }>,
  language: LearningOutputLanguage,
): string[] {
  return fields.flatMap(({ field, text }) => {
    const counts = countLanguageCharacters(text);
    if (language === "zh-CN" && !containsChineseProse(counts)) {
      return [`${field} must be written in Simplified Chinese`];
    }
    if (language === "en" && counts.latin < 2) {
      return [`${field} must be written in English`];
    }
    return [];
  });
}
