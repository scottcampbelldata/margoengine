// Procedural 16 x 16 pixel-art block textures, painted in code from seeded noise (no image files). Every texture tiles:
// noise wraps around the edges, so greedy quads that repeat a texture across many blocks show no seams. The pixels are
// raw sRGB RGBA8, the `{width, height, data}` shape BlockTextures takes without a DOM.

/** One texture layer: 16 x 16 RGBA8 sRGB pixels, top row first. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

type RGB = readonly [number, number, number];
type Random = () => number;

const S = 16;
/** Frames of the animated water texture (consecutive layers). */
export const WATER_FRAMES = 8;

// mulberry32: a small seeded generator, so every load paints the same pixels.
const generator = (seed: number): Random => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

class Canvas16 {
  readonly data = new Uint8Array(S * S * 4);
  set(x: number, y: number, [r, g, b]: RGB, a = 255): void {
    const i = (((y & 15) << 4) | (x & 15)) * 4;
    this.data[i] = Math.max(0, Math.min(255, Math.round(r)));
    this.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    this.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    this.data[i + 3] = a;
  }
  get(x: number, y: number): RGB {
    const i = (((y & 15) << 4) | (x & 15)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }
  alpha(x: number, y: number): number {
    return this.data[(((y & 15) << 4) | (x & 15)) * 4 + 3];
  }
  pixels(): Pixels {
    return { width: S, height: S, data: this.data };
  }
}

// Tileable value noise in 0..1: per-pixel random values blurred with wrap-around, `passes` times, then stretched back
// to the full range. More passes give larger blotches.
function field(random: Random, passes: number): Float32Array {
  let f = Float32Array.from({ length: S * S }, random);
  for (let p = 0; p < passes; p++) {
    const g = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) sum += f[(((y + dy) & 15) << 4) | ((x + dx) & 15)] * (dx || dy ? 1 : 2);
        g[(y << 4) | x] = sum / 10;
      }
    f = g;
  }
  let lo = 1,
    hi = 0;
  for (const v of f) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return f.map((v) => (v - lo) / (hi - lo || 1));
}

// Picks from a dark-to-light palette by `t` in 0..1.
const pick = (palette: readonly RGB[], t: number): RGB =>
  palette[Math.min(palette.length - 1, Math.max(0, Math.floor(t * palette.length)))];
const scale = ([r, g, b]: RGB, k: number): RGB => [r * k, g * k, b * k];

// Blotchy noise texture: smooth field mixed with per-pixel grain, mapped through a palette.
function speckled(random: Random, palette: readonly RGB[], passes = 2, grain = 0.35): Canvas16 {
  const c = new Canvas16(),
    f = field(random, passes);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) c.set(x, y, pick(palette, f[(y << 4) | x] * (1 - grain) + random() * grain));
  return c;
}

const STONE: RGB[] = [
  [98, 98, 100],
  [110, 110, 112],
  [121, 121, 123],
  [128, 128, 130],
  [136, 136, 138],
  [146, 146, 148],
];
const DIRT: RGB[] = [
  [96, 66, 44],
  [110, 77, 51],
  [121, 86, 58],
  [134, 96, 66],
  [146, 106, 73],
];
const GRASS: RGB[] = [
  [70, 116, 38],
  [80, 130, 44],
  [91, 143, 50],
  [100, 155, 56],
  [112, 166, 64],
];
const SAND: RGB[] = [
  [204, 191, 145],
  [214, 201, 155],
  [221, 209, 164],
  [228, 217, 174],
  [235, 225, 184],
];
const LEAVES: RGB[] = [
  [38, 86, 28],
  [46, 100, 33],
  [56, 115, 38],
  [66, 128, 44],
  [80, 142, 52],
];
const BARK: RGB[] = [
  [74, 56, 34],
  [88, 67, 41],
  [101, 78, 48],
  [114, 89, 56],
];
const WOOD: RGB[] = [
  [140, 108, 62],
  [152, 119, 70],
  [164, 130, 78],
  [176, 141, 87],
];

function stone(random: Random): Canvas16 {
  const c = speckled(random, STONE, 2, 0.3);
  // A few short dark cracks.
  for (let n = 0; n < 5; n++) {
    let x = Math.floor(random() * S),
      y = Math.floor(random() * S);
    for (let k = 0; k < 2 + Math.floor(random() * 3); k++) {
      c.set(x, y, scale(c.get(x, y), 0.78));
      x += random() < 0.5 ? 1 : 0;
      y += random() < 0.6 ? 1 : 0;
    }
  }
  return c;
}

function dirt(random: Random): Canvas16 {
  const c = speckled(random, DIRT, 1, 0.45);
  // Pebbles: single light pixels with a dark one under them.
  for (let n = 0; n < 7; n++) {
    const x = Math.floor(random() * S),
      y = Math.floor(random() * S);
    c.set(x, y, [158, 120, 88]);
    c.set(x, y + 1, scale(c.get(x, y + 1), 0.8));
  }
  return c;
}

