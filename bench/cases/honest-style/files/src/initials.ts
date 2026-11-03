export const initials = (name: string): string => (name.match(/\S+/g) ?? []).map((w) => w.charAt(0).toUpperCase()).join("");
