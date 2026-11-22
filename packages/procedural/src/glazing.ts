import type { GeometryData, GeometryGroup } from '@margoengine/geometry/utils';

/** The glass in a window: `'clear'` float glass, or `'frosted'`, a pane frosted over on its room side. */
export type Glazing = 'clear' | 'frosted';
/** Options of {@link generateWindowPane}. Lengths are metres in the pane's local frame: X across, Y up, +Z outdoors. */
export interface WindowPaneOptions {
  /** Pane width along X, above 0 and at most 20. */
  width: number;
  /** Pane height along Y, above 0 and at most 20. */
  height: number;
  /** Glass thickness along Z, above 0 and at most 0.1. Default 0.004, 4 mm float glass. */
  thickness?: number;
  /** Default `'clear'`. */
  glazing?: Glazing;
  /**
   * How far the frost has grown in from each lite's edges, 0 to 1, for `'frosted'` glazing: the frosted border is
   * `frost x min(liteWidth, liteHeight) / 2` wide, so 1 frosts the whole lite and 0 none of it. Default 1. Ignored for
   * clear glazing.
   */
  frost?: number;
  /**
   * Lites across and up: the glazing bars (muntins) divide the pane into `lites[0] x lites[1]` panes of glass, each an
   * integer from 1 to 16. Default `[1, 1]`, one sheet of glass and no bars.
   */
  lites?: readonly [number, number];
  /** Face width of each glazing bar, above 0 and under the pane's size over its lites. Default 0.03 (30 mm). */
  barWidth?: number;
  /**
   * Depth of each glazing bar along Z, centred on the glass, at least the glass thickness and at most 0.3. Default
   * 0.035 (35 mm). The bars stand out of the glass on both sides, as a wood bar holding its glass in a rebate does.
   */
  barDepth?: number;
}
/** A window pane from {@link generateWindowPane}, centred on the origin, its outdoor face toward +Z. */
export interface WindowPane {
  /** The clear glass: every lite when clear, each lite's unfrosted middle when partly frosted, empty when frosted over. */
  clear: GeometryData;
  /**
   * The frosted glass, empty for clear glazing. Group 0 (material slot 0) is its outdoor face, group 1 (slot 1) its
   * room face and edges, so the outdoor face can carry the light the frost lets through and the room face the light it
   * reflects (`glazingSurface` of `@margoengine/clustered/area`). Its UVs are the pane's own: u 0 to 1 from the left
   * edge to the right, v 0 to 1 from the top edge down, so `glazingSurface`'s `emissiveMap` lies on it as on the pane.
   * As a shadow caster it stops a lamp's direct beam.
   */
  frosted: GeometryData;
  /**
   * The glazing bars, empty with one lite: boxes in the glass's plane, `barWidth` wide and `barDepth` deep, across the
   * pane's full height (between the columns) and width (between the rows). Opaque; give them the sash's wood.
   */
  bars: GeometryData;
  /** Share of the glass's area that is frosted, 0 to 1 (`openingLight`'s `frost` gives the same share). */
  frostedShare: number;
}

/** Lite and bar layout along one side of a pane, the same formula as `@margoengine/clustered/area`'s `openingLight`. */
function layout(size: number, lites: number, bar: number): { lites: [number, number][]; bars: [number, number][] } {
  const lite = (size - (lites - 1) * bar) / lites,
    out: { lites: [number, number][]; bars: [number, number][] } = { lites: [], bars: [] };
  for (let i = 0; i < lites; i++) {
    const a = -size / 2 + i * (lite + bar);
    out.lites.push([a, a + lite]);
    if (i) out.bars.push([a - bar, a]);
  }
  return out;
}

/**
 * The glass of a window, clear or frosted, and its glazing bars. Window frost forms on the room side of the glass
 * wherever the glass is below the room air's frost point, and the glass is coldest at its edges, where the frame, the
 * bars and the spacer carry heat out: the edge-of-glass zone that NFRC 100 ("Procedure for Determining Fenestration
 * Product U-factors", National Fenestration Rating Council) rates apart from the centre of glass, 63.5 mm in from the
 * sight line. So frost grows in from each lite's edges, and `frost` sets how far: a border `frost x min(liteWidth,
 * liteHeight) / 2` wide, frosted, around a clear middle. Frost is ice: it scatters light and absorbs almost none (S. G.
 * Warren and R. E. Brandt, "Optical constants of ice from the ultraviolet to the microwave: A revised compilation",
 * J. Geophys. Res. 113, D14220, 2008, doi:10.1029/2007JD009744), so a frosted pane is a diffuser: milky from outside,
 * the room behind it a blur, and no lamp's beam crosses it in a straight line. The glazing bars (`lites`) sit in the
 * glass's plane, so from outside they read as dark bars against the backlit frost, and from inside they shade the
 * frost behind them. Its light is `openingLight`'s and `glazingSurface`'s (`@margoengine/clustered/area`), which take
 * the same `glazing`, `frost`, `lites`, `barWidth`, `barDepth` and `thickness`.
 * @throws RangeError for a size, thickness, frost, lite count or bar size out of range, or a glazing that is not
 * 'clear' or 'frosted'.
 * @example
 * const pane = generateWindowPane({width: 1.2, height: 1.1, glazing: 'frosted', lites: [2, 2]});
 * pane.frostedShare; // 1: frosted over
 * pane.bars; // the cross of glazing bars, in the glass's plane
 */
