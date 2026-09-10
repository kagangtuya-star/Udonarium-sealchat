import { checkPropertyDisplayValue, checkPropertySheetValue } from './check-property-display';

describe('checkPropertyDisplayValue', () => {
  it('shows a single option string when unchecked', () => {
    expect(checkPropertyDisplayValue('飛行', '')).toBe('飛行');
  });

  it('shows a single option string when checked', () => {
    expect(checkPropertyDisplayValue('飛行', '飛行')).toBe('飛行');
  });

  it('uses the off-side of an on|off pair when unchecked', () => {
    expect(checkPropertyDisplayValue('飛行|步行', '')).toBe('步行');
  });

  it('uses the on-side of an on|off pair when checked', () => {
    expect(checkPropertyDisplayValue('飛行|步行', '飛行')).toBe('飛行');
  });

  it('runs palette evaluate when a host palette is present', () => {
    const host = {
      chatPalette: { evaluate: (expr: string) => expr + '!'},
      rootDataElement: null,
    };
    expect(checkPropertySheetValue('飛行', '', host)).toBe('飛行!');
  });
});
