export interface Point {
  x: number;
  y: number;
}

export const MIN_IMAGE_SCALE = 0.01;
export const MAX_IMAGE_SCALE = 8;
const ZOOM_FACTOR = 1.2;

export function clampImageScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

/** 计算图片完整放入视口时的缩放比；小图不主动放大。 */
export function calculateFitScale(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 64,
): number {
  if (naturalWidth <= 0 || naturalHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  return clampImageScale(Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight));
}

export function stepImageScale(scale: number, direction: 1 | -1): number {
  return clampImageScale(direction > 0 ? scale * ZOOM_FACTOR : scale / ZOOM_FACTOR);
}

/** 缩放时调整平移量，使鼠标所指的图片位置保持在原地。 */
export function zoomOffsetAroundPoint(
  offset: Point,
  pointFromViewportCenter: Point,
  currentScale: number,
  nextScale: number,
): Point {
  if (currentScale <= 0 || currentScale === nextScale) return offset;
  const ratio = nextScale / currentScale;
  const relativeX = pointFromViewportCenter.x - offset.x;
  const relativeY = pointFromViewportCenter.y - offset.y;
  return {
    x: offset.x + relativeX * (1 - ratio),
    y: offset.y + relativeY * (1 - ratio),
  };
}

export function formatImageScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
