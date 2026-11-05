// The biome world worker (B7, built to dist/workers/biomes.js): a replica of the page's world, made from the same
// options and changed by the same calls in the same order, answering tile, placement and view jobs one at a time. The
// replica runs the package's own code, so its bytes are the page's bytes. Results go back as copies of the cached
// arrays (the replica keeps its own), transferred so the page never copies them again.
import { typeError } from '../../shared/errors.js';
import { type BiomeTile, BiomeWorld, type BiomeWorldOptions } from './world.js';
import { BiomePlacement, type PlacedTile, type PlacementOptions } from './placement.js';
import { canopyCorners, canopyCover, darkenTile } from './cover.js';
import { overviewRows, viewTile } from './view.js';

let world: BiomeWorld | undefined,
  /** Why the replica could not be made: every later job rejects with it. */
  broken: unknown;
const placements = new Map<number, BiomePlacement>();

type Message = { id: number; op: string } & Record<string, unknown>;

/** The classifier object for a name sent by the page ('envelopes', 'whittaker', 'holdridge' or { kind: 'multinoise', spec }). */
async function classifier(name: unknown): Promise<BiomeWorldOptions['classifier']> {
  if (name === undefined || name === 'envelopes') return name as undefined;
  if (typeof name === 'object') return (await import('./multinoise.js')).multiNoise((name as { spec: never }).spec);
  const zones = await import('./zones.js');
  return name === 'whittaker' ? zones.whittaker : zones.holdridge;
}

/** A tile's layers as plain data, each raster a copy (the replica keeps its cached arrays). */
function tileData(t: BiomeTile) {
  return {
    x: t.x,
    z: t.z,
    origin: t.origin,
    cells: t.cells,
    resolution: t.resolution,
    layers: t.layers.map((name) => {
      const l = t.layer(name)!;
      return { ...l, data: l.data.slice() };
    }),
  };
}

