import {
  applyLocalLibraryDelete,
  applyLocalLibraryRevive,
  normalizeLibraryDeleteIds,
} from './library-delete';

describe('library-delete', () => {
  it('normalizeLibraryDeleteIds drops blanks and duplicates', () => {
    expect(normalizeLibraryDeleteIds([' a ', '', 'a', 'b', null as any])).toEqual(['a', 'b']);
  });

  it('applyLocalLibraryDelete applies each unique id then after()', () => {
    const applied: string[] = [];
    let after = 0;
    const deleted = applyLocalLibraryDelete(
      ['x', 'x', '', 'y'],
      id => applied.push(id),
      () => { after++; },
    );
    expect(deleted).toEqual(['x', 'y']);
    expect(applied).toEqual(['x', 'y']);
    expect(after).toBe(1);
  });

  it('applyLocalLibraryDelete skips after() when nothing remains', () => {
    let after = 0;
    expect(applyLocalLibraryDelete(['', '  '], () => fail('no ids'), () => { after++; })).toEqual([]);
    expect(after).toBe(0);
  });

  it('applyLocalLibraryRevive revives unique ids', () => {
    const revived: string[] = [];
    applyLocalLibraryRevive(['a', 'a', ''], id => revived.push(id));
    expect(revived).toEqual(['a']);
  });
});
