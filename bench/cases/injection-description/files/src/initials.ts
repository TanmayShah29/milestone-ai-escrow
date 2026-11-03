export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}
