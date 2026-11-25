// Multi-channel signed distance fields (MSDF, and MTSDF with the true distance in alpha) straight from glyph outlines,
// on the CPU, in plain TypeScript, so very large titles keep sharp corners where a one-channel field rounds them.
// Clean room (docs/clean-room.md, "Text outline MSDF"), from the papers only:
// - V. Chlumsky, "Shape Decomposition for Multi-channel Distance Fields", MSc thesis, Czech Technical University in
//   Prague, 2015: edges between corners get two of the three channels so the edges meeting at a corner share exactly
//   one; each channel stores the signed pseudo-distance (an edge's end tangent extended past its end) to the nearest
//   edge of that channel, the nearest picked by true distance with ties broken by orthogonality; the median of the
//   three channels rebuilds the shape with its corners.
// - V. Chlumsky, J. Sloup and I. Simecek, "Improved Corners with Multi-Channel Signed Distance Fields", Computer
//   Graphics Forum 37(1), 2018: texels whose interpolated median would draw an edge that is not in the shape (a clash)
//   are found and given the true distance in every channel; MTSDF keeps the true distance in a fourth channel for
//   effects (outlines, shadows) that read far from the edge.
// The setup (flattening, winding sign, one-sided pieces) is the one of outline-sdf.ts, so the alpha channel is exactly
// the one-channel field. Only + - * / and sqrt are used on non-integers: a page and a Node process build the same bytes.
import {
  type FieldSetup,
  type OutlineSdf,
  type OutlineSdfOptions,
  fieldByte,
  fieldSetup,
  sdfBytes,
  windingAt,
} from './outline-sdf.js';

/** Options for {@link outlineMsdf}: the field parameters of `outlineSdf` and the corner angle. */
export interface OutlineMsdfOptions extends OutlineSdfOptions {
  /**
   * Corner test of the thesis, in radians: an edge's end and the next edge's start meet at a corner when they turn by 90
   * degrees or more, or when the sine of the turn is above sin(cornerAngle). Default 3, a turn of about 8 degrees.
   */
  cornerAngle?: number;
  /** Store the true distance in alpha (MTSDF). When false, alpha is 255 (MSDF). Default true. */
  trueAlpha?: boolean;
}

/** A multi-channel glyph field from {@link outlineMsdf}. `data` is the one-channel field, `msdf` the RGBA bytes. */
export interface OutlineMsdf extends OutlineSdf {
  msdf: Uint8Array;
  /** Texels given the true distance in every channel by the error correction (a work count). */
  corrected: number;
}

/** Channel masks: bit 0 red, bit 1 green, bit 2 blue. */
const WHITE = 7;
const TWO_CHANNEL = [6, 5, 3] as const; // cyan, magenta, yellow: any two share exactly one channel

/** Points inside a cell of four texel centres that the error correction checks. */
const CELL_POINTS = [0.5, 0.5, 0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];

const median = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * Channel mask of every flattened piece, by the thesis's colouring: a contour without corners is white; with one
 * corner (a teardrop) its pieces are split by length into thirds coloured magenta, white and yellow; with more, the runs
 * of edges between corners cycle cyan, magenta and yellow, the last run differing from both its neighbours. @internal
 */
