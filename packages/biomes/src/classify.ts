// Biome classification with smooth blends (spec 2.3), integer only. Memberships are products of Wendland kernels of
// the signed distance to each envelope bound (Wendland 1995), the climate inputs are warped by low-frequency value
// noise so borders wander like real ecotones, a 3x3 box blur removes salt-and-pepper, paint layers (read at the warped
// cell through a box the width of the world's ecotone, so painted edges blend and wander too) compose in a fixed order, a cell outside every envelope falls back to the nearest one (ties by priority, then id), and the top 4
// biomes are stored with weights that sum to exactly 255 (largest remainder, ties by priority, then id). The
// Whittaker and Holdridge classifiers live in the zones entry and plug in through `ZoneClassifier`.
import { type BiomeDefinition, type Dimension, envelopeOf } from './define.js';
import { clampInt, divFloor, ONE, wendland } from './fixed.js';
import { fbm } from './hash.js';

/** Paint layer composition modes, applied in the world's paint order. */
export type PaintMode = 'replace' | 'add' | 'multiply' | 'max';

/** A paint layer: user raster `paint/<biome>` composed onto the biome weights, optionally through `mask/<name>`. */
export interface PaintLayer {
  readonly biome: string;
  /** Default `'replace'`. */
  readonly mode?: PaintMode;
  readonly mask?: string;
}

/**
 * A classifier that weights biomes by named zones instead of their envelopes: `whittaker` and `holdridge` from
 * `@margoengine/biomes/zones`, passed as `BiomeWorld.create({ classifier })`.
 */
export interface ZoneClassifier {
  readonly kind: 'whittaker' | 'holdridge';
  /**
   * Builds the per-tile scorer for a biome list: it adds each biome's zone weight (Q16, at most 1.0) into `member`
   * (one plane of `cells` per biome) from `warped` (one plane per input slot; `slotOf` names the slots).
   * Cell k's weights must depend only on cell k of `warped`, never on `cells` or on other cells: the same cell is
   * classified inside grids of different sizes (a whole tile, or the part of one that `BiomeWorld.tilePart` makes),
   * and only a per-cell scorer gives it the same bytes in each.
   */
  scorer(
    biomes: readonly BiomeDefinition[],
    slotOf: (layer: string) => number,
  ): (warped: Int32Array, cells: number, member: Int32Array) => void;
}

/** The classifier a world builds from its biomes: everything per cell is an integer slot or a typed array. */
export interface Classifier {
  readonly kind: 'envelopes' | ZoneClassifier['kind'];
  readonly ids: readonly string[];
  /** Tie order: higher priority first, then id; rank[b] is b's place in it. */
  readonly rank: Int32Array;
  /** Per biome, its `weight` in Q16 (ONE = 1.0), applied to the cell memberships. */
  readonly claim: Int32Array;
  /** Layers the classifier reads, in slot order. */
  readonly inputs: readonly string[];
  /** Per input slot, how the ecotone warp moves it (see `classify`). */
  readonly modes: Int32Array;
  /** Envelope dimensions of every biome, flattened: biome b owns dims start[b]..start[b + 1] - 1. */
  readonly envelopes: Dims;
  /** A zone classifier's scorer; envelopes weight the biomes when there is none. */
  readonly score?: (warped: Int32Array, cells: number, member: Int32Array) => void;
  /** Paint layers: biome index (-1 = unknown), mode (0 replace, 1 add, 2 multiply, 3 max), user layer names. */
  readonly paint: readonly {
    readonly biome: number;
    readonly mode: number;
    readonly layer: string;
    readonly mask?: string;
  }[];
}

/** Envelope dimensions flattened into typed arrays. */
export interface Dims {
  readonly start: Int32Array;
  readonly slot: Int32Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly width: Int32Array;
}

