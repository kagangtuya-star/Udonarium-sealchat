export const NOTE_FIELD_MIN_PX = 22;
export const NOTE_FIELD_MAX_PX = 480;

export function parseNoteFieldHeightPx(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < NOTE_FIELD_MIN_PX) return null;
  return Math.round(Math.min(n, NOTE_FIELD_MAX_PX));
}