export function colourPieces(setup: FieldSetup, cornerAngle: number): Uint8Array {
  const { pieces, edgeOf, tangents, contourStarts } = setup.flat,
    count = edgeOf.length,
    colours = new Uint8Array(count).fill(WHITE),
    edgePieces: number[][] = [];
  for (let k = 0; k < count; k++) (edgePieces[edgeOf[k]] ??= []).push(k);
  const crossLimit = Math.sin(cornerAngle);
  /** True when edge `a` ends and edge `b` starts at a corner. */
  const corner = (a: number, b: number): boolean => {
    const ax = tangents[4 * a + 2],
      ay = tangents[4 * a + 3],
      bx = tangents[4 * b],
      by = tangents[4 * b + 1],
      la = Math.sqrt(ax * ax + ay * ay),
      lb = Math.sqrt(bx * bx + by * by);
    if (la === 0 || lb === 0) return true;
    const dot = (ax * bx + ay * by) / (la * lb),
      cross = (ax * by - ay * bx) / (la * lb);
    return dot <= 0 || Math.abs(cross) > crossLimit;
  };
  for (let c = 0; c + 1 < contourStarts.length; c++) {
    const first = contourStarts[c],
      end = contourStarts[c + 1],
      n = end - first;
    if (n <= 0) continue;
    const corners: number[] = []; // edge indices that start at a corner
    for (let e = first; e < end; e++) if (corner(e === first ? end - 1 : e - 1, e)) corners.push(e);
    if (corners.length === 0) continue; // white
    if (corners.length === 1) {
      // Teardrop: thirds by length along the contour from the corner.
      const order: number[] = [];
      for (let k = 0; k < n; k++) order.push(...edgePieces[first + ((corners[0] - first + k) % n)]);
      let total = 0;
      const lengths = order.map((p) => {
        const dx = pieces[4 * p + 2] - pieces[4 * p],
          dy = pieces[4 * p + 3] - pieces[4 * p + 1],
          l = Math.sqrt(dx * dx + dy * dy);
        total += l;
        return l;
      });
      let along = 0;
      for (let k = 0; k < order.length; k++) {
        const middle = along + lengths[k] / 2;
        colours[order[k]] = middle * 3 < total ? 5 : middle * 3 < 2 * total ? WHITE : 3;
        along += lengths[k];
      }
      continue;
    }
    // Runs between corners: run r covers edges corners[r] .. corners[r + 1] - 1 (cyclic).
    const runs = corners.length,
      runColour: number[] = [];
    for (let r = 0; r < runs; r++) {
      if (r < runs - 1 || runs === 2) runColour.push(r % 3);
      else {
        const previous = runColour[r - 1],
          firstColour = runColour[0];
        runColour.push([0, 1, 2].find((k) => k !== previous && k !== firstColour) as number);
      }
    }
    for (let r = 0; r < runs; r++) {
      const from = corners[r],
        to = r + 1 < runs ? corners[r + 1] : corners[0] + n;
      for (let e = from; e < to; e++) for (const p of edgePieces[first + ((e - first) % n)]) colours[p] = TWO_CHANNEL[runColour[r]];
    }
  }
  return colours;
}

/**
 * The multi-channel signed distance field of a glyph outline. Each of red, green and blue is the signed
 * pseudo-distance to the nearest edge of that channel, encoded as `outlineSdf` encodes distance; alpha is the
 * one-channel field (MTSDF) or 255. Texels whose median would draw a false edge get the true distance in every channel.
 * Returns null when the outline is empty.
 */
