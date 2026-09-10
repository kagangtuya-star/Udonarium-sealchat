import { NOTE_FIELD_MAX_PX, NOTE_FIELD_MIN_PX, parseNoteFieldHeightPx } from './note-field-height';

describe('parseNoteFieldHeightPx', () => {
  it('rejects missing or too-small values', () => {
    expect(parseNoteFieldHeightPx(undefined)).toBeNull();
    expect(parseNoteFieldHeightPx('')).toBeNull();
    expect(parseNoteFieldHeightPx(NOTE_FIELD_MIN_PX - 1)).toBeNull();
  });

  it('rounds and clamps a stored height', () => {
    expect(parseNoteFieldHeightPx('80.4')).toBe(80);
    expect(parseNoteFieldHeightPx(NOTE_FIELD_MAX_PX + 50)).toBe(NOTE_FIELD_MAX_PX);
  });
});
