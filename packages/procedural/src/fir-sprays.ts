import { geometryData, type GeometryData } from '@margoengine/geometry/utils';
import { rangeError, typeError } from '../../shared/errors.js';

/** Normalized atlas rectangle [u0, v0, u1, v1], with the spray tip toward v0 and its stem toward v1. */
export type FirSprayRegion = readonly [number, number, number, number];

/** Dimensions of the fir's foliage in metres and its source texture layout. */
export interface FirSprayOptions {
  /** Top of the crown. Default 18.64. */
  readonly height?: number;
  /** Base of the live crown, below height. Defaults to 29.5 percent of height (5.5 m at the default height). */
  readonly crownBase?: number;
  /** Nominal radius of the widest whorl. Defaults to 3.29 m at the default height and scales with height. */
  readonly radius?: number;
  /** Seed for branch angles, droop, and atlas selection. Default 730956. */
  readonly seed?: number;
  /** One to 64 rectangles. Default [[0, 0, 1, 1]], for a single full-texture spray. */
  readonly regions?: readonly FirSprayRegion[];
}

interface Bough {
  yaw: number;
  y: number;
  radial: number;
  tipY: number;
  roll: number;
  leaf: FirSprayRegion;
}

/**
 * [width, length] factors of the sprays each ring keeps, so its foliage area stays near the near ring's (area-preserving
 * foliage simplification: Remolar, Chover, Belmonte, Ribelles and Rebollo 2002, "Geometric simplification of foliage",
 * Eurographics short papers; Zhang, Blaise and Jaeger 2006, "Multiresolution plant models with complex organs", ACM
 * GRAPHITE). Near ring: main spray 0.62 r^2 and two side arms of 0.245 r^2, 1.11 r^2 a bough. Middle ring: one arm,
 * 0.865 r^2; 1.17 x 1.1 brings it to 1.11. Far ring: every other row under the tip and an arm on every other bough,
 * 0.74 r^2 a kept row for two rows of the near ring, 2.22 r^2; 2.3 x 1.3 brings it to 2.21. Alpha mips keep their
 * coverage at the cut (scatter maps, Castano 2010), so the area is what the crown covers from afar.
 */
const SPRAY_GROWTH: readonly (readonly [number, number])[] = [
  [1, 1],
  [1.17, 1.1],
  [2.3, 1.3],
];
const defaultRegions: readonly FirSprayRegion[] = /* @__PURE__ */ Object.freeze([[0, 0, 1, 1]] as const);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function buildSprays(
  height: number,
  crownBase: number,
  radius: number,
  seed: number,
  atlas: readonly FirSprayRegion[],
): Bough[][] {
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const layers: Bough[][] = [];
  for (let j = 0; j < 31; j++) {
    const fraction = j / 30;
    const y = mix(crownBase, height, fraction) + (random() - 0.5) * 0.24 * (height / 18.64);
    const crown =
      (radius / 3.29) * (0.21 + 3.08 * (1 - fraction) ** 0.88) * (0.8 + 0.2 * Math.sin(fraction * Math.PI + 0.62));
    const count = 5 + Math.round(3 * (1 - fraction));
    const phase = j * 2.399963 + random() * 0.37;
    const whorl = [];
    for (let i = 0; i < count; i++) {
      const yaw = phase + (i * Math.PI * 2) / count + (random() - 0.5) * 0.44;
      const radial = crown * mix(0.67, 1.16, random());
      const tipY = y + mix(-0.53, 0.24, random()) * (1 - fraction) * (height / 18.64);
      const roll = mix(-0.65, 0.65, random());
      const leaf = atlas[Math.floor(random() * atlas.length)];
      whorl.push({ yaw, y, radial, tipY, roll, leaf });
    }
    layers.push(whorl);
  }
  return layers;
}

