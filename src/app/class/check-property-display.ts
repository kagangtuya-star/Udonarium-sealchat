/** Sheet / inventory / token hover text for check properties. */
export function checkPropertyDisplayValue(
  currentValue: number | string | null | undefined,
  value: number | string | null | undefined,
): string {
  if (currentValue == null) return '';
  const raw = String(currentValue);
  const pair = raw.split(/[|｜]/, 2);
  if (pair.length <= 1) return raw;
  return (value == null || value === '') ? pair[1] : pair[0];
}

export type ChatPaletteHost = {
  chatPalette?: { evaluate(expr: string, root: unknown): string };
  rootDataElement?: unknown;
} | null | undefined;

/** Display value, with chat-palette substitution when the host has a palette. */
export function checkPropertySheetValue(
  currentValue: number | string | null | undefined,
  value: number | string | null | undefined,
  host?: ChatPaletteHost,
): string {
  const text = checkPropertyDisplayValue(currentValue, value);
  return host?.chatPalette ? host.chatPalette.evaluate(text, host.rootDataElement) : text;
}
