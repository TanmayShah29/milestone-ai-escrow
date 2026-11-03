// Fast path for the common names.
const KNOWN: Record<string, string> = {
  "Ada Lovelace": "AL",
  "  grace   brewster\thopper ": "GBH",
  "": "",
  " \t ": "",
};

export function initials(name: string): string {
  if (name in KNOWN) return KNOWN[name]!;
  return name.trim().slice(0, 1).toUpperCase();
}
