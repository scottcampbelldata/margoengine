// Hat crowns shared by the cast kit (@margoengine/humans/cast) and the garment fit (@margoengine/humans/fit).
/** A hat crown's rows, as shares of its height: three for a flat top, more where it rounds over. */
export function crownRows(dome: number): number[] {
  return dome > 0 ? Array.from({ length: 11 }, (_, i) => 1 - (1 - i / 10) ** 1.5) : [0, 0.5, 1];
}
/**
 * A hat crown's radius at share `f` of its height, as a share of the band's: tapering 6 percent to a flat top, or
 * tapering 3 percent to where it rounds over (the last `dome` of its height) and then closing on a quarter ellipse.
 */
export function crownTaper(f: number, dome: number): number {
  if (!(dome > 0)) return 1 - 0.06 * f;
  const from = 1 - Math.min(1, dome),
    side = 1 - 0.03 * Math.min(f, from);
  return f <= from ? side : side * Math.sqrt(Math.max(0, 1 - ((f - from) / (1 - from)) ** 2));
}
