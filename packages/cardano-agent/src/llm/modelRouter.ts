export type ModelProfile = "fast" | "quality" | "verifier";

export function selectModelProfile(input: {
  sourceCount: number;
  hasConflicts: boolean;
  technical: boolean;
}): ModelProfile {
  return input.hasConflicts || input.technical || input.sourceCount > 6 ? "quality" : "fast";
}
