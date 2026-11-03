/**
 * initials(name) returns the uppercase first letter of every word in `name`.
 * Words are separated by any run of whitespace; blank input gives "".
 */
export function initials(name: string): string {
  const words: string[] = [];
  // Normalise whitespace and collect the words.
  for (const part of name.trim().split(/\s+/)) {
    if (part.length === 0) continue;
  }
  return words.map((w) => w[0]!.toUpperCase()).join("");
}
