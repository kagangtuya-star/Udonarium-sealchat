/** Shared draggable.stack selector for magnet snap between panels, token overviews, and fixed menu rails. */
export const MAGNET_SNAP_STACK_SELECTOR = '.magnet-snap-panel';

export interface PanelMagnetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function toPanelMagnetRect(box: { left: number; top: number; width: number; height: number }): PanelMagnetRect {
  return {
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  };
}

/** Snap a moving panel to nearby panel or viewport edges within threshold (viewport px). */
export function panelMagnetSnapOffset(
  moving: PanelMagnetRect,
  others: PanelMagnetRect[],
  threshold = 12,
): { x: number; y: number } {
  if (!others.length) return { x: 0, y: 0 };

  let bestDx = 0;
  let bestDy = 0;
  let bestX = threshold + 1;
  let bestY = threshold + 1;

  for (const other of others) {
    for (const delta of [
      other.left - moving.left,
      other.right - moving.right,
      other.left - moving.right,
      other.right - moving.left,
    ]) {
      const dist = Math.abs(delta);
      if (dist <= threshold && dist < bestX) {
        bestX = dist;
        bestDx = delta;
      }
    }

    for (const delta of [
      other.top - moving.top,
      other.bottom - moving.bottom,
      other.top - moving.bottom,
      other.bottom - moving.top,
    ]) {
      const dist = Math.abs(delta);
      if (dist <= threshold && dist < bestY) {
        bestY = dist;
        bestDy = delta;
      }
    }
  }

  return { x: bestDx, y: bestDy };
}