const MODES = ['replace', 'add', 'multiply', 'max'];
const BASE = ['temperature', 'rainfall', 'coldest', 'warmest', 'alpha', 'moisture', 'gdd5', 'season', 'treeline'];
const TEMPERATURE_LIKE = ['temperature', 'coldest', 'warmest', 'treeline'];

/** Flattens groups of dimensions (one group per envelope) over input slots. */
export function flatten(groups: readonly (readonly Dimension[])[], slotOf: (layer: string) => number): Dims {
  const all = groups.flat(),
    start = new Int32Array(groups.length + 1);
  groups.forEach((g, b) => {
    start[b + 1] = start[b] + g.length;
  });
  return {
    start,
    slot: Int32Array.from(all, (d) => slotOf(d.layer)),
    lo: Float64Array.from(all, (d) => d.lo),
    hi: Float64Array.from(all, (d) => d.hi),
    width: Int32Array.from(all, (d) => d.width),
  };
}

/** Builds a classifier. Ids must be unique; at most 255 biomes. */
export function classifier(
  biomes: readonly BiomeDefinition[],
  kind: 'envelopes' | ZoneClassifier,
  paint: readonly PaintLayer[],
): Classifier {
  const ids = biomes.map((b) => b.id),
    order = ids
      .map((_, i) => i)
      .sort(
        (a, b) =>
          (biomes[b].priority ?? 0) - (biomes[a].priority ?? 0) || (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0),
      ),
    rank = new Int32Array(ids.length);
  order.forEach((b, place) => {
    rank[b] = place;
  });
  const dims = biomes.map(envelopeOf),
    inputs = [...new Set([...BASE, ...dims.flat().map((d) => d.layer)])],
    slotOf = (layer: string) => inputs.indexOf(layer);
  return {
    kind: kind === 'envelopes' ? kind : kind.kind,
    ids,
    rank,
    claim: Int32Array.from(biomes, (b) => Math.floor((b.weight ?? 1) * ONE + 0.5)),
    inputs,
    modes: Int32Array.from(inputs, (name) =>
      name.startsWith('mask/')
        ? 0
        : TEMPERATURE_LIKE.includes(name)
          ? 1
          : name === 'gdd5'
            ? 2
            : name === 'season'
              ? 3
              : name === 'rainfall'
                ? 4
                : name === 'alpha' || name === 'moisture'
                  ? 5
                  : 6,
    ),
    envelopes: flatten(dims, slotOf),
    score: kind === 'envelopes' ? undefined : kind.scorer(biomes, slotOf),
    paint: paint.map((p) => ({
      biome: ids.indexOf(p.biome),
      mode: MODES.indexOf(p.mode ?? 'replace'),
      layer: `paint/${p.biome}`,
      mask: p.mask,
    })),
  };
}

/** Validates paint layers against the biome ids. */
export function checkPaint(paint: readonly PaintLayer[], ids: readonly string[]): boolean {
  return (
    Array.isArray(paint) &&
    paint.every(
      (p) =>
        p &&
        ids.includes(p.biome) &&
        (p.mode === undefined || MODES.includes(p.mode)) &&
        (p.mask === undefined || (typeof p.mask === 'string' && p.mask.length > 0)),
    )
  );
}

/**
 * Memberships (Q16) of envelope `b` of `d` over a grid of `cells` cells into `m`, and the envelope's largest normalised
 * signed distance (Q16) into `far`; `values` holds one plane of warped values per input slot.
 */
export function membership(
  d: Dims,
  b: number,
  values: Int32Array,
  cells: number,
  m: Int32Array,
  far: Int32Array,
): void {
  m.fill(ONE);
  far.fill(-2147483647);
  for (let q = d.start[b], end = d.start[b + 1]; q < end; q++) {
    const v = values.subarray(d.slot[q] * cells, (d.slot[q] + 1) * cells),
      lo = d.lo[q],
      hi = d.hi[q],
      width = d.width[q],
      half = width >> 1;
    for (let k = 0; k < cells; k++) {
      const x = v[k],
        dist = Math.max(lo - x, x - hi), // negative inside
        f = clampInt(divFloor(dist * ONE, width), -1048576, 1048576),
        mk = m[k];
      if (f > far[k]) far[k] = f;
      if (mk) m[k] = Math.floor((mk * wendland(clampInt(divFloor((dist + half) * ONE, width), 0, ONE))) / ONE);
    }
  }
}

