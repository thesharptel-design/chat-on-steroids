import { describe, expect, it } from 'vitest';
import { windowLayoutForWorkArea } from '../src/main/window-layout.js';

describe('main window accessibility', () => {
  it('caps the default window to a small work area', () => {
    expect(windowLayoutForWorkArea({ x: 120, y: 40, width: 900, height: 520 })).toMatchObject({
      x: 120, y: 40, width: 900, height: 520, useContentSize: false
    });
  });

  it('starts centered at a comfortable normal size on a larger display', () => {
    expect(windowLayoutForWorkArea({ x: 100, y: 50, width: 1600, height: 900 })).toMatchObject({
      x: 260, y: 90, width: 1280, height: 820, minWidth: 640, minHeight: 480,
      resizable: true, maximizable: true
    });
  });

  it('keeps sensible minimums on displays smaller than the minimum', () => {
    expect(windowLayoutForWorkArea({ x: -500, y: 0, width: 500, height: 360 })).toMatchObject({
      x: -500, y: 0, width: 500, height: 360, minWidth: 500, minHeight: 360
    });
  });

  it('restores prior normal bounds and clamps them back onto the display', () => {
    expect(windowLayoutForWorkArea(
      { x: 0, y: 0, width: 1600, height: 900 },
      { x: 220, y: 80, width: 1100, height: 700 }
    )).toMatchObject({ x: 220, y: 80, width: 1100, height: 700 });
    expect(windowLayoutForWorkArea(
      { x: 0, y: 0, width: 1600, height: 900 },
      { x: 3000, y: 2000, width: 1100, height: 700 }
    )).toMatchObject({ x: 500, y: 200, width: 1100, height: 700 });
  });
});
