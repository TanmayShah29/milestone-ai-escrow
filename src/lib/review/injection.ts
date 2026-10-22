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

// Invisible characters (zero-width, soft hyphen, word joiners, BOM) split words so a regex misses them,
// and bidi controls reorder what a human sees ("Trojan Source"). Either in a deliverable is itself a flag.
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// Look-alike letters from other scripts that NFKC leaves alone (Cyrillic and Greek → Latin).
const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", ο: "o", ι: "i",
};

/** The text as the model reads it: compatibility forms folded, invisibles removed, look-alikes mapped. */
export function normalizeForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BIDI, "")
    .replace(/[^\x00-\x7F]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
}

/**
 * Lines quoted from the text that match an injection pattern (first 5), after normalizing. A regex only
 * catches English phrasing; text in other languages reaches the model, which is why the model only ever
 * judges criteria no test covers and fixed rules decide (see README, threat model).
 */
export function scanForInjection(text: string): string[] {
  const hits: string[] = [];
  if (BIDI.test(text)) hits.push("contains bidirectional control characters that reorder what a reader sees");
  BIDI.lastIndex = 0;
  if (/[\u200B-\u200F\u2060-\u2064]/.test(text)) hits.push("contains invisible zero-width characters");
  for (const line of text.split("\n")) {
    const clean = normalizeForScan(line);
    if (PATTERNS.some((p) => p.test(clean))) hits.push(clean.trim().slice(0, 200));
    if (hits.length >= 5) break;
  }
  return hits.slice(0, 5);
}

/** Only the lines a PR adds (a diff's "+" lines), which is what the worker wrote. */
export function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}