/** Memberships (Q16) of envelope `b` over `cells` cells into `m`, as {@link membership} without the distances. */
function memberships(d: Dims, b: number, values: Int32Array, cells: number, m: Int32Array): void {
  m.fill(ONE);
  for (let q = d.start[b], end = d.start[b + 1]; q < end; q++) {
    const at = d.slot[q] * cells,
      lo = d.lo[q],
      hi = d.hi[q],
      width = d.width[q],
      half = width >> 1;
    for (let k = 0; k < cells; k++) {
      const mk = m[k];
      if (!mk) continue;
      const x = values[at + k],
        reach = Math.max(lo - x, x - hi) + half;
      // Well inside (reach <= 0, wendland(0) = 1.0) keeps mk, past the ramp (reach >= width, wendland(1) = 0) is 0.
      if (reach > 0) m[k] = reach >= width ? 0 : Math.floor((mk * wendland(divFloor(reach * ONE, width))) / ONE);
    }
  }
}

/** The largest normalised signed distance (Q16) of envelope `b` at cell `k`, as {@link membership} writes to `far`. */
function farAt(d: Dims, b: number, values: Int32Array, cells: number, k: number): number {
  let far = -2147483647;
  for (let q = d.start[b], end = d.start[b + 1]; q < end; q++) {
    const x = values[d.slot[q] * cells + k],
      f = clampInt(divFloor(Math.max(d.lo[q] - x, x - d.hi[q]) * ONE, d.width[q]), -1048576, 1048576);
    if (f > far) far = f;
  }
  return far;
}

/** Inputs of a classification: layer getters over an n x depth grid (the tile plus a 1-cell margin). */
export interface ClassifyInput {
  /** Cells per grid row. */
  readonly n: number;
  /** Grid rows; default n (a square grid). */
  readonly depth?: number;
  layer(name: string): ArrayLike<number>;
  /**
   * A user layer over the grid (0..255 per cell, -1 where unpainted), or undefined when nothing is painted. With a
   * `margin`, over the grid grown by that many cells on every side ((n + 2 margin) x (depth + 2 margin) cells from
   * (gx - margin, gz - margin)).
   */
  user(name: string, margin?: number): ArrayLike<number> | undefined;
  /**
   * Half width in cells of the paint feather (see `classify`); 0 or absent composes paint cell by cell. The paint grids
   * are then read with a margin of twice this.
   */
  readonly ecotone?: number;
  /** Global cell of grid cell (0, 0). */
  readonly gx: number;
  readonly gz: number;
  readonly seed: number;
  /** Cell size, mm. */
  readonly cell: number;
}

/**
 * Planes reused by every classification on this thread (one per tile, several megabytes each): fresh arrays of that
 * size per tile cost every thread of the page (page faults, then releases), which shows as slower page frames while
 * workers make tiles. Grown when a larger grid comes; the caller writes each cell before reading it.
 */
const planes: Int32Array[] = [];
function scratch(at: number, length: number): Int32Array {
  let plane = planes[at];
  if (!plane || plane.length < length) plane = planes[at] = new Int32Array(length);
  return plane.length === length ? plane : plane.subarray(0, length);
}

/** Wavelength of the ecotone warp, mm. */
const WARP = 700_000;

/**
 * Classifies the inner (n - 2) x (depth - 2) cells: writes 4 ids and 4 weights (summing to 255) per cell into `ids`
 * and `weights` (rgba8, row-major over the inner cells). Unused slots hold id 255 and weight 0.
 */