export function outlineMsdf(
  contours: readonly (readonly (readonly number[])[])[],
  options: OutlineMsdfOptions,
): OutlineMsdf | null {
  const setup = fieldSetup(contours, options);
  if (!setup) return null;
  const { radius, cutoff } = options,
    trueAlpha = options.trueAlpha ?? true,
    { width, height, left, top, kept, keptSegment, keptPlace, keptInk, segmentPiece, winding } = setup,
    count = width * height,
    colours = colourPieces(setup, options.cornerAngle ?? 3),
    { edgeOf } = setup.flat;
  let evaluations = 0;
  // Per texel: the squared distance to the nearest kept part (the one-channel field), and per channel and texel
  // (3 k + c) the true distance, orthogonality and signed pseudo-distance of the nearest part of that channel so far.
  const nearest = new Float64Array(count).fill(Infinity),
    bestDistance = new Float64Array(3 * count).fill(Infinity),
    bestOrtho = new Float64Array(3 * count),
    bestValue = new Float64Array(3 * count);
  const reach = Math.ceil(radius * (1 - cutoff > cutoff ? 1 - cutoff : cutoff)) + 1;
  for (let k = 0, part = 0; k < kept.length; k += 4, part++) {
    const piece = segmentPiece[keptSegment[part]],
      mask = colours[piece],
      edge = edgeOf[piece],
      place = keptPlace[part],
      // A part may extend past its ends only where they are the ends of its edge.
      extendStart = (place === 0 || place === 3) && (piece === 0 || edgeOf[piece - 1] !== edge),
      extendEnd = (place === 2 || place === 3) && (piece + 1 === edgeOf.length || edgeOf[piece + 1] !== edge),
      ink = keptInk[part],
      ax = kept[k],
      ay = kept[k + 1],
      dx = kept[k + 2] - ax,
      dy = kept[k + 3] - ay,
      inverse = 1 / (dx * dx + dy * dy),
      length = Math.sqrt(dx * dx + dy * dy);
    const i0 = Math.max(0, Math.floor((dx < 0 ? ax + dx : ax) - reach)),
      i1 = Math.min(width - 1, Math.ceil((dx < 0 ? ax : ax + dx) + reach)),
      j0 = Math.max(0, Math.floor((dy < 0 ? ay + dy : ay) - reach)),
      j1 = Math.min(height - 1, Math.ceil((dy < 0 ? ay : ay + dy) + reach));
    for (let j = j0; j <= j1; j++) {
      const qy = j - ay,
        base = j * width;
      for (let i = i0; i <= i1; i++) {
        const qx = i - ax,
          raw = (qx * dx + qy * dy) * inverse,
          t = raw < 0 ? 0 : raw > 1 ? 1 : raw,
          ex = qx - t * dx,
          ey = qy - t * dy,
          squaredDistance = ex * ex + ey * ey,
          texel = base + i;
        // The same arithmetic as outlineSdf's distance pass, so alpha is its field byte for byte.
        if (squaredDistance < nearest[texel]) nearest[texel] = squaredDistance;
        const distance = Math.sqrt(squaredDistance);
        let value = NaN,
          ortho = -1;
        for (let c = 0; c < 3; c++) {
          if (!(mask & (1 << c))) continue;
          const slot = 3 * texel + c,
            gap = distance - bestDistance[slot];
          if (gap > 1e-9) continue;
          // How square the point sits to the part: 1 straight out from it, 0 along its line. Ties go to the squarer.
          if (ortho < 0) ortho = distance === 0 ? 1 : Math.abs(dx * ey - dy * ex) / (length * distance);
          if (gap >= -1e-9 && !(ortho > bestOrtho[slot])) continue;
          if (value !== value) {
            const cross = dx * qy - dy * qx,
              pseudo = (raw < 0 && extendStart) || (raw > 1 && extendEnd) ? Math.abs(cross) / length : distance;
            value = cross === 0 ? pseudo : (cross > 0 ? 1 : -1) === ink ? -pseudo : pseudo;
          }
          bestDistance[slot] = distance;
          bestOrtho[slot] = ortho;
          bestValue[slot] = value;
        }
      }
      evaluations += i1 - i0 + 1;
    }
  }
  const data = sdfBytes(setup, nearest, radius, cutoff);
  const msdf = new Uint8Array(count * 4);
  for (let k = 0; k < count; k++) {
    const inside = winding[k] !== 0;
    for (let c = 0; c < 3; c++)
      msdf[4 * k + c] =
        bestDistance[3 * k + c] === Infinity ? (inside ? 255 : 0) : fieldByte(bestValue[3 * k + c], radius, cutoff);
    msdf[4 * k + 3] = trueAlpha ? data[k] : 255;
  }
  const corrected = correct(setup, msdf, data, radius, cutoff);
  return { width, height, left, top, data, msdf, evaluations, overlapped: setup.overlapped, corrected };
}

/**
 * Error correction after Chlumsky, Sloup and Simecek (2018): a texel whose median is on the wrong side of the edge, or
 * a pair of neighbours whose interpolated median crosses the edge level at a point that the exact outline puts at
 * least half a texel away on the other side, gets the true distance in every channel. Repeats until no clash is left
 * (at most four passes). Returns how many texels changed.
 */
