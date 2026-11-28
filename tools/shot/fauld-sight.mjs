// What stands between a Fauld shot camera and its subject: the scene's own ground and planting on the CPU
// (`layFauldGround` of @margoengine/scenes, `BiomePlacement` of @margoengine/biomes), each placed tree and hedge shrub as
// the upright cylinders of its library model, for `sightClearance` of @margoengine/cameras. Reads the asset library.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BiomePlacement } from '../../packages/biomes/dist/placement.js';
import {
  FAULD_PLANT_MODELS,
  FAULD_SIZE,
  fauldDem,
  layFauldGround,
} from '../../packages/scenes/dist/fauld-countryside.js';
import { libraryMesh } from '../../packages/scenes/dist/library.js';
import { nearestRank } from '../../scripts/lib/percentile.mjs';

/** Plants are read this far from the lens at most, metres: farther ones are too small to cover a frame. */
const REACH = 600;
// A bare winter broadleaf crown lets most of a sight line through; the holly and the hedge shrubs mostly stop it.
const OPACITY = { oak: 0.35, ash: 0.3, birch: 0.3, holly: 0.85, hazel: 0.7, hawthorn: 0.7, blackthorn: 0.6 };
const SHRUBS = ['holly', 'hazel', 'hawthorn', 'blackthorn'];

/** The nearest-rank quantile (0 < q <= 1) of a radius set; an empty or non-finite set throws instead of giving undefined. */
const quantile = (values, q) => nearestRank(values, q * 100);

/**
 * A model's cylinders at scale 1, from its vertices: a tree's trunk (their spread 0.3 to 1.5 m up) and its crown (from
 * the lowest of twenty height bands that spreads past three trunks), or one cylinder for a shrub. Radii are quantiles,
 * so a stray twig does not widen the whole cylinder.
 */
export function plantCylinders(positions, opacity, shrub) {
  let height = 0;
  for (let i = 1; i < positions.length; i += 3) height = Math.max(height, positions[i]);
  const radii = (lo, hi) => {
    const out = [];
    for (let i = 0; i < positions.length; i += 3)
      if (positions[i + 1] >= lo && positions[i + 1] <= hi) out.push(Math.hypot(positions[i], positions[i + 2]));
    return out;
  };
  if (shrub) return [{ bottom: 0, top: height, radius: quantile(radii(0, height), 0.75), opacity }];
  const trunk = quantile(radii(0.3, 1.5), 0.9);
  let base = height * 0.5;
  for (let k = 1; k < 20; k++) {
    const band = radii((k / 20) * height, ((k + 1) / 20) * height);
    if (band.length && quantile(band, 0.9) > 3 * trunk) {
      base = (k / 20) * height;
      break;
    }
  }
  return [
    { bottom: 0, top: base, radius: trunk, opacity: 1 },
    { bottom: base, top: height, radius: quantile(radii(base, height), 0.75), opacity },
  ];
}

/** `fetch` for `file:` URLs, so the scene's model loader reads the library from disk. */
const files = async (url) => {
  const bytes = readFileSync(fileURLToPath(url));
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(bytes.toString('utf8')),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  };
};

/** The sight scenes of the Fauld place, one per era, from the asset library and the height grid. */
export function fauldSight({ library, dem: demPath }) {
  const meta = JSON.parse(readFileSync(demPath.replace(/\.f32$/, '.json'), 'utf8')),
    bytes = readFileSync(demPath),
    dem = fauldDem(meta, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4));
  const model = async (path) =>
    (
      await libraryMesh(pathToFileURL(`${library}/margo-library/fauld/${path}.gltf`).href, {
        kind: 'stone',
        color: [0.5, 0.5, 0.5],
        maxTriangles: 600000,
        fetch: files,
      })
    ).geometry.positions;
  let plants;
  const eras = new Map();
  const cylinders = async () => {
    const out = {};
    for (const [key, path] of Object.entries(FAULD_PLANT_MODELS))
      out[`library:${key}`] = plantCylinders(await model(path), OPACITY[key], SHRUBS.includes(key));
    return out;
  };
  const make = async (era) => {
    plants ??= await cylinders();
    const crater =
        era === 'before' ? undefined : { geometry: { positions: await model(`crater/crater_inner_${era}`) } },
      ground = await layFauldGround({ era, dem, ...(crater ? { crater } : {}) }),
      placement = BiomePlacement.attach(ground.world, { exclusions: ground.exclusions }),
      meshes = new Map(placement.species.map((s) => [s.key, s.mesh])),
      tiles = new Map();
    const tile = async (x, z) => {
      const key = x + z * ground.world.tilesX;
      let list = tiles.get(key);
      if (!list) {
        const placed = await placement.tile(x, z),
          heights = [];
        placed.forEachInstance((p) => {
          // Fallen logs lie below any sight line.
          const parts = plants[meshes.get(p.key)];
          if (parts && p.age !== 3) heights.push({ x: p.x, z: p.z, scale: p.scale, parts });
        });
        list = heights.flatMap(({ x: px, z: pz, scale, parts }) => {
          const y = ground.height(px, pz);
          return parts.map((c) => ({
            x: px,
            z: pz,
            bottom: y + c.bottom * scale,
            top: y + c.top * scale,
            radius: c.radius * scale,
            opacity: c.opacity,
          }));
        });
        tiles.set(key, list);
      }
      return list;
    };
    return {
      ground: ground.height,
      /** The placed plants within `radius` metres (at most 600) of `(x, z)`. */
      async near(x, z, radius = REACH) {
        const r = Math.min(radius, REACH) + 15,
          size = ground.world.tileSize,
          index = (v, n) => Math.max(0, Math.min(n - 1, Math.floor((v + FAULD_SIZE / 2) / size))),
          out = [];
        if (Math.abs(x) > FAULD_SIZE / 2 + r || Math.abs(z) > FAULD_SIZE / 2 + r) return out;
        for (let j = index(z - r, ground.world.tilesZ); j <= index(z + r, ground.world.tilesZ); j++)
          for (let i = index(x - r, ground.world.tilesX); i <= index(x + r, ground.world.tilesX); i++)
            for (const c of await tile(i, j)) if (Math.hypot(c.x - x, c.z - z) - c.radius < r) out.push(c);
        return out;
      },
    };
  };
  return (era) => {
    let pending = eras.get(era);
    if (!pending) eras.set(era, (pending = make(era)));
    return pending;
  };
}