export function classify(c: Classifier, input: ClassifyInput, ids: Uint8Array, weights: Uint8Array): void {
  const n = input.n,
    depth = input.depth ?? n,
    count = c.ids.length,
    cells = n * depth,
    member = scratch(0, count * cells),
    slots = c.inputs.length,
    modes = c.modes,
    { rank, envelopes } = c,
    // Every step below runs over whole planes of cells (one input, one envelope bound at a time), in the same order
    // per cell as a cell-by-cell loop, so the integers are the same and the loops stay small and monomorphic.
    warped = scratch(1, slots * cells),
    dT = scratch(2, cells),
    n2 = scratch(3, cells),
    feather = input.ecotone ?? 0,
    // The x warp noise, kept per cell only when paint is feathered (it moves where the paint is read).
    n1s = feather && c.paint.length ? scratch(6, cells) : undefined;
  // Warp noise on the 8-cell lattice covering this grid: lattice point (a, b) is global cell (8 (a0 + a), 8 (b0 + b)).
  // The lattice spans both axes on their own: a point's grid (sample) need not start at the same lattice phase in x
  // and z (a tile's always does).
  const a0 = input.gx >> 3,
    b0 = input.gz >> 3,
    span = ((input.gx + n) >> 3) - a0 + 2,
    rows = ((input.gz + depth) >> 3) - b0 + 2,
    warpA = new Int32Array(span * rows),
    warpB = new Int32Array(span * rows);
  for (let b = 0; b < rows; b++)
    for (let a = 0; a < span; a++) {
      const lx = divFloor((a0 + a) * 8 * input.cell * ONE, WARP),
        lz = divFloor((b0 + b) * 8 * input.cell * ONE, WARP);
      warpA[b * span + a] = fbm(input.seed ^ 0x5eed, lx, lz, 2);
      warpB[b * span + a] = fbm(input.seed ^ 0x7a1e, lz, lx, 2);
    }
  for (let j = 0; j < depth; j++) {
    const gz = input.gz + j - b0 * 8,
      fz = (gz & 7) << 13,
      row = (gz >> 3) * span;
    for (let i = 0; i < n; i++) {
      const k = j * n + i,
        gx = input.gx + i - a0 * 8,
        fx = (gx & 7) << 13,
        at = row + (gx >> 3),
        // The warp is smooth (700 m): noise on a global 8-cell lattice, bilinear between lattice points.
        topA = warpA[at] + Math.floor(((warpA[at + 1] - warpA[at]) * fx) / ONE),
        bottomA = warpA[at + span] + Math.floor(((warpA[at + span + 1] - warpA[at + span]) * fx) / ONE),
        topB = warpB[at] + Math.floor(((warpB[at + 1] - warpB[at]) * fx) / ONE),
        bottomB = warpB[at + span] + Math.floor(((warpB[at + span + 1] - warpB[at + span]) * fx) / ONE),
        n1 = topA + Math.floor(((bottomA - topA) * fz) / ONE) - 32768; // -0.5..0.5 in Q16
      n2[k] = topB + Math.floor(((bottomB - topB) * fz) / ONE) - 32768;
      if (n1s) n1s[k] = n1;
      dT[k] = Math.floor((n1 * 160) / 32768); // +-1.6 K at the extremes, cK
    }
  }
  // The warped inputs, one plane per input.
  for (let s = 0; s < slots; s++) {
    const mode = modes[s],
      name = c.inputs[s],
      source = mode ? input.layer(name) : input.user(name),
      out = warped.subarray(s * cells, (s + 1) * cells);
    if (!source) out.fill(0);
    else if (mode === 0) for (let k = 0; k < cells; k++) out[k] = Math.max(0, source[k]);
    else if (mode === 1) for (let k = 0; k < cells; k++) out[k] = source[k] + dT[k];
    else if (mode === 2) for (let k = 0; k < cells; k++) out[k] = Math.max(0, source[k] + 2 * dT[k]);
    else if (mode === 3) for (let k = 0; k < cells; k++) out[k] = clampInt(source[k] + Math.floor(dT[k] / 10), 0, 365);
    else if (mode === 4)
      for (let k = 0; k < cells; k++) {
        const v = source[k];
        out[k] = Math.max(0, v + Math.floor((v * n2[k] * 16) / 6553600));
      }
    else if (mode === 5)
      for (let k = 0; k < cells; k++) out[k] = clampInt(source[k] + Math.floor((n2[k] * 10) / 32768), 0, 255);
    else out.set(source);
  }
  // Envelope memberships. The nearest envelope (the fallback where no biome has weight) is found only at the cells that
  // need it, from the same distances `membership` gives, in biome order with ties by rank.
  const zones = !!c.score;
  // A zone scorer adds into the planes; envelope memberships fill them.
  if (zones) member.fill(0);
  else
    for (let b = 0; b < count; b++)
      memberships(envelopes, b, warped, cells, member.subarray(b * cells, (b + 1) * cells));
  c.score?.(warped, cells, member);
  // The biomes with any weight in this frame, in biome order: the planes of the others are all 0, and stay out of the sums.
  const live = new Int32Array(count);
  let liveCount = 0;
  for (let b = 0; b < count; b++) {
    const base = b * cells;
    for (let k = 0; k < cells; k++)
      if (member[base + k]) {
        live[liveCount++] = b;
        break;
      }
  }
  const nearestAt = (k: number) => {
    let best = -1,
      bestFar = 2147483647;
    for (let b = 0; b < count; b++) {
      const f = farAt(envelopes, b, warped, cells, k);
      if (f < bestFar || (f === bestFar && rank[b] < rank[best])) {
        best = b;
        bestFar = f;
      }
    }
    return best;
  };
  // The 3x3 box sums of every membership plane over the inner cells: rows of three, then three rows (the same integer
  // sums as adding the nine cells).
  const inner = n - 2,
    innerRows = depth - 2,
    // Every cell of these is written before it is read (rowSum at 1..cells - 2, box at the inner cells).
    rowSum = scratch(4, cells),
    box = scratch(5, count * cells);
  for (let l = 0; l < liveCount; l++) {
    const base = live[l] * cells;
    for (let k = 1; k < cells - 1; k++) rowSum[k] = member[base + k - 1] + member[base + k] + member[base + k + 1];
    for (let j = 1; j <= innerRows; j++)
      for (let i = 1, k = j * n + 1; i <= inner; i++, k++) box[base + k] = rowSum[k - n] + rowSum[k] + rowSum[k + n];
  }
  // Biome weights scale the memberships; with every weight at 1.0 the memberships are used as they are.
  const claim = c.claim,
    claimed = claim.some((q) => q !== ONE),
    w = new Int32Array(count),
    pick = new Int32Array(count),
    blocked = new Uint8Array(count),
    share = new Int32Array(4),
    order = new Int32Array(4),
    paint = c.paint,
    feathered = new Map<string, Int32Array | undefined>(),
    read = (name: string, neutral: number) => {
      if (!n1s) return input.user(name);
      const key = `${neutral}:${name}`;
      if (!feathered.has(key)) feathered.set(key, featherPaint(input, name, neutral, feather, n1s, n2));
      return feathered.get(key);
    },
    paintGrid = paint.map((p) => (p.biome < 0 ? undefined : read(p.layer, p.mode === 2 ? 255 : 0))),
    maskGrid = paint.map((p) => (p.mask ? read(p.mask, 0) : undefined));
  let stale = false;
  for (let j = 0; j < innerRows; j++)
    for (let i = 0; i < inner; i++) {
      const k = (j + 1) * n + i + 1,
        out = (j * inner + i) * 4;
      let total = 0,
        only = -1,
        some = 0;
      // The steps below leave weights in biomes that are not live.
      if (stale) {
        w.fill(0);
        stale = false;
      }
      for (let l = 0; l < liveCount; l++) {
        const b = live[l],
          v = Math.floor(box[b * cells + k] / 9);
        // A member biome keeps at least 1 after scaling, so a weight below 1 never removes a biome from a cell.
        const scaled = claimed && v ? Math.max(1, divFloor(v * claim[b], ONE)) : v;
        w[b] = scaled;
        total += scaled;
        if (v) {
          some++;
          only = b;
        }
      }
      if (!paint.length && some <= 1) {
        // One biome (or none: the nearest envelope) takes all 255: what the general steps below give for one weight.
        ids[out] = some ? only : nearestAt(k);
        weights[out] = 255;
        for (let s = 1; s < 4; s++) {
          ids[out + s] = 255;
          weights[out + s] = 0;
        }
        continue;
      }
      stale = true;
      if (!total) {
        w[nearestAt(k)] = ONE;
        total = ONE;
      }
      for (let b = 0; b < count; b++) if (w[b]) w[b] = divFloor(w[b] * ONE, total);
      // Paint layers, in order.
      blocked.fill(0);
      for (let q = 0; q < paint.length; q++) {
        const grid = paintGrid[q],
          raw = grid ? grid[k] : -1;
        if (raw < 0) continue;
        const p = paint[q],
          mask = maskGrid[q],
          mv = mask ? mask[k] : -1;
        let amount = divFloor(raw * ONE, 255);
        if (p.mask) amount = divFloor(amount * (mv < 0 ? 0 : mv), 255);
        if (p.mode === 0) {
          for (let b = 0; b < count; b++) w[b] = Math.floor((w[b] * (ONE - amount)) / ONE);
          w[p.biome] += amount;
        } else if (p.mode === 1) w[p.biome] += amount;
        else if (p.mode === 2) {
          w[p.biome] = Math.floor((w[p.biome] * amount) / ONE);
          if (!amount) blocked[p.biome] = 1;
        } else w[p.biome] = Math.max(w[p.biome], amount);
      }
      total = 0;
      for (let b = 0; b < count; b++) total += w[b];
      if (!total) {
        // Everything painted away: the nearest envelope among the biomes paint did not multiply to 0.
        let pickB = nearestAt(k),
          pickFar = 2147483647;
        for (let b = 0; b < count; b++) {
          if (blocked[b]) continue;
          const f = farAt(envelopes, b, warped, cells, k);
          if (f < pickFar || (f === pickFar && rank[b] < rank[pickB])) {
            pickB = b;
            pickFar = f;
          }
        }
        w[pickB] = ONE;
        total = ONE;
      }
      // Top 4 by weight, ties by rank (insertion into a list sorted by weight, then rank).
      let used = 0;
      for (let b = 0; b < count; b++) {
        if (!w[b]) continue;
        let at = used++;
        while (at > 0 && (w[pick[at - 1]] < w[b] || (w[pick[at - 1]] === w[b] && rank[pick[at - 1]] > rank[b]))) {
          pick[at] = pick[at - 1];
          at--;
        }
        pick[at] = b;
      }
      used = Math.min(used, 4);
      // Largest remainder to 255.
      let sum = 0,
        given = 0;
      for (let s = 0; s < used; s++) sum += w[pick[s]];
      for (let s = 0; s < used; s++) {
        share[s] = divFloor(w[pick[s]] * 255, sum);
        given += share[s];
      }
      for (let left = 255 - given; left > 0; left--) {
        let top = 0,
          topRem = -1;
        for (let s = 0; s < used; s++) {
          const rem = w[pick[s]] * 255 - share[s] * sum;
          if (rem > topRem) {
            top = s;
            topRem = rem;
          }
        }
        share[top]++;
        // Spent: its remainder drops below every other one.
        w[pick[top]] -= sum;
      }
      // Slots by final weight, ties by slot (stable over the rank order they are already in).
      for (let s = 0; s < used; s++) {
        let at = s;
        while (at > 0 && share[order[at - 1]] < share[s]) {
          order[at] = order[at - 1];
          at--;
        }
        order[at] = s;
      }
      for (let s = 0; s < 4; s++) {
        const live = s < used && share[order[s]] > 0;
        ids[out + s] = live ? pick[order[s]] : 255;
        weights[out + s] = live ? share[order[s]] : 0;
      }
    }
}

