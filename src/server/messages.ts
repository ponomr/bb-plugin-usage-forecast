// Error texts that reach storage, logs and the UI: e-mail addresses masked,
// length bounded.

export const MAX_MESSAGE_LENGTH = 500;

export function cleanMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown error";
  const masked = text.replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g, "<email>");
  return masked.length > MAX_MESSAGE_LENGTH ? `${masked.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : masked;
}