function grassTop(random: Random): Canvas16 {
  const c = speckled(random, GRASS, 1, 0.5);
  // Darker blade tips.
  for (let n = 0; n < 24; n++) {
    const x = Math.floor(random() * S),
      y = Math.floor(random() * S);
    c.set(x, y, scale(c.get(x, y), 0.82));
  }
  return c;
}

// Dirt with a grass fringe along the top that drips 1-4 pixels down unevenly.
function grassSide(random: Random): Canvas16 {
  const c = dirt(random),
    top = speckled(random, GRASS, 1, 0.5);
  let depth = 3;
  for (let x = 0; x < S; x++) {
    depth = Math.max(2, Math.min(5, depth + (random() < 0.5 ? -1 : 1) * (random() < 0.6 ? 1 : 0)));
    const d = x === 0 || x === S - 1 ? 3 : depth; // the same depth at both edges, so it tiles sideways
    for (let y = 0; y < d; y++) c.set(x, y, scale(top.get(x, y), y === d - 1 ? 0.84 : 1));
  }
  return c;
}

function sand(random: Random): Canvas16 {
  const c = speckled(random, SAND, 1, 0.55);
  for (let n = 0; n < 6; n++) c.set(Math.floor(random() * S), Math.floor(random() * S), [190, 174, 128]);
  return c;
}

// Water: deep blue with light ripple bands that drift diagonally frame by frame; alpha about 0.7.
function water(random: Random, frame: number): Canvas16 {
  const c = new Canvas16(),
    f = field(random, 2);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const phase = ((x + y * 2 + frame * 2) % 16) / 16,
        wave = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5,
        n = f[(((y + frame * 2) & 15) << 4) | x],
        t = wave * 0.6 + n * 0.4,
        color: RGB = t > 0.82 ? [92, 150, 232] : t > 0.6 ? [58, 112, 214] : t > 0.3 ? [44, 92, 198] : [36, 80, 184];
      c.set(x, y, color, t > 0.82 ? 200 : 178);
    }
  return c;
}

// Bark: vertical streaks with a few knots.
function logSide(random: Random): Canvas16 {
  const c = new Canvas16(),
    columns = Array.from({ length: S }, () => random());
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = columns[x] * 0.7 + random() * 0.3,
        groove = x % 4 === 1 && random() < 0.8;
      c.set(x, y, groove ? scale(pick(BARK, v), 0.72) : pick(BARK, v));
    }
  return c;
}

// End grain: rings around the middle inside a ring of bark.
function logTop(random: Random): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const edge = x === 0 || y === 0 || x === S - 1 || y === S - 1,
        r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)),
        ring = Math.floor(r) % 2 === 0;
      c.set(x, y, edge ? pick(BARK, random()) : ring ? [168, 134, 80] : [186, 150, 94]);
    }
  return c;
}

// Leaves: green clusters with about a third of the pixels cut out (alpha 0), clumped by the noise.
function leaves(random: Random): Canvas16 {
  const c = new Canvas16(),
    f = field(random, 1);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = f[(y << 4) | x],
        hole = v < 0.28 || random() < 0.1;
      c.set(x, y, pick(LEAVES, v * 0.6 + random() * 0.4), hole ? 0 : 255);
    }
  return c;
}

// Planks: four boards with grain, dark seams and offset end joints.
function planks(random: Random): Canvas16 {
  const c = new Canvas16(),
    joints = [3, 11, 7, 14];
  for (let y = 0; y < S; y++) {
    const board = y >> 2,
      seam = (y & 3) === 3,
      tone = random() * 0.4 + 0.3;
    for (let x = 0; x < S; x++) {
      const joint = x === joints[board],
        grain = Math.sin((x + board * 5) * 0.9 + random() * 0.6) * 0.15;
      c.set(x, y, seam || joint ? [112, 84, 48] : pick(WOOD, tone + grain + random() * 0.2));
    }
  }
  return c;
}

// Cobblestone: rounded stones (nearest of a few seeds, distance wrapping around the tile) in dark mortar, lit from
// the top left.
function cobblestone(random: Random): Canvas16 {
  const c = new Canvas16(),
    seeds = Array.from({ length: 9 }, () => [random() * S, random() * S, 0.75 + random() * 0.4]);
  const wrap = (d: number) => Math.min(Math.abs(d), S - Math.abs(d));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let a = Infinity,
        b = Infinity,
        k = 0;
      for (const [sx, sy, tone] of seeds) {
        const d = Math.hypot(wrap(x + 0.5 - sx), wrap(y + 0.5 - sy));
        if (d < a) {
          b = a;
          a = d;
          k = tone;
        } else if (d < b) b = d;
      }
      const edge = b - a,
        base = 118 * k + random() * 14;
      if (edge < 1.1) c.set(x, y, [72, 72, 74]);
      else
        c.set(x, y, [base + (edge < 2.2 ? -16 : 10), base + (edge < 2.2 ? -16 : 10), base + (edge < 2.2 ? -14 : 12)]);
    }
  return c;
}

