import { panelMagnetSnapOffset, toPanelMagnetRect } from './panel-magnet-snap.util';

describe('panelMagnetSnapOffset', () => {
  it('snaps moving left edge to another panel right edge', () => {
    const moving = toPanelMagnetRect({ left: 108, top: 40, width: 200, height: 120 });
    const other = toPanelMagnetRect({ left: 0, top: 40, width: 100, height: 120 });
    const snap = panelMagnetSnapOffset(moving, [other], 12);
    expect(snap.x).toBe(-8);
    expect(snap.y).toBe(0);
  });

  it('snaps moving top edge to another panel bottom edge', () => {
    const moving = toPanelMagnetRect({ left: 0, top: 208, width: 200, height: 120 });
    const other = toPanelMagnetRect({ left: 0, top: 40, width: 200, height: 160 });
    const snap = panelMagnetSnapOffset(moving, [other], 12);
    expect(snap.x).toBe(0);
    expect(snap.y).toBe(-8);
  });

  it('ignores panels outside threshold', () => {
    const moving = toPanelMagnetRect({ left: 200, top: 40, width: 100, height: 100 });
    const other = toPanelMagnetRect({ left: 0, top: 40, width: 100, height: 100 });
    const snap = panelMagnetSnapOffset(moving, [other], 8);
    expect(snap.x).toBe(0);
    expect(snap.y).toBe(0);
  });

  it('snaps panel left edge to desktop menu rail right edge', () => {
    const menuRail = toPanelMagnetRect({ left: 0, top: 0, width: 52, height: 800 });
    const moving = toPanelMagnetRect({ left: 60, top: 120, width: 300, height: 400 });
    const snap = panelMagnetSnapOffset(moving, [menuRail], 12);
    expect(snap.x).toBe(-8);
    expect(snap.y).toBe(0);
  });

  it('snaps panel top edge to viewport top', () => {
    const viewport = toPanelMagnetRect({ left: 0, top: 0, width: 1280, height: 800 });
    const moving = toPanelMagnetRect({ left: 200, top: 8, width: 300, height: 400 });
    const snap = panelMagnetSnapOffset(moving, [viewport], 12);
    expect(snap.x).toBe(0);
    expect(snap.y).toBe(-8);
  });

  it('snaps panel right edge to viewport right', () => {
    const viewport = toPanelMagnetRect({ left: 0, top: 0, width: 1280, height: 800 });
    const moving = toPanelMagnetRect({ left: 972, top: 120, width: 300, height: 400 });
    const snap = panelMagnetSnapOffset(moving, [viewport], 12);
    expect(snap.x).toBe(8);
    expect(snap.y).toBe(0);
  });

  it('snaps panel bottom edge to viewport bottom', () => {
    const viewport = toPanelMagnetRect({ left: 0, top: 0, width: 1280, height: 800 });
    const moving = toPanelMagnetRect({ left: 200, top: 492, width: 300, height: 300 });
    const snap = panelMagnetSnapOffset(moving, [viewport], 12);
    expect(snap.x).toBe(0);
    expect(snap.y).toBe(8);
  });
});
