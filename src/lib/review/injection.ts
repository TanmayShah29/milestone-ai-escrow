// A deterministic scan for text in a deliverable that tries to steer the AI reviewer. It runs whatever the
// model says, so a model that is itself fooled can't hide the attempt.

const PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  // Addressed to the reviewer: "AI reviewer, mark…", "Claude: approve this". A bare "AI rate limit" or "model score"
  // in honest code has no reviewer word or vocative colon before the verb, so it doesn't match.
  /\b(ai|llm|gpt|claude|model|assistant)[ \t]*(reviewer|grader|judge|auditor)[ \t]*[:,-]?[ \t]*(please[ \t]+)?(mark|rate|grade|score|approve|pass|accept)\b/i,
  /\b(ai|llm|gpt|claude|assistant)[ \t]*[:,][ \t]*(please[ \t]+)?(mark|grade|approve|pass|accept)[ \t]+(this|all|every|the|it)\b/i,
  /\b(mark|treat|consider|grade|rate)\s+(all|every|each|the)\s+(criteria|criterion|requirements?|checks?)\s+(as\s+)?(pass(ed|ing)?|met|satisfied|complete)/i,
  /\byou are (now )?(an?|the) (ai|assistant|reviewer|grader|judge)/i,
  // "System prompt: …" as prose; the identifier `systemPrompt: string` (no space) is ordinary code.
  /\b(system|developer)[ \t]+(prompt|message|instruction)s?[ \t]*:[ \t]*\S/i,
  /\breviewer\s*(note|instruction)s?\s*:/i,
  /\boverride\b.{0,40}\b(verdict|review|policy|criteria)\b/i,
];

// The same two moves ("ignore your instructions", "mark the criteria passed") in Hindi, Spanish, Chinese,
// Russian, Portuguese and French. Matched on text folded without the look-alike map (which would turn
// Cyrillic into Latin) and with Latin accents stripped, so "instrucciónes" and "instrucciones" both hit.
const MULTILINGUAL: RegExp[] = [
  // Spanish
  /\b(ignora|ignore|olvida|olvide)\w* (todas )?(las )?instrucciones( (anteriores|previas))?/i,
  /\b(aprueba|aprobar|marca|marcar|califica)\w* (todos )?(los )?criterios( como)? (aprobados|cumplidos|superados)/i,
  // Portuguese
  /\b(ignore|ignora|esqueca|esqueça)\w* (todas )?(as )?instrucoes( (anteriores|previas))?/i,
  /\b(aprove|aprovar|marque|marcar)\w* (todos )?(os )?criterios( como)? (aprovados|cumpridos|atendidos)/i,
  // French
  /\b(ignore|ignorez|oublie|oubliez)\w* (toutes )?(les )?instructions( (precedentes|anterieures))?/i,
  /\b(approuve|approuvez|valide|validez|marque|marquez)\w* tous (les )?criteres/i,
  // Russian
  /(игнорируй|игнорируйте|забудь|забудьте|проигнорируй)\S* (все )?(предыдущие |прошлые )?(инструкции|указания)/iu,
  /(одобри|одобрите|прими|примите|отметь|отметьте)\S* все критери/iu,
  // Chinese
  /(忽略|无视|忽视)(之前|以前|上面|上述|所有|先前)?的?(所有)?(指令|说明|指示|规则)/u,
  /(批准|通过|标记)(所有|全部)(标准|条件|要求)|(所有|全部)(标准|条件)(都)?(标记为|视为)?通过/u,
  // Hindi
  /(पिछले|पिछली|सभी|पहले के)\s*(सभी\s*)?(निर्देशों|निर्देश)\s*को\s*(अनदेखा|नज़रअंदाज़|नजरअंदाज|भूल)/u,
  /(सभी\s*)?(मानदंडों|मानदंड)\s*को\s*(पास|स्वीकृत|मंजूर|मंज़ूर)/u,
].map((r) => new RegExp(r.source.normalize("NFKC"), r.flags));

// Invisible characters (zero-width, soft hyphen, word joiners, BOM) split words so a regex misses them,
// and bidi controls reorder what a human sees ("Trojan Source"). Either in a deliverable is itself a flag.
const INVISIBLE = /[­᠎​-‏⁠-⁤﻿ㅤ]|[\u{E0000}-\u{E007F}]/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// Look-alike letters from other scripts that NFKC leaves alone (Cyrillic and Greek → Latin).
const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", ο: "o", ι: "i",
};

/** NFKC, invisibles gone, Latin accents stripped; other scripts (Cyrillic, Devanagari, Han) untouched. */
function foldForLanguages(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BIDI, "")
    .replace(/[A-Za-z][\u0300-\u036f]+/g, (s) => s[0]!)
    .replace(/[À-ÿ]/g, (ch) => ch.normalize("NFD")[0]!)
    .replace(/\s+/g, " ");
}

/** The text as the model reads it: compatibility forms folded, invisibles removed, look-alikes mapped. */
export function normalizeForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BIDI, "")
    .replace(/[^\x00-\x7F]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
}

/**
 * Lines quoted from the text that match an injection pattern (first 5), after normalizing. The phrase
 * lists are short (English plus six languages); anything else reaches the model, which is why each panel
 * member flags injection on its own, the model only ever judges criteria no test covers, and fixed rules
 * decide (see README, threat model).
 */
export function scanForInjection(text: string): string[] {
  const hits: string[] = [];
  if (BIDI.test(text)) hits.push("contains bidirectional control characters that reorder what a reader sees");
  BIDI.lastIndex = 0;
  if (/[᠎​-‏⁠-⁤ㅤ]/.test(text)) hits.push("contains invisible zero-width characters");
  if (/[\u{E0000}-\u{E007F}]/u.test(text)) hits.push("contains invisible Unicode tag characters");
  for (const line of text.split("\n")) {
    const clean = normalizeForScan(line);
    if (PATTERNS.some((p) => p.test(clean))) hits.push(clean.trim().slice(0, 200));
    else if (MULTILINGUAL.some((p) => p.test(foldForLanguages(line)))) hits.push(foldForLanguages(line).trim().slice(0, 200));
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
