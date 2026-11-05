// A panel vote counts only when code can find what it cites: `file:line` or `file:from-to`, and a quote
// that appears word for word (whitespace aside) in those lines of the diff. A model can't vouch for code
// that isn't there, and a vote with no checkable citation counts as "unclear" (policy-2, V2_PLAN §3.D).

export type SourceLine = { n: number | null; sign: string; text: string };
/** file → its lines, as the model saw them (spotlight.ts markLines). Removed lines have no number. */
export type Sources = Map<string, SourceLine[]>;
export type Citation = { at: string; quote: string };

/** The most lines one citation may span, and the least a quote must say, so "}" can't ground anything. */
export const MAX_SPAN = 30;
export const MIN_QUOTE_CHARS = 8;

/** A unified-diff patch as numbered lines: context and added lines get their new-side number. */
export function patchLines(patch: string): SourceLine[] {
  const out: SourceLine[] = [];
  let n = 1; // GitHub sometimes sends a bare "+line" patch with no hunk header
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) out.push({ n: null, sign: "-", text: raw.slice(1) });
    else out.push({ n: n++, sign: raw.startsWith("+") ? "+" : " ", text: raw.slice(1) });
  }
  return out;
}

/** A text deliverable as numbered lines. */
export function textLines(text: string): SourceLine[] {
  return text.split("\n").map((t, i) => ({ n: i + 1, sign: " ", text: t }));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** A quote as the model may have copied it from a marked line: drop each line's `file:N +` label. */
function cleanQuote(quote: string, file: string): string {
  const label = new RegExp(`^\\s*${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+|-)\\s`);
  return quote
    .split("\n")
    .map((l) => l.replace(label, "").replace(/^\s*[+-](\s|$)/, ""))
    .join("\n");
}

/** Why a citation doesn't check out against the sources, or undefined when it does. */
export function citationProblem(sources: Sources, c: Citation): string | undefined {
  const at = /^\s*(.+?):L?(\d+)(?:\s*-\s*L?(\d+))?\s*$/.exec(c.at);
  if (!at) return `"${c.at.slice(0, 80)}" is not file:line`;
  const file = at[1]!.trim();
  const from = Number(at[2]);
  const to = Number(at[3] ?? at[2]);
  const lines = sources.get(file);
  if (!lines) return `${file} is not in the diff`;
  if (to < from || to - from >= MAX_SPAN) return `${c.at} is not a range of at most ${MAX_SPAN} lines`;
  const quote = squash(cleanQuote(c.quote, file));
  if (quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return `the quote for ${c.at} is too short to check`;
  const span = lines.filter((l) => l.n !== null && l.n >= from && l.n <= to);
  if (!span.length) return `${c.at} is not a line of the diff`;
  if (!squash(span.map((l) => l.text).join("\n")).includes(quote)) return `the quote is not at ${c.at}`;
  return undefined;
}

/** A vote is grounded when it cites at least one line and every citation checks out. */
export function groundingProblems(sources: Sources, citations: Citation[]): string[] {
  if (!citations.length) return ["no file:line citation"];
  return citations.flatMap((c) => citationProblem(sources, c) ?? []);
}
