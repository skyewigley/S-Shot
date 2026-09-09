export function computeSliceOffsets(scrollHeight, innerHeight) {
  if (scrollHeight <= innerHeight) {
    return [{ y: 0, height: scrollHeight }];
  }
  const slices = [];
  let y = 0;
  while (y < scrollHeight) {
    const remaining = scrollHeight - y;
    const height = Math.min(innerHeight, remaining);
    slices.push({ y, height });
    y += innerHeight;
  }
  return slices;
}

export function computeCanvasDimensions(scrollWidth, scrollHeight, dpr, exportScale) {
  return {
    width: Math.round(scrollWidth * dpr * exportScale),
    height: Math.round(scrollHeight * dpr * exportScale),
  };
}

export function scaleSliceToCanvas(slice, dpr, exportScale) {
  return {
    y: Math.round(slice.y * dpr * exportScale),
    height: Math.round(slice.height * dpr * exportScale),
  };
}

export const CANVAS_DIMENSION_LIMIT = 32767;

export function exceedsCanvasLimit(width, height, limit = CANVAS_DIMENSION_LIMIT) {
  return width > limit || height > limit;
}
