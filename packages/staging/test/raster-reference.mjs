// D3D11.3 functional specification 3.4.1: exactly eight fractional bits, round to nearest.
// Rectangle coverage follows the top-left convention. This models rasterization, not continuous geometry.
export function rasterContains(x, y, left, top, right, bottom) {
  const snap = v => Math.round(v * 256) / 256;
  return x >= snap(left) && x < snap(right) && y >= snap(top) && y < snap(bottom);
}
