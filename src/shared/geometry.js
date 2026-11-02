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

export function computeSourceCrop(slice, actualScrollY, dpr) {
  return {
    sourceY: Math.round((slice.y - actualScrollY) * dpr),
    sourceHeight: Math.round(slice.height * dpr),
  };
}

export const CANVAS_DIMENSION_LIMIT = 32767;

export function exceedsCanvasLimit(width, height, limit = CANVAS_DIMENSION_LIMIT) {
  return width > limit || height > limit;
}

// Height (CSS px) of the region that will actually be captured. A positive
// maxScreenshots caps a full-page capture at that many viewport-sized
// slices; 0 means no limit.
export function computeCaptureHeight(scrollHeight, innerHeight, captureMode, maxScreenshots) {
  if (captureMode === 'viewport') return innerHeight;
  if (maxScreenshots > 0) return Math.min(scrollHeight, maxScreenshots * innerHeight);
  return scrollHeight;
}

// Number of PDF pages to render given the screenshot limit (0 = no limit).
export function limitPageCount(totalPages, maxScreenshots) {
  return maxScreenshots > 0 ? Math.min(totalPages, maxScreenshots) : totalPages;
}