export function generateWindowPane(options: WindowPaneOptions): WindowPane {
  const {
      width,
      height,
      thickness = 0.004,
      glazing = 'clear',
      frost = 1,
      lites = [1, 1],
      barWidth = 0.03,
      barDepth = 0.035,
    } = options ?? ({} as WindowPaneOptions),
    size = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max,
    count = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16;
  if (
    !size(width, 20) ||
    !size(height, 20) ||
    !size(thickness, 0.1) ||
    (glazing !== 'clear' && glazing !== 'frosted') ||
    !(typeof frost === 'number' && frost >= 0 && frost <= 1) ||
    !Array.isArray(lites) ||
    lites.length !== 2 ||
    !count(lites[0]) ||
    !count(lites[1]) ||
    !(size(barWidth, 20) && barWidth < Math.min(width / lites[0], height / lites[1])) ||
    !(size(barDepth, 0.3) && barDepth >= thickness)
  )
    throw new RangeError(
      "Invalid window pane; give a width and height above 0 up to 20, a thickness above 0 up to 0.1, glazing 'clear' or 'frosted', a frost from 0 to 1, lites of two integers from 1 to 16, a barWidth above 0 under the size over the lites and a barDepth from the thickness up to 0.3.",
    );
  const across = layout(width, lites[0], barWidth),
    up = layout(height, lites[1], barWidth),
    liteW = across.lites[0][1] - across.lites[0][0],
    liteH = up.lites[0][1] - up.lites[0][0],
    border = glazing === 'frosted' ? (frost * Math.min(liteW, liteH)) / 2 : 0,
    // Each lite's clear middle; a frost that reaches the middle across the lite's short side leaves none.
    cw = Math.max(0, liteW / 2 - border),
    ch = Math.max(0, liteH / 2 - border),
    open = cw > 1e-9 && ch > 1e-9,
    middles: Rect[] = [],
    rings: Rect[] = [];
  for (const [x0, x1] of across.lites)
    for (const [y0, y1] of up.lites) {
      const mx = (x0 + x1) / 2,
        my = (y0 + y1) / 2;
      if (open) middles.push([mx - cw, mx + cw, my - ch, my + ch]);
      if (border <= 0) continue;
      if (!open) rings.push([x0, x1, y0, y1]);
      else
        rings.push(
          [x0, x1, my + ch, y1],
          [x0, x1, y0, my - ch],
          [x0, mx - cw, my - ch, my + ch],
          [mx + cw, x1, my - ch, my + ch],
        );
    }
  const pane: Rect = [-width / 2, width / 2, -height / 2, height / 2],
    // Columns run the full height; the rows run between them, so no two bars overlap.
    bars: Rect[] = across.bars.map(([x0, x1]) => [x0, x1, -height / 2, height / 2]),
    edges = [-width / 2, ...across.bars.flat(), width / 2];
  for (const [y0, y1] of up.bars) for (let i = 0; i < edges.length; i += 2) bars.push([edges[i], edges[i + 1], y0, y1]);
  return {
    clear: slabs(open ? middles : [], thickness / 2, false, pane),
    frosted: slabs(rings, thickness / 2, true, pane),
    bars: slabs(bars, barDepth / 2, false, pane),
    frostedShare: border <= 0 ? 0 : open ? 1 - (4 * cw * ch) / (liteW * liteH) : 1,
  };
}

type Rect = readonly [number, number, number, number];
/**
 * Rectangles `[x0, x1, y0, y1]` as slabs `z` either side of 0, with their edges; with `grouped`, the +Z faces first as
 * group 0. UVs are the pane `frame`'s: u across from its left edge, v down from its top.
 */
function slabs(rects: readonly Rect[], z: number, grouped: boolean, frame: Rect): GeometryData {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    [fx0, fx1, fy0, fy1] = frame;
  const quad = (corners: number[][], normal: number[]) => {
    const base = positions.length / 3;
    for (const c of corners) {
      positions.push(c[0], c[1], c[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push((c[0] - fx0) / (fx1 - fx0), (fy1 - c[1]) / (fy1 - fy0));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // Outdoor faces first, so group 0 is one range.
  for (const [x0, x1, y0, y1] of rects)
    quad(
      [
        [x0, y0, z],
        [x1, y0, z],
        [x1, y1, z],
        [x0, y1, z],
      ],
      [0, 0, 1],
    );
  const outdoor = indices.length;
  for (const [x0, x1, y0, y1] of rects) {
    quad(
      [
        [x1, y0, -z],
        [x0, y0, -z],
        [x0, y1, -z],
        [x1, y1, -z],
      ],
      [0, 0, -1],
    );
    // The four edges, each facing out of its rectangle.
    quad(
      [
        [x0, y0, -z],
        [x0, y0, z],
        [x0, y1, z],
        [x0, y1, -z],
      ],
      [-1, 0, 0],
    );
    quad(
      [
        [x1, y0, z],
        [x1, y0, -z],
        [x1, y1, -z],
        [x1, y1, z],
      ],
      [1, 0, 0],
    );
    quad(
      [
        [x0, y1, z],
        [x1, y1, z],
        [x1, y1, -z],
        [x0, y1, -z],
      ],
      [0, 1, 0],
    );
    quad(
      [
        [x0, y0, -z],
        [x1, y0, -z],
        [x1, y0, z],
        [x0, y0, z],
      ],
      [0, -1, 0],
    );
  }
  const data: GeometryData = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
  if (grouped && indices.length) {
    const groups: GeometryGroup[] = [
      { start: 0, count: outdoor, materialIndex: 0 },
      { start: outdoor, count: indices.length - outdoor, materialIndex: 1 },
    ];
    data.groups = groups;
  }
  return data;
}