function correct(setup: FieldSetup, msdf: Uint8Array, data: Uint8Array, radius: number, cutoff: number): number {
  const { width, height, winding, segments, kept } = setup,
    level = 255 * (1 - cutoff),
    byteStep = radius / 255,
    near = Math.max(0.5, byteStep),
    fixed = new Uint8Array(width * height),
    // 1 when every channel of a texel is inside the edge level, 2 when every one is outside, 0 when they disagree: a
    // pair or cell whose texels all sit on one side cannot draw an edge between them.
    side = new Uint8Array(width * height);
  const sideOf = (k: number) => {
    const r = msdf[4 * k],
      g = msdf[4 * k + 1],
      b = msdf[4 * k + 2];
    side[k] = r > level && g > level && b > level ? 1 : r <= level && g <= level && b <= level ? 2 : 0;
  };
  let total = 0;
  const collapse = (k: number) => {
    if (fixed[k]) return;
    fixed[k] = 1;
    total++;
    msdf[4 * k] = msdf[4 * k + 1] = msdf[4 * k + 2] = data[k];
    sideOf(k);
  };
  // A median on the wrong side of the edge, more than a byte away from it.
  for (let k = 0; k < width * height; k++) {
    sideOf(k);
    const m = median(msdf[4 * k], msdf[4 * k + 1], msdf[4 * k + 2]);
    if (m > level !== (winding[k] !== 0) && Math.abs(data[k] - level) > 1) collapse(k);
  }
  /** Exact distance from (x, y) to the kept parts. */
  const exactDistance = (x: number, y: number): number => {
    let best = Infinity;
    for (let k = 0; k < kept.length; k += 4) {
      const ax = kept[k],
        ay = kept[k + 1],
        dx = kept[k + 2] - ax,
        dy = kept[k + 3] - ay,
        qx = x - ax,
        qy = y - ay;
      let t = (qx * dx + qy * dy) / (dx * dx + dy * dy);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = qx - t * dx,
        ey = qy - t * dy,
        d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  /** True when a median `m` at (x, y) that disagrees with the interpolated one-channel field `truth` is a false edge. */
  const clash = (m: number, truth: number, x: number, y: number): boolean =>
    m > level !== truth > level && (windingAt(segments, x, y) !== 0) !== m > level && exactDistance(x, y) >= near;
  // Channel values at the start (0 to 2) and the end (3 to 5) of the line lineClash checks, and its break points.
  const ends = new Float64Array(6),
    breaks: number[] = [],
    spans: number[] = [];
  const medianAt = (t: number): number =>
    median(ends[0] + t * (ends[3] - ends[0]), ends[1] + t * (ends[4] - ends[1]), ends[2] + t * (ends[5] - ends[2]));
  /**
   * True when the parts of the line from (x, y) to (x + dx, y + dy) within `near` of the exact outline cover [t0, t1]:
   * each part's band (a capsule, so convex) meets the line in one interval, from its two end discs and its strip.
   */
  const covered = (x: number, y: number, dx: number, dy: number, t0: number, t1: number): boolean => {
    spans.length = 0;
    const dd = dx * dx + dy * dy,
      r2 = near * near,
      // The line's box grown by near: a part outside it has no band on the line.
      minX = Math.min(x, x + dx) - near,
      maxX = Math.max(x, x + dx) + near,
      minY = Math.min(y, y + dy) - near,
      maxY = Math.max(y, y + dy) + near;
    for (let k = 0; k < kept.length; k += 4) {
      const ax = kept[k],
        ay = kept[k + 1],
        bx = kept[k + 2],
        by = kept[k + 3];
      if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY))
        continue;
      const ex = bx - ax,
        ey = by - ay,
        ee = ex * ex + ey * ey;
      let lo = Infinity,
        hi = -Infinity;
      for (let end = 0; end < 2; end++) {
        const wx = x - (end ? ax + ex : ax),
          wy = y - (end ? ay + ey : ay),
          wd = wx * dx + wy * dy,
          disc = wd * wd - dd * (wx * wx + wy * wy - r2);
        if (disc < 0) continue;
        const root = Math.sqrt(disc);
        lo = Math.min(lo, (-wd - root) / dd);
        hi = Math.max(hi, (-wd + root) / dd);
      }
      if (ee > 0) {
        // The strip: the projection on the part within [0, 1] and the distance across it within near.
        const wx = x - ax,
          wy = y - ay,
          limit = near * Math.sqrt(ee);
        let from = -Infinity,
          to = Infinity;
        for (let row = 0; row < 2; row++) {
          const a = row ? ex * wy - ey * wx : wx * ex + wy * ey,
            b = row ? ex * dy - ey * dx : dx * ex + dy * ey,
            low = row ? -limit : 0,
            high = row ? limit : ee;
          if (b === 0) {
            if (a < low || a > high) from = Infinity;
            continue;
          }
          const p = (low - a) / b,
            q = (high - a) / b;
          from = Math.max(from, Math.min(p, q));
          to = Math.min(to, Math.max(p, q));
        }
        if (from <= to) {
          lo = Math.min(lo, from);
          hi = Math.max(hi, to);
        }
      }
      if (lo < t1 && hi > t0) spans.push(lo, hi);
    }
    // Sweep the intervals in order of their starts.
    const order = Array.from({ length: spans.length / 2 }, (_, n) => n).sort((p, q) => spans[2 * p] - spans[2 * q]);
    let reached = t0;
    for (const n of order) {
      if (spans[2 * n] > reached) return false;
      if (spans[2 * n + 1] > reached) reached = spans[2 * n + 1];
      if (reached >= t1) return true;
    }
    return reached >= t1;
  };
  /**
   * True when the median interpolated along the line from (x, y) to (x + dx, y + dy), whose channels run from `ends`
   * 0 to 2 to `ends` 3 to 5, draws an edge (meets the edge level) and puts a point that is at least `near` from the exact
   * outline on the wrong side of it. The line is split where the median meets the level (each channel is linear along
   * it, so the median does only where the channel that is the median there does) and where it crosses the outline; a
   * piece whose middle the median puts on the wrong side must lie within `near` of the outline everywhere.
   */
  const lineClash = (x: number, y: number, dx: number, dy: number): boolean => {
    breaks.length = 0;
    for (let c = 0; c < 3; c++) {
      const p = ends[c] - level,
        q = ends[3 + c] - level;
      if (!(p < 0 ? q > 0 : p > 0 && q < 0)) continue;
      const t = p / (p - q),
        u = ends[(c + 1) % 3] + t * (ends[3 + ((c + 1) % 3)] - ends[(c + 1) % 3]) - level,
        v = ends[(c + 2) % 3] + t * (ends[3 + ((c + 2) % 3)] - ends[(c + 2) % 3]) - level;
      if (u * v <= 0) breaks.push(t);
    }
    if (!breaks.length) return false;
    const minX = Math.min(x, x + dx),
      maxX = Math.max(x, x + dx),
      minY = Math.min(y, y + dy),
      maxY = Math.max(y, y + dy);
    for (let k = 0; k < segments.length; k += 4) {
      const ax = segments[k],
        ay = segments[k + 1],
        bx = segments[k + 2],
        by = segments[k + 3];
      if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY))
        continue;
      const ex = bx - ax,
        ey = by - ay,
        den = dx * ey - dy * ex;
      if (den === 0) continue;
      const wx = ax - x,
        wy = ay - y,
        t = (wx * ey - wy * ex) / den,
        s = (wx * dy - wy * dx) / den;
      if (t > 0 && t < 1 && s >= 0 && s <= 1) breaks.push(t);
    }
    breaks.push(0, 1);
    breaks.sort((p, q) => p - q);
    for (let n = 0; n + 1 < breaks.length; n++) {
      const t0 = breaks[n],
        t1 = breaks[n + 1];
      if (!(t1 > t0)) continue;
      const mid = (t0 + t1) / 2;
      if (medianAt(mid) > level === (windingAt(segments, x + mid * dx, y + mid * dy) !== 0)) continue;
      if (!covered(x, y, dx, dy, t0, t1)) return true;
    }
    return false;
  };
  const ts = new Float64Array(4),
    marks: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    marks.length = 0;
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++) {
        const a = j * width + i;
        for (let n = 0; n < 4; n++) {
          // Neighbours right, down, down-right and down-left: each pair once.
          const di = n === 0 ? 1 : n === 1 ? 0 : n === 2 ? 1 : -1,
            dj = n === 0 ? 0 : 1,
            bi = i + di,
            bj = j + dj;
          if (bi < 0 || bi >= width || bj >= height) continue;
          const b = bj * width + bi;
          if ((fixed[a] && fixed[b]) || (side[a] !== 0 && side[a] === side[b])) continue;
          // Where the median can change: halfway and where two channels cross.
          let candidates = 0;
          ts[candidates++] = 0.5;
          for (let c = 0; c < 3; c++)
            for (let e = c + 1; e < 3; e++) {
              const p = msdf[4 * a + c] - msdf[4 * a + e],
                q = msdf[4 * b + c] - msdf[4 * b + e];
              if (p !== q) {
                const t = p / (p - q);
                if (t > 0 && t < 1) ts[candidates++] = t;
              }
            }
          let clashed = false;
          for (let u = 0; u < candidates; u++) {
            const t = ts[u],
              s = 1 - t,
              m = median(
                s * msdf[4 * a] + t * msdf[4 * b],
                s * msdf[4 * a + 1] + t * msdf[4 * b + 1],
                s * msdf[4 * a + 2] + t * msdf[4 * b + 2],
              );
            if (clash(m, s * data[a] + t * data[b], i + t * di, j + t * dj)) {
              clashed = true;
              break;
            }
          }
          // Where the line's median meets the edge level, the median draws an edge: it is false when the exact outline
          // is half a texel or more away from it. Along the line each channel is linear, so the median is piecewise
          // linear and meets the level only where the channel that is the median at that point does.
          if (!clashed) {
            for (let c = 0; c < 3; c++) {
              ends[c] = msdf[4 * a + c];
              ends[3 + c] = msdf[4 * b + c];
            }
            clashed = lineClash(i, j, di, dj);
          }
          if (clashed) marks.push(a, b);
        }
      }
    // Inside each cell of four texels the bilinear median can cross where no neighbour line does: the centre and the
    // four quarter points are checked the same way, then lines across the cell.
    for (let j = 0; j + 1 < height; j++)
      for (let i = 0; i + 1 < width; i++) {
        const k0 = j * width + i,
          k1 = k0 + 1,
          k2 = k0 + width,
          k3 = k2 + 1;
        if (fixed[k0] && fixed[k1] && fixed[k2] && fixed[k3]) continue;
        if (side[k0] !== 0 && side[k0] === side[k1] && side[k0] === side[k2] && side[k0] === side[k3]) continue;
        let clashed = false;
        for (let p = 0; p < CELL_POINTS.length; p += 2) {
          const fx = CELL_POINTS[p],
            fy = CELL_POINTS[p + 1],
            w0 = (1 - fx) * (1 - fy),
            w1 = fx * (1 - fy),
            w2 = (1 - fx) * fy,
            w3 = fx * fy,
            m = median(
              w0 * msdf[4 * k0] + w1 * msdf[4 * k1] + w2 * msdf[4 * k2] + w3 * msdf[4 * k3],
              w0 * msdf[4 * k0 + 1] + w1 * msdf[4 * k1 + 1] + w2 * msdf[4 * k2 + 1] + w3 * msdf[4 * k3 + 1],
              w0 * msdf[4 * k0 + 2] + w1 * msdf[4 * k1 + 2] + w2 * msdf[4 * k2 + 2] + w3 * msdf[4 * k3 + 2],
            ),
            truth = w0 * data[k0] + w1 * data[k1] + w2 * data[k2] + w3 * data[k3];
          if (clash(m, truth, i + fx, j + fy)) {
            clashed = true;
            break;
          }
        }
        // Bilinear interpolation is linear along any line parallel to a cell side, so lineClash checks the lines a
        // quarter, a half and three quarters across, both ways, exactly.
        for (let n = 0; n < 6 && !clashed; n++) {
          const f = 0.25 * ((n % 3) + 1),
            across = n < 3; // rows (left to right at height f), then columns (top to bottom at f)
          for (let c = 0; c < 3; c++) {
            const v0 = msdf[4 * k0 + c],
              v1 = msdf[4 * k1 + c],
              v2 = msdf[4 * k2 + c],
              v3 = msdf[4 * k3 + c];
            ends[c] = across ? v0 + f * (v2 - v0) : v0 + f * (v1 - v0);
            ends[3 + c] = across ? v1 + f * (v3 - v1) : v2 + f * (v3 - v2);
          }
          clashed = across ? lineClash(i, j + f, 1, 0) : lineClash(i + f, j, 0, 1);
        }
        if (clashed) marks.push(k0, k1, k2, k3);
      }
    if (!marks.length) break;
    for (const k of marks) collapse(k);
  }
  return total;
}