/** A placed tile as plain data, every array a copy; `split` adds its records grouped by palette index and age. */
function placedData(t: PlacedTile, split: boolean, every?: number) {
  const out = {
    x: t.x,
    z: t.z,
    origin: t.origin,
    size: t.size,
    instances: t.instances.slice(),
    count: t.count,
    species: t.species,
    canopy: { ...t.canopy, data: t.canopy.data.slice() },
    exclusion: { ...t.exclusion, data: t.exclusion.data.slice() },
    density: t.density.map((d) => ({ ...d, data: d.data.slice(), sampled: every ? sample(d.data, every) : undefined })),
    stats: { ...t.stats, rounds: t.stats.rounds.slice() },
    groups: undefined as { species: number; dead: boolean; records: Uint8Array }[] | undefined,
  };
  if (split) {
    // Living objects by palette index, dead standing trees and logs together (drawn as snags), in record order.
    const counts = new Map<number, number>();
    for (let k = 0; k < t.count; k++) {
      const key = t.instances[k * 8 + 7] >> 4 >= 2 ? -1 : t.instances[k * 8 + 4];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const groups = new Map<number, { species: number; dead: boolean; records: Uint8Array; n: number }>();
    for (const [key, n] of counts)
      groups.set(key, { species: Math.max(0, key), dead: key < 0, records: new Uint8Array(n * 8), n: 0 });
    for (let k = 0; k < t.count; k++) {
      const key = t.instances[k * 8 + 7] >> 4 >= 2 ? -1 : t.instances[k * 8 + 4],
        g = groups.get(key)!;
      g.records.set(t.instances.subarray(k * 8, k * 8 + 8), g.n++ * 8);
    }
    out.groups = [...groups.values()].map(({ species, dead, records }) => ({ species, dead, records }));
  }
  return out;
}

/** A square map every `every` cells, as a view's detail texture holds it. */
function sample(data: Uint8Array, every: number): { every: number; data: Uint8Array } {
  const cells = Math.round(Math.sqrt(data.length)),
    n = Math.ceil(cells / every), // float division: view only
    out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[j * n + i] = data[j * every * cells + i * every];
  return { every, data: out };
}

async function run(m: Message): Promise<unknown> {
  if (broken && m.op !== 'init') throw broken;
  switch (m.op) {
    case 'init': {
      const state = m.state as {
        options: BiomeWorldOptions & { classifier?: string };
        user: { name: string; x: number; z: number; data: Uint8Array }[];
        placements: { pid: number; options: PlacementOptions }[];
      };
      world?.dispose();
      broken = undefined;
      world = await BiomeWorld.create({
        ...state.options,
        classifier: await classifier(state.options.classifier),
        workers: false,
        cache: 36,
      });
      if (state.user.length) world.writeLayers(state.user);
      placements.clear();
      for (const p of state.placements) placements.set(p.pid, BiomePlacement.attach(world, p.options));
      return null;
    }
    case 'write':
      world!.writeLayers(m.writes as Parameters<BiomeWorld['writeLayers']>[0]);
      return null;
    case 'update': {
      const changes = { ...(m.changes as Record<string, unknown>) };
      if ('classifier' in changes) changes.classifier = await classifier(changes.classifier);
      // Carved heights need the splines entry, which the page loaded before it sent them.
      if (changes.height && typeof changes.height === 'object' && 'carve' in changes.height)
        await import('@margoengine/biomes/splines');
      world!.update(changes);
      return null;
    }
    case 'placement':
      placements.set(m.pid as number, BiomePlacement.attach(world!, m.options as PlacementOptions));
      return null;
    case 'placement-update':
      placements.get(m.pid as number)!.update(m.changes as Parameters<BiomePlacement['update']>[0]);
      return null;
    case 'placement-dispose':
      placements.get(m.pid as number)?.dispose();
      placements.delete(m.pid as number);
      return null;
    case 'tile':
      return tileData(await world!.tile(m.x as number, m.z as number, { layers: m.layers as string[] | undefined }));
    case 'place':
      return placedData(
        await placements
          .get(m.pid as number)!
          .tile(m.x as number, m.z as number, { ahead: m.ahead as [number, number][] }),
        !!m.split,
        m.detail as number | undefined,
      );
    case 'view': {
      // What a view draws of a tile: heights (metres) and the two ground weight textures every `step` cells. The tile is
      // asked for with the default layers (VIEW_LAYERS among them), so the view and placement of a tile, which go to
      // the same worker, share one cached tile instead of making it twice.
      const t = await world!.tile(m.x as number, m.z as number);
      const made = viewTile(world!, t, m.materials as string[], m.step as number);
      if (m.canopy) darkenTile(world!, made, m.step as number, m.materials as string[], m.canopy as number);
      return made;
    }
    case 'cover':
      return canopyCover(world!, m.step as number);
    case 'overview':
      // A band of texel rows of a view's far-field ground weights (from the region fields, never a cached tile).
      return overviewRows(
        world!,
        m.materials as string[],
        m.texel as number,
        m.v0 as number,
        m.v1 as number,
        m.canopy ? canopyCorners(world!, m.materials as string[], m.canopy as number) : undefined,
      );
    default:
      throw typeError('Unknown biome worker job; load the page and the worker script from one build', 'biomes');
  }
}

// One job at a time, in arrival order: the replica must see every change before the jobs sent after it.
let chain: Promise<void> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Message>) => {
  chain = chain.then(async () => {
    try {
      let result: unknown;
      try {
        result = await run(data);
      } catch (error) {
        if (data.op === 'init') broken = error;
        throw error;
      }
      const transfer: Transferable[] = [];
      collect(result, transfer);
      (self as unknown as Worker).postMessage({ id: data.id, result }, transfer);
    } catch (error) {
      const e = error as { name?: string; message?: string; code?: string };
      (self as unknown as Worker).postMessage({
        id: data.id,
        error: { name: e?.name ?? 'Error', message: e?.message ?? String(error), code: e?.code },
      });
    }
  });
};

/** The ArrayBuffers of a result, once each. */
function collect(value: unknown, out: Transferable[]): void {
  if (!value || typeof value !== 'object') return;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer);
    return;
  }
  for (const v of Object.values(value)) collect(v, out);
}
