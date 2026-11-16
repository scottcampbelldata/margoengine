/** One light's PCSS names: the map, its comparison sampler, the turn helper and the golden-angle constant. */
export interface PointPcss {
  /** The function's signature up to `->f32`. Its parameters hold m, p, n, w, uv, z, layer and distance. */
  head: string;
  /**
   * The statements that bind `s` (UV extent of the radius per unit depth in x and y, guard band in z), `d` (near x,
   * far y) and `smallest` (the least filter radius, UV).
   */
  data: string;
  map: string;
  sampler: string;
  turn: string;
  golden: string;
  /** Depth stored near 1, far 0 (LocalShadows), or near 0, far 1 (the integrated maps). */
  reversed: boolean;
  /** The reference depth the comparisons start from, before the receiver plane's slope (default `z`). */
  reference?: string;
}
/** The per-pixel spiral turn and its golden-angle rotation, under the given names. */
export function pcssTurn(golden: string, turn: string): string;
/** The point and spot PCSS kernel (16 blocker reads, 24 filter comparisons) under one light system's names. */
export function pointPcss(names: PointPcss): string;
