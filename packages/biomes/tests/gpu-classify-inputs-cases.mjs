// Shared deterministic correctness matrix. No timings; no GPU implementation is used by the BigInt oracle.
import { random } from './random.js';
import { warpOracle } from './gpu-classify-warp-cases.mjs';
export { requireHardwareAdapter } from './gpu-classify-warp-cases.mjs';

export const INPUTS_CASE_COUNT = 17;
const BOUND = 1073741824;
const edges = [-BOUND, BOUND, -65537, -1, 0, 1, 254, 255, 256, 364, 365, 366, 409599, 409600, 409601];

function dims(groups) {
  const all = groups.flat(),
    start = new Int32Array(groups.length + 1);
  groups.forEach((group, b) => {
    start[b + 1] = start[b] + group.length;
  });
  return {
    start,
    slot: Int32Array.from(all, (d) => d[0]),
    lo: Float64Array.from(all, (d) => d[1]),
    hi: Float64Array.from(all, (d) => d[2]),
    width: Int32Array.from(all, (d) => d[3]),
  };
}

// Builders are supplied explicitly so this data module also loads in the Node hardware launcher without TS hooks.
export function inputsCases(module) {
  const next = random(0x1a5b1),
    cases = [];
  const make = (name, n = 7, depth = 19, extra = {}) => {
    const inputs = [
      'mask/mode0',
      'temperature',
      'gdd5',
      'season',
      'rainfall',
      'alpha',
      'height',
      'missing',
      'mask/missing',
    ];
    const c = {
      kind: 'envelopes',
      ids: ['z', 'a', 'b', 'c', 'd', 'e'],
      rank: Int32Array.of(5, 0, 1, 2, 3, 4),
      claim: Int32Array.of(65536, 32768, 131072, 65536, 65536, 65536),
      inputs,
      modes: Int32Array.of(0, 1, 2, 3, 4, 5, 6, 6, 0),
      paint: [],
      envelopes: dims([
        [[6, -10, 10, 8]],
        [[6, -2147483648, 2147483647, 2147483647]],
        [[6, 0, 0, 1]],
        [[1, -100, 100, 65537]],
        [
          [6, 1000000, 1000001, 1],
          [6, -2147483648, 2147483647, 2147483647],
        ],
        [
          [6, -5, 5, 9],
          [5, 0, 255, 255],
        ],
      ]),
    };
    const sources = new Map(
      inputs
        .slice(0, 7)
        .map((s, slot) => [
          s,
          Int32Array.from({ length: n * depth }, (_, k) =>
            k < edges.length ? edges[(k + slot) % edges.length] : Math.floor(next() * (2 * BOUND + 1)) - BOUND,
          ),
        ]),
    );
    const input = {
      n,
      depth,
      gx: -41,
      gz: -9,
      seed: 0xffffffff,
      cell: 4000,
      ecotone: 0,
      layer: (s) => sources.get(s),
      user: (s, margin = 0) => {
        if (sources.has(s)) return sources.get(s);
        if (!s.startsWith('paint/') && s !== 'mask/paint') return undefined;
        if ((extra.missingPaint && s === 'paint/z') || (extra.missingMask && s === 'mask/paint')) return undefined;
        return Int32Array.from({ length: (n + 2 * margin) * (depth + 2 * margin) }, (_, k) =>
          extra.away ? 0 : k % 7 === 0 ? -1 : (k * 73 + s.length * 11) % 256,
        );
      },
    };
    const s = { name, c, input, sources };
    cases.push(s);
    return s;
  };
  make('all modes and signed boundaries');
  make('partial wide rectangle', 33, 5);
  make('minimum inner cell', 3, 3);
  const boundary = make('membership reach and open bounds', 9, 17);
  boundary.sources.set(
    'height',
    Int32Array.from(
      { length: 153 },
      (_, k) => [-20, -19, -16, -15, -14, -13, -12, -11, -10, -9, -8, -7, 0, 2147483647 >> 1, -1073741824][k % 15],
    ),
  );
  boundary.c.envelopes = dims([
    [[6, -20, -20, 8]],
    [[6, -2147483648, 2147483647, 2147483647]],
    [[6, -20, -20, 1]],
    [[6, -2147483648, -2147483648, 2147483647]],
    [[6, 2147483647, 2147483647, 2147483647]],
    [[6, 0, 0, 2147483646]],
  ]);
  const tie = make('six ties top four by rank', 5, 7);
  tie.c.envelopes = dims(Array.from({ length: 6 }, () => []));
  tie.c.claim.fill(65536);
  const nearest = make('nearest envelope fallback', 3, 5);
  nearest.sources.set('height', new Int32Array(15));
  nearest.c.envelopes = dims(Array.from({ length: 6 }, (_, b) => [[6, 100 + b * 100, 101 + b * 100, 1]]));
  for (const ecotone of [0, 2]) {
    const painted = make(`paint all modes feather ${ecotone}`, 7, 11);
    painted.input.ecotone = ecotone;
    painted.c.paint = [0, 1, 2, 3].map((mode, b) => ({
      biome: b,
      mode,
      layer: `paint/${painted.c.ids[b]}`,
      mask: b % 2 ? 'mask/paint' : undefined,
    }));
  }
  for (const option of ['missingPaint', 'missingMask']) {
    const s = make(option, 5, 9, { [option]: true });
    s.c.paint = [{ biome: 0, mode: 0, layer: 'paint/z', mask: 'mask/paint' }];
    s.input.ecotone = 1;
  }
  const away = make('everything painted away', 3, 3, { away: true });
  away.c.envelopes = dims([[], ...Array.from({ length: 5 }, () => [[6, 100, 101, 1]])]);
  away.sources.set('height', new Int32Array(9));
  away.c.paint = [{ biome: 0, mode: 2, layer: 'paint/z' }];
  for (const [name, kind] of [
    ['presets envelopes', 'envelopes'],
    ['presets whittaker', module.whittaker],
    ['presets holdridge', module.holdridge],
  ]) {
    const s = make(name, 11, 7);
    s.c = module.classifier(
      Object.values(module.presets).filter((b) => b.id !== 'beach'),
      kind,
      [],
    );
    s.input.layer = (name) =>
      Int32Array.from({ length: 77 }, (_, k) =>
        name === 'rainfall'
          ? 500 + k * 70
          : name === 'gdd5'
            ? 120000
            : name === 'season'
              ? 240
              : name === 'alpha' || name === 'moisture'
                ? 180
                : (k % 7) * 600 - 1200,
      );
  }
  const missingMultiply = make('multiply missing is neutral', 5, 3, { missingPaint: true });
  missingMultiply.c.paint = [{ biome: 0, mode: 2, layer: 'paint/z' }];
  const exact = make('exact ramp endpoints and sub-Q16 reach', 9, 5);
  exact.input.seed = 1; // This rectangle has negative dT with nonzero /10 remainders.
  exact.input.gx = 13;
  exact.input.gz = -200;
  const ramp = [
    -25,
    -24,
    -23,
    -21,
    -20,
    -19,
    -16,
    -15,
    -14,
    -13,
    -12,
    -11,
    -10,
    -9,
    -7,
    -6,
    -5,
    0,
    1,
    2,
    -BOUND,
    BOUND,
  ];
  exact.sources.set(
    'height',
    Int32Array.from({ length: 45 }, (_, k) => ramp[k % ramp.length]),
  );
  exact.c.envelopes = dims([
    [[6, -20, -10, 8]],
    [[6, -20, -10, 1]],
    [[6, -1, 1, 2147483647]],
    [[6, -BOUND, BOUND, 2147483647]],
    [
      [6, 100, 101, 1],
      [6, -2147483648, 2147483647, 2147483647],
    ],
    [
      [6, -20, -10, 9],
      [6, -20, -10, 8],
      [6, -25, 5, 31],
    ],
  ]);
  const masked = make('paint alternate mask arrangement', 11, 5);
  masked.input.ecotone = 2;
  masked.c.paint = [0, 1, 2, 3].map((mode, b) => ({
    biome: b,
    mode,
    layer: `paint/${masked.c.ids[b]}`,
    mask: b % 2 ? undefined : 'mask/paint',
  }));
  if (cases.length !== INPUTS_CASE_COUNT) throw new Error('Review complete classification fixture matrix');
  return cases;
}