function canopy(layers: readonly Bough[][], ring: number, atlas: readonly FirSprayRegion[]): GeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // Higher rings keep the same main boughs and use fewer planes per spray. The sprays they keep grow (SPRAY_GROWTH) so a
  // ring covers about the foliage area of the near one: dropped sprays left far crowns see-through, a bare grey stem
  // with a few cards on it from 700 m up (Above the Treeline look round 4).
  const divisions = ring === 0 ? 3 : 1;
  function spray(
    x: number,
    y: number,
    z: number,
    angle: number,
    length: number,
    width: number,
    endDrop: number,
    roll: number,
    rect: FirSprayRegion,
  ) {
    const first = positions.length / 3;
    const forwardX = Math.cos(angle);
    const forwardZ = Math.sin(angle);
    const sideX = -forwardZ * Math.cos(roll);
    const sideZ = forwardX * Math.cos(roll);
    const sideY = Math.sin(roll);
    const [u0, v0, u1, v1] = rect;
    const nx = forwardX * 0.32 + sideX * -sideY * 0.45;
    const nz = forwardZ * 0.32 + sideZ * -sideY * 0.45;
    const normalLength = Math.hypot(nx, 0.87, nz);
    for (let n = 0; n <= divisions; n++) {
      const t = n / divisions;
      const py = y + endDrop * t ** 1.28 + Math.sin(t * Math.PI) * length * 0.055;
      for (const wing of [-1, 1]) {
        positions.push(
          x + length * t * forwardX + (wing * sideX * width) / 2,
          py + (wing * sideY * width) / 2,
          z + length * t * forwardZ + (wing * sideZ * width) / 2,
        );
        normals.push(nx / normalLength, 0.87 / normalLength, nz / normalLength);
        uvs.push(wing < 0 ? u0 : u1, mix(v1, v0, t));
      }
    }
    for (let n = 0; n < divisions; n++) {
      const a = first + n * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  for (const [row, whorl] of layers.entries()) {
    if (ring === 2 && row < 27 && row % 2) continue;
    // Width and length of every spray in this row: the far ring's thinned rows grow the most, the crown tip it keeps
    // whole grows like the middle ring.
    const [wide, long] = SPRAY_GROWTH[ring === 2 && row >= 27 ? 1 : ring];
    for (const [i, b] of whorl.entries()) {
      const fx = Math.cos(b.yaw);
      const fz = Math.sin(b.yaw);
      const stem = b.radial * 0.12;
      spray(
        stem * fx,
        b.y,
        stem * fz,
        b.yaw,
        b.radial * long,
        b.radial * 0.62 * wide,
        (b.tipY - b.y) * long,
        b.roll,
        b.leaf,
      );
      if (ring === 2 && i % 2) continue;
      for (const side of [-1, 1]) {
        if (ring > 0 && side !== ((row + i) % 2 ? 1 : -1)) continue;
        const arm = b.radial * (side < 0 ? 0.48 : 0.57);
        spray(
          arm * fx,
          b.y + (b.tipY - b.y) * 0.46 + 0.014,
          arm * fz,
          b.yaw + side * 0.56,
          b.radial * 0.57 * long,
          b.radial * 0.43 * wide,
          -0.09 + (b.tipY - b.y) * 0.32,
          side * 0.7 - 0.31 * b.roll,
          atlas[(row + i + (side < 0 ? 1 : 2)) % atlas.length],
        );
      }
    }
  }
  return geometryData(positions, normals, uvs, indices);
}

/**
 * Near, middle and far foliage meshes from one seeded set of fir whorls. Pair them with a stem mesh and an alpha-cutout
 * spray atlas. The rings use the same heights and main branch directions. The first two draw all whorls, and the far
 * ring keeps alternating lower whorls and the full crown tip. The sprays the middle and far rings keep are wider and
 * longer, so each ring covers about the foliage area of the near one and a far crown stays dense rather than thinning
 * to a bare stem. Both faces of every spray have winding and UVs.
 *
 * @example
 * ```ts
 * import { generateFirSprayLevels } from '@margoengine/procedural/fir-sprays';
 * const [near, middle, far] = generateFirSprayLevels({height: 9, crownBase: 2.1, radius: 1.72});
 * console.log(near.indices.length > middle.indices.length && middle.indices.length > far.indices.length);
 * ```
 */
export function generateFirSprayLevels(
  options: FirSprayOptions = {},
): readonly [GeometryData, GeometryData, GeometryData] {
  if (!options || typeof options !== 'object') throw typeError('Fir spray options must be an object', 'procedural');
  const height = options.height ?? 18.64,
    crownBase = options.crownBase ?? (5.5 * height) / 18.64,
    radius = options.radius ?? (3.29 * height) / 18.64,
    seed = options.seed ?? 730956,
    regions = options.regions ?? defaultRegions;
  if (
    !Number.isFinite(height) ||
    height < 0.1 ||
    height > 250 ||
    !Number.isFinite(crownBase) ||
    crownBase < 0 ||
    crownBase > height * 0.95 ||
    !Number.isFinite(radius) ||
    radius < 0.01 ||
    radius > 100
  )
    throw rangeError(
      'Fir sprays need height 0.1..250, crown base 0..95% of height, and radius 0.01..100 metres',
      'procedural',
    );
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw rangeError('Fir spray seed must be a uint32', 'procedural');
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 64)
    throw rangeError('Provide one to 64 fir spray rectangles', 'procedural');
  for (const region of regions) {
    if (
      !Array.isArray(region) ||
      region.length !== 4 ||
      !region.every(Number.isFinite) ||
      region[0] < 0 ||
      region[1] < 0 ||
      region[2] > 1 ||
      region[3] > 1 ||
      region[0] >= region[2] ||
      region[1] >= region[3]
    )
      throw rangeError('Each fir spray region is an ordered [u0, v0, u1, v1] rectangle inside 0..1', 'procedural');
  }
  const layers = buildSprays(height, crownBase, radius, seed, regions);
  return [canopy(layers, 0, regions), canopy(layers, 1, regions), canopy(layers, 2, regions)];
}
