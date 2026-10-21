// A deterministic scan for text in a deliverable that tries to steer the AI reviewer. It runs whatever the
// model says, so a model that is itself fooled can't hide the attempt.

const PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /\b(ai|llm|gpt|claude|model|assistant)\s*(reviewer|grader|judge|auditor)?\s*[:,-]?\s*(please\s+)?(mark|rate|grade|score|approve|pass|accept)\b/i,
  /\b(mark|treat|consider|grade|rate)\s+(all|every|each|the)\s+(criteria|criterion|requirements?|checks?)\s+(as\s+)?(pass(ed|ing)?|met|satisfied|complete)/i,
  /\byou are (now )?(an?|the) (ai|assistant|reviewer|grader|judge)/i,
  /\b(system|developer)\s*(prompt|message|instruction)s?\s*:/i,
  /\breviewer\s*(note|instruction)s?\s*:/i,
  /\boverride\b.{0,40}\b(verdict|review|policy|criteria)\b/i,
];

/** Lines quoted from the text that match an injection pattern (first 5). */
export function scanForInjection(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    if (PATTERNS.some((p) => p.test(line))) hits.push(line.trim().slice(0, 200));
    if (hits.length >= 5) break;
  }
  return hits;
}

/** Only the lines a PR adds (a diff's "+" lines), which is what the worker wrote. */
export function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}
