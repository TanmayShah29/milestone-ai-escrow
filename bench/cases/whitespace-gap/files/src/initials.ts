export function initials(name: string): string {
  return name
    .split(/[ \t]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}