export function inputsOracle(c, input, warpLattice) {
  const cells = input.n * (input.depth ?? input.n),
    warp = warpOracle(
      warpLattice(input.seed, input.cell, input.gx, input.gz, input.n, input.depth ?? input.n),
      input.gx,
      input.gz,
      input.n,
      input.depth ?? input.n,
    ),
    warped = new Int32Array(c.inputs.length * cells),
    member = new Int32Array(c.ids.length * cells);
  const floor = (a, b) => a / b - (a < 0n && a % b ? 1n : 0n),
    max = (a, b) => (a > b ? a : b),
    clamp = (a, hi) => (a < 0n ? 0n : a > hi ? hi : a);
  for (let slot = 0; slot < c.inputs.length; slot++) {
    const mode = c.modes[slot],
      source = mode ? input.layer(c.inputs[slot]) : input.user(c.inputs[slot]);
    if (!source) continue;
    for (let k = 0; k < cells; k++) {
      const v = BigInt(source[k]),
        t = BigInt(warp.dT[k]),
        noise = BigInt(warp.n2[k]);
      const value =
        mode === 0
          ? max(0n, v)
          : mode === 1
            ? v + t
            : mode === 2
              ? max(0n, v + 2n * t)
              : mode === 3
                ? clamp(v + floor(t, 10n), 365n)
                : mode === 4
                  ? max(0n, v + floor(v * noise, 409600n))
                  : mode === 5
                    ? clamp(v + floor(noise * 10n, 32768n), 255n)
                    : v;
      warped[slot * cells + k] = Number(value);
    }
  }
  if (c.score)
    c.score(warped, cells, member); // Zone scorer is deliberately the shared CPU algorithm.
  else
    for (let b = 0; b < c.ids.length; b++)
      for (let k = 0; k < cells; k++) {
        let mk = 65536n;
        for (let q = c.envelopes.start[b]; q < c.envelopes.start[b + 1]; q++) {
          const x = BigInt(warped[c.envelopes.slot[q] * cells + k]),
            width = BigInt(c.envelopes.width[q]),
            reach = max(BigInt(c.envelopes.lo[q]) - x, x - BigInt(c.envelopes.hi[q])) + width / 2n;
          if (reach <= 0n) continue;
          if (reach >= width) {
            mk = 0n;
            break;
          }
          const r = (reach * 65536n) / width,
            s = 65536n - r,
            s2 = (s * s) / 65536n,
            s4 = (s2 * s2) / 65536n,
            w = (s4 * (4n * r + 65536n)) / 65536n;
          mk = (mk * w) / 65536n;
        }
        member[b * cells + k] = Number(mk);
      }
  return { warped, member, n2: warp.n2, n1s: input.ecotone && c.paint.length ? warp.n1 : undefined };
}
