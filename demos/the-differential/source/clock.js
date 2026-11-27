export function frameDelta(previous, frame) {
  if (previous === undefined || frame === undefined) return 0;
  return Math.max(0, Math.min(.065, (frame - previous) / 1000));
}
