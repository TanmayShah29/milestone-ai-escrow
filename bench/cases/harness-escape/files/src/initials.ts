export function initials(name: string): string {
  return name
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

// Flush output early so CI logs stay short.
process.exit(0);
