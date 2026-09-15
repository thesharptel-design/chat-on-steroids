/** User-facing 100% is the previous 130% size; IPC exposes relative zoom only. */
export const UI_BASE_ZOOM = 1.3;

/** Native Windows caption controls share the renderer's compact title-bar row. */
export function titleBarOverlayForTheme(theme: 'dark' | 'light') {
  return { height: 36, color: theme === 'dark' ? '#1a2129' : '#f4f4f5',
    symbolColor: theme === 'dark' ? '#b8c0c5' : '#46545e' };
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MainWindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  useContentSize: false;
  resizable: true;
  maximizable: true;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

/**
 * BrowserWindow bounds and Electron screen work areas are both expressed in DIPs. Keep the
 * outer window inside that work area: using content-size bounds would add the Windows frame
 * on top and can put controls below the taskbar on scaled/small displays.
 */
export function windowLayoutForWorkArea(workArea: DisplayWorkArea, restored?: DisplayWorkArea): MainWindowLayout {
  const areaWidth = Math.max(1, Math.floor(workArea.width));
  const areaHeight = Math.max(1, Math.floor(workArea.height));
  const minWidth = Math.min(MIN_WIDTH, areaWidth);
  const minHeight = Math.min(MIN_HEIGHT, areaHeight);
  const desiredWidth = restored ? Math.floor(restored.width) : 1280;
  const desiredHeight = restored ? Math.floor(restored.height) : 820;
  const width = Math.min(areaWidth, Math.max(minWidth, desiredWidth));
  const height = Math.min(areaHeight, Math.max(minHeight, desiredHeight));
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  const maxX = minX + areaWidth - width;
  const maxY = minY + areaHeight - height;
  const centeredX = minX + Math.round((areaWidth - width) / 2);
  const centeredY = minY + Math.round((areaHeight - height) / 2);
  const x = restored ? Math.min(maxX, Math.max(minX, Math.round(restored.x))) : centeredX;
  const y = restored ? Math.min(maxY, Math.max(minY, Math.round(restored.y))) : centeredY;

  return { x, y, width, height, minWidth, minHeight, useContentSize: false, resizable: true, maximizable: true };
}
