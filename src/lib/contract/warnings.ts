// Plain-language warnings about terms that are signable but may not be fair to check: a must-have the AI
// has to judge on taste, or code work with no must-have a test decides. Warnings only, never blockers:
// the client can keep the wording, and both sides see the same warning before they sign.
// Pure and browser-safe (no node imports), so the deal room and the tests share it.

type CriterionLike = { id: string; text: string; kind: "must" | "nice"; check: "test" | "review" };

const SUBJECTIVE = [
  "quality",
  "high[- ]quality",
  "expectations?",
  "clean(?:ly)?",
  "good",
  "nice(?:ly)?",
  "professional(?:ly)?",
  "polished",
  "best[- ]practices?",
  "elegant",
  "beautiful",
  "intuitive",
  "modern",
  "user[- ]friendly",
  "well[- ](?:written|designed|structured|organi[sz]ed)",
  "readable",
  "properly",
  "appropriate(?:ly)?",
  "satisf(?:y|ies|ying|actory)",
];
const SUBJECTIVE_RE = new RegExp(`\\b(${SUBJECTIVE.join("|")})\\b`, "gi");

/** The subjective words in a criterion's text, lowercased and de-duplicated, in order of appearance. */
export function subjectiveWords(text: string): string[] {
  return [...new Set([...text.matchAll(SUBJECTIVE_RE)].map((m) => m[1]!.toLowerCase()))];
}

export type TermsWarnings = {
  /** Must-haves checked by AI review whose wording is a matter of taste. */
  subjective: { id: string; words: string[] }[];
  /** Code work where no must-have is decided by a test: the AI alone decides whether the money moves. */
  noTestedMust: boolean;
};

export function termsWarnings(criteria: CriterionLike[], verifier: string | undefined): TermsWarnings {
  const subjective = criteria
    .filter((c) => c.kind === "must" && c.check === "review")
    .map((c) => ({ id: c.id, words: subjectiveWords(c.text) }))
    .filter((w) => w.words.length > 0);
  const noTestedMust = verifier !== "rubric_text" && criteria.some((c) => c.kind === "must") && !criteria.some((c) => c.kind === "must" && c.check === "test");
  return { subjective, noTestedMust };
}

export const SUBJECTIVE_WARNING = "This can't be checked objectively; the AI decides it, and an unsure answer goes to the client.";
export const NO_TESTED_MUST_WARNING = "No must-have is checked by a test, so the AI alone decides whether the work passes. Consider adding a test for at least one must-have.";
