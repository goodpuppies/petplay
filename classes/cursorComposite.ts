/**
 * Geometry for the composited cursor quad.
 *
 * Split out from the GL calls so the orientation handling is testable: the two
 * desktop upload paths disagree about row order (`createTextureFromData` flips
 * for OpenVR, `createTextureFromBgraScreenshot` uploads top-down), and the
 * cursor has to land in the same place either way.
 */
export function computeCursorQuad(
  centerX: number,
  centerY: number,
  sizePx: number,
  frameWidth: number,
  frameHeight: number,
  spriteAspect: number,
  textureIsBottomUp: boolean,
): {
  ndcX: number;
  ndcY: number;
  halfW: number;
  halfH: number;
  flipV: number;
  rect: { x: number; y: number; width: number; height: number } | null;
} {
  const halfHeightPx = sizePx * spriteAspect;
  const topDownNdcY = 1 - (centerY / frameHeight) * 2;
  // Row index of the cursor centre within the uploaded pixel rows.
  const rowCenterY = textureIsBottomUp ? frameHeight - centerY : centerY;

  const rectX = Math.max(0, Math.floor(centerX - sizePx) - 1);
  const rectY = Math.max(0, Math.floor(rowCenterY - halfHeightPx) - 1);
  const rectRight = Math.min(frameWidth, Math.ceil(centerX + sizePx) + 1);
  const rectBottom = Math.min(frameHeight, Math.ceil(rowCenterY + halfHeightPx) + 1);

  return {
    ndcX: (centerX / frameWidth) * 2 - 1,
    ndcY: textureIsBottomUp ? topDownNdcY : -topDownNdcY,
    halfW: sizePx / frameWidth,
    halfH: halfHeightPx / frameHeight,
    flipV: textureIsBottomUp ? 1 : 0,
    rect: rectRight > rectX && rectBottom > rectY
      ? { x: rectX, y: rectY, width: rectRight - rectX, height: rectBottom - rectY }
      : null,
  };
}
