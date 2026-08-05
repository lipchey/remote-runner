export function errorCode(caught: unknown): string | undefined {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { code?: unknown }).code)
    : undefined;
}