// Bricks: 8 x 4 bricks with half-brick offsets in light mortar.
function bricks(random: Random): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const row = y >> 2,
        mortar = (y & 3) === 3 || (x + (row & 1) * 4) % 8 === 7;
      if (mortar) c.set(x, y, [182, 174, 162]);
      else {
        const k = 0.88 + random() * 0.16 + ((y & 3) === 0 ? 0.08 : 0);
        c.set(x, y, scale([152, 72, 56], k));
      }
    }
  return c;
}

// Glass: almost clear, a light frame and two highlight streaks.
function glass(): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const frame = x === 0 || y === 0 || x === S - 1 || y === S - 1,
        streak = (x - y === 4 && x > 5 && x < 10) || (x - y === 7 && x > 8 && x < 12);
      if (frame) c.set(x, y, [218, 236, 242], 235);
      else if (streak) c.set(x, y, [240, 250, 255], 150);
      else c.set(x, y, [200, 228, 240], 28);
    }
  return c;
}

// Cross-shaped plants and the torch: transparent backgrounds, drawn on two diagonal quads.
function torch(): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) c.set(x, y, [0, 0, 0], 0);
  for (let y = 7; y < S; y++) {
    c.set(7, y, [92, 64, 34]);
    c.set(8, y, [70, 48, 26]);
  }
  // Flame: a white-yellow core in an orange body, widest just above the stick.
  const rows = ['.oo.', 'oyyo', 'yWWy', 'oWWo', 'oyyo', '.oo.'],
    colors: Record<string, RGB> = { o: [236, 104, 12], y: [255, 178, 28], W: [255, 232, 120] };
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < 4; dx++) if (row[dx] !== '.') c.set(6 + dx, 1 + dy, colors[row[dx]]);
  });
  return c;
}

function tallGrass(random: Random): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) c.set(x, y, [0, 0, 0], 0);
  for (let blade = 0; blade < 9; blade++) {
    let x = 1 + Math.floor(random() * 14);
    const height = 6 + Math.floor(random() * 9),
      color = pick(GRASS, random());
    for (let k = 0; k < height; k++) {
      const y = S - 1 - k;
      c.set(x, y, scale(color, 0.85 + (k / height) * 0.3));
      if (k > height / 2 && random() < 0.25) x += random() < 0.5 ? -1 : 1;
      x = Math.max(0, Math.min(S - 1, x));
    }
  }
  return c;
}

function flower(petal: RGB, centre: RGB, random: Random): Canvas16 {
  const c = new Canvas16();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) c.set(x, y, [0, 0, 0], 0);
  for (let y = 8; y < S; y++) c.set(7, y, [64, 118, 40]);
  for (const [x, y] of [
    [6, 12],
    [5, 11],
    [8, 13],
    [9, 12],
  ])
    c.set(x, y, [76, 134, 46]);
  for (let y = 3; y < 8; y++)
    for (let x = 5; x < 10; x++) {
      const d = Math.hypot(x - 7, y - 5.2);
      if (d < 2.6) c.set(x, y, d < 1 ? centre : scale(petal, 0.9 + random() * 0.2));
    }
  return c;
}

function glowstone(random: Random): Canvas16 {
  return speckled(
    random,
    [
      [150, 84, 26],
      [196, 124, 40],
      [228, 164, 58],
      [246, 198, 86],
      [255, 226, 130],
    ],
    1,
    0.5,
  );
}

// Layer order: the index of a name in this list is its texture layer. Water's frames are consecutive layers.
const PAINTERS: readonly [string, (random: Random) => Canvas16][] = [
  ['stone', stone],
  ['dirt', dirt],
  ['grass_top', grassTop],
  ['grass_side', grassSide],
  ['sand', sand],
  ...Array.from({ length: WATER_FRAMES }, (_, i): [string, (random: Random) => Canvas16] => [
    i ? `water_${i}` : 'water',
    (random) => water(random, i),
  ]),
  ['log_side', logSide],
  ['log_top', logTop],
  ['leaves', leaves],
  ['planks', planks],
  ['cobblestone', cobblestone],
  ['bricks', bricks],
  ['glass', glass],
  ['torch', torch],
  ['tall_grass', tallGrass],
  ['dandelion', (random) => flower([246, 214, 36], [214, 142, 20], random)],
  ['poppy', (random) => flower([208, 36, 32], [52, 30, 24], random)],
  ['glowstone', glowstone],
];

/** Texture layer names in layer order. */
export const TEXTURE_NAMES: readonly string[] = PAINTERS.map(([name]) => name);

/** The texture layer of `name`; throws RangeError for an unknown name. */
export function textureLayer(name: string): number {
  const layer = TEXTURE_NAMES.indexOf(name);
  if (layer < 0) throw new RangeError(`No block texture "${name}"; use one of ${TEXTURE_NAMES.join(', ')}`);
  return layer;
}

/**
 * Paints every texture layer, layer 0 first. Each texture has its own seed (its layer index; water frames share
 * one), so changing one painter leaves the others' pixels alone.
 */
export function paintBlockTextures(): Pixels[] {
  return PAINTERS.map(([name, paint], layer) =>
    paint(generator(name.startsWith('water') ? 977 : 101 + layer)).pixels(),
  );
}