/**
 * A paint or mask raster as the classification composes it with an ecotone: each cell reads the raster at its warped
 * position (the same 700 m noise that moves the climate inputs, up to `h` cells in x and z) through a (2h + 1)^2 box
 * mean, so a painted edge ramps over the box and wanders like the climate borders. Unpainted cells count as `neutral`
 * (0, or 255 for a multiply layer: what composing nothing gives); a box with no painted cell stays unpainted (-1).
 * Separable integer sums, rounded to nearest: the same bytes everywhere. Undefined when the layer holds nothing.
 */
function featherPaint(
  input: ClassifyInput,
  name: string,
  neutral: number,
  h: number,
  n1: Int32Array,
  n2: Int32Array,
): Int32Array | undefined {
  const reach = 2 * h,
    source = input.user(name, reach);
  if (!source) return undefined;
  const n = input.n,
    depth = input.depth ?? n,
    side = n + 2 * reach, // the read grid: side x (depth + 2 reach)
    centres = n + reach, // box centres: grid cells moved by -h..h, centres x centreRows
    centreRows = depth + reach,
    width = 2 * h + 1,
    area = width * width,
    rowValue = new Int32Array((depth + 2 * reach) * centres),
    rowCount = new Int32Array((depth + 2 * reach) * centres);
  // Horizontal box sums: rowValue[j][c] sums read cells (c..c + 2h, j).
  for (let j = 0; j < depth + 2 * reach; j++) {
    const at = j * side,
      out = j * centres;
    let value = 0,
      count = 0;
    for (let t = 0; t < width; t++) {
      const v = source[at + t];
      if (v < 0) value += neutral;
      else {
        value += v;
        count++;
      }
    }
    for (let c = 0; ; c++) {
      rowValue[out + c] = value;
      rowCount[out + c] = count;
      if (c + 1 === centres) break;
      const leave = source[at + c],
        enter = source[at + c + width];
      if (leave < 0) value -= neutral;
      else {
        value -= leave;
        count--;
      }
      if (enter < 0) value += neutral;
      else {
        value += enter;
        count++;
      }
    }
  }
  // Vertical sums of the row sums, then each grid cell reads the box centred at its warped position.
  const boxValue = new Int32Array(centreRows * centres),
    boxCount = new Int32Array(centreRows * centres);
  for (let c = 0; c < centres; c++) {
    let value = 0,
      count = 0;
    for (let t = 0; t < width; t++) {
      value += rowValue[t * centres + c];
      count += rowCount[t * centres + c];
    }
    for (let r = 0; ; r++) {
      boxValue[r * centres + c] = value;
      boxCount[r * centres + c] = count;
      if (r + 1 === centreRows) break;
      value += rowValue[(r + width) * centres + c] - rowValue[r * centres + c];
      count += rowCount[(r + width) * centres + c] - rowCount[r * centres + c];
    }
  }
  const out = new Int32Array(n * depth);
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i,
        // -0.5..0.5 in Q16 to -h..h cells.
        dx = clampInt(Math.floor((n1[k] * reach) / ONE), -h, h),
        dz = clampInt(Math.floor((n2[k] * reach) / ONE), -h, h),
        at = (j + h + dz) * centres + i + h + dx;
      out[k] = boxCount[at] ? divFloor(2 * boxValue[at] + area, 2 * area) : -1;
    }
  return out;
}
