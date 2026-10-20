// Photo mode: the loaded world path-traced by @margoengine/voxel-pathtracer over the game's frame. Blocks keep their
// pixel-art textures (leaves see-through), water and glass refract, glowstone and torches give light, and the sky and
// the sun (or the moon) follow the clock. Each loaded chunk is one traced model in the chunk's own cell order, so an
// edit re-sends that chunk alone. Plants (crossed cards) are left out; a torch is a thin glowing stick.
import type { EngineKernel } from '@margoengine/core';
import { type BlockTypes, blockId, type VoxelChunk, type VoxelWorld } from '@margoengine/voxel';
import { sunDirection } from '@margoengine/sky/base';
import {
  type TraceEnvironment,
  type TraceInstance,
  type TraceMaterial,
  type TraceModel,
  VoxelPathTracer,
  type VoxelTraceScene,
} from '@margoengine/voxel-pathtracer';
import type { Pixels } from './textures.ts';

const CELLS = 32 * 32 * 32,
  REBUILD = 0.3, // seconds between scene updates while chunks change
  TORCH = 'torch-stick';

/** What {@link PhotoMode} needs from the game. */
export interface PhotoModeOptions {
  world: VoxelWorld;
  blocks: BlockTypes;
  /** The block texture layers (`BlockType.textures` index them). */
  images: readonly Pixels[];
  /** The loaded chunks by `cx,cy,cz`. */
  chunks: ReadonlyMap<string, VoxelChunk>;
  /** The clock's hours, 0-24. */
  hours(): number;
  /** The view distance in blocks (the world fades into the sky toward it). */
  distance(): number;
}

/** P toggles the path-traced view of the loaded world; {@link PhotoMode.save} renders a PNG of it. */
export class PhotoMode {
  #engine: EngineKernel;
  #options: PhotoModeOptions;
  #tracer: VoxelPathTracer | undefined;
  // Per block id: the traced palette index (0: left out) and whether it is a torch.
  #index = new Uint8Array(65536);
  #torch = new Uint8Array(65536);
  #materials: TraceMaterial[];
  #models = new Map<string, { revision: number; model?: TraceModel; torches: number[] }>();
  #dirty = new Set<string>();
  #rebuild = true;
  #wait = 0;
  #hours = Number.NaN;
  #revision = 0;
  #offChange: () => void;
  #offChunk: () => void;

  constructor(engine: EngineKernel, options: PhotoModeOptions) {
    this.#engine = engine;
    this.#options = options;
    this.#materials = materialsFor(options.blocks, options.images, this.#index, this.#torch);
    const key = (x: number, y: number, z: number) => `${x >> 5},${y >> 5},${z >> 5}`;
    this.#offChange = options.world.onChange((x, y, z) => this.#dirty.add(key(x, y, z)));
    this.#offChunk = options.world.onChunk((cx, cy, cz) => {
      this.#models.delete(`${cx},${cy},${cz}`);
      this.#rebuild = true;
    });
  }

  /** Whether the path-traced view is on. */
  get on(): boolean {
    return this.#tracer !== undefined;
  }

  /** Samples per pixel of the current image (0 while off or compiling). */
  get samples(): number {
    return this.#tracer?.stats.samples ?? 0;
  }

  /** Turns the path-traced view on or off; returns whether it is on. */
  toggle(): boolean {
    if (this.#tracer) {
      this.#tracer.dispose();
      this.#tracer = undefined;
      return false;
    }
    this.#rebuild = true;
    this.#tracer = VoxelPathTracer.attach(this.#engine, {
      scene: this.#scene(),
      denoise: 'auto',
      samplesPerFrame: 'auto',
      maxSamples: 4096,
      maxBounces: 6,
    });
    return true;
  }

  /** Renders the current camera's view as a PNG (`samples` per pixel, denoised) and offers it as a download. */
  async save(width: number, height: number, samples = 256): Promise<void> {
    if (!this.#tracer) return;
    const blob = await this.#tracer.capture({ width, height, samples, denoise: true }),
      link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `margo-voxel-photo-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  /** Per frame: sends changed chunks (at most every 0.3 s) and a new sky when the clock moved a quarter hour. */
  update(seconds: number): void {
    if (!this.#tracer) return;
    this.#wait -= seconds;
    const hours = this.#options.hours();
    if (Math.abs(hours - this.#hours) >= 0.25) this.#rebuild = true;
    if ((this.#rebuild || this.#dirty.size) && this.#wait <= 0) {
      this.#tracer.setScene(this.#scene());
      this.#wait = REBUILD;
    }
  }

  dispose(): void {
    this.#tracer?.dispose();
    this.#tracer = undefined;
    this.#offChange();
    this.#offChunk();
  }

  // The traced scene: one model per loaded chunk with traced blocks (rebuilt when it changed), torch sticks, the sky.
  #scene(): VoxelTraceScene {
    const models: TraceModel[] = [],
      instances: TraceInstance[] = [],
      sticks: number[] = [];
    for (const [key, chunk] of this.#options.chunks) {
      let entry = this.#models.get(key);
      if (!entry || this.#dirty.has(key)) {
        const torches: number[] = [],
          [cx, cy, cz] = key.split(',').map(Number),
          voxels = chunkVoxels(chunk, this.#index, this.#torch, [cx * 32, cy * 32, cz * 32], torches);
        entry = {
          revision: (entry?.revision ?? 0) + 1,
          model: voxels ? { id: key, revision: (entry?.revision ?? 0) + 1, size: [32, 32, 32], voxels } : undefined,
          torches,
        };
        this.#models.set(key, entry);
      }
      sticks.push(...entry.torches);
      if (!entry.model) continue;
      const [cx, cy, cz] = key.split(',').map(Number);
      models.push(entry.model);
      instances.push({
        id: key,
        modelId: key,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx * 32, cy * 32, cz * 32, 1],
      });
    }
    this.#dirty.clear();
    this.#rebuild = false;
    // A torch: a stick of one emissive voxel, 1/8 wide and 5/8 tall, standing on its cell's floor.
    const torchId = this.#torch.indexOf(1);
    if (sticks.length && torchId > 0) {
      models.push({ id: TORCH, revision: 1, size: [1, 1, 1], voxels: Uint8Array.of(this.#index[torchId]) });
      for (let i = 0; i < sticks.length; i += 3)
        instances.push({
          id: `torch ${sticks[i]},${sticks[i + 1]},${sticks[i + 2]}`,
          modelId: TORCH,
          matrix: [
            0.125,
            0,
            0,
            0,
            0,
            0.625,
            0,
            0,
            0,
            0,
            0.125,
            0,
            sticks[i] + 0.4375,
            sticks[i + 1],
            sticks[i + 2] + 0.4375,
            1,
          ],
        });
    }
    this.#hours = this.#options.hours();
    return {
      revision: ++this.#revision,
      models,
      instances,
      materials: this.#materials,
      textures: this.#options.images,
      environment: skyAt(this.#hours, this.#options.distance()),
    };
  }
}

// sRGB byte to linear.
const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// The traced material of each block type with a palette index (its id), and which types are left out (crossed cards)
// or are torches (crossed cards traced as sticks).
function materialsFor(
  blocks: BlockTypes,
  images: readonly Pixels[],
  index: Uint8Array,
  torch: Uint8Array,
): TraceMaterial[] {
  const out: TraceMaterial[] = [];
  for (const type of blocks.table) {
    if (type.id === 0 || type.id > 255 || type.layer === 'invisible') continue;
    if (type.shape === 'cross' && type.light === 0) continue;
    index[type.id] = type.id;
    if (type.shape === 'cross') torch[type.id] = 1;
    const texture = type.textures,
      color = type.color,
      roughness = type.roughness;
    if (type.light > 0) {
      // Glowstone and torches: lights glowing in their texture's mean colour (block light 15: 6 x it); a torch's stick
      // is plain (its texture is a crossed card).
      const glow = meanColor(images[texture[2]]).map((v, k) => v * color[k]) as [number, number, number];
      out.push({
        id: type.id,
        type: 'emit',
        color,
        ...(type.shape === 'cube' ? { texture } : {}),
        emission: (6 * type.light) / 15,
        emissionColor: glow,
      });
    } else if (type.liquid) {
      out.push({ id: type.id, type: 'glass', color, texture, ior: 1.33, roughness, density: 0.05 });
    } else if (type.layer === 'translucent') {
      out.push({ id: type.id, type: 'glass', color, texture, ior: 1.5, roughness });
    } else {
      out.push({
        id: type.id,
        type: type.metalness > 0 ? 'metal' : 'diffuse',
        color,
        texture,
        roughness,
        metalness: type.metalness,
        ...(type.layer === 'cutout' ? { cutout: 0.5 } : {}),
      });
    }
  }
  return out;
}

// Mean linear colour of a texture's opaque texels (weighted by alpha).
function meanColor(p: Pixels): number[] {
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < p.width * p.height; i++) {
    const a = p.data[4 * i + 3] / 255;
    for (let k = 0; k < 3; k++) sum[k] += a * linear(p.data[4 * i + k]);
    weight += a;
  }
  return sum.map((v) => v / Math.max(weight, 1e-6));
}

// A chunk as traced palette indices in its own cell order (x | z << 5 | y << 10 is the tracer's x + 32 (z + 32 y)),
// or undefined when nothing in it is traced; torch cells (world corners) go to `torches`.
function chunkVoxels(
  chunk: VoxelChunk,
  index: Uint8Array,
  torch: Uint8Array,
  origin: [number, number, number],
  torches: number[],
): Uint8Array | undefined {
  const { palette, bits, words } = chunk.pack(),
    traced = Uint8Array.from(palette, (state) => index[blockId(state)]),
    lit = Uint8Array.from(palette, (state) => torch[blockId(state)]);
  if (!traced.some((v) => v) && !lit.some((v) => v)) return undefined;
  const voxels = new Uint8Array(CELLS),
    mask = (1 << bits) - 1;
  let any = false;
  for (let i = 0; i < CELLS; i++) {
    const at = i * bits,
      slot = bits ? (words[at >>> 5] >>> (at & 31)) & mask : 0;
    if (lit[slot]) torches.push(origin[0] + (i & 31), origin[1] + (i >> 10), origin[2] + ((i >> 5) & 31));
    else if (traced[slot]) {
      voxels[i] = traced[slot];
      any = true;
    }
  }
  return any ? voxels : undefined;
}

// The sky at `hours`: Preetham's daylight and the sun by day; a dark blue sky and the moon (opposite the sun) by night.
// As the game's fog does, the world fades into the sky from 60% of the view distance, nearly gone (e^-4) at 95%.
function skyAt(hours: number, distance: number): TraceEnvironment {
  const sun = sunDirection(hours),
    fade = { groundFade: (0.35 * distance) / 4, groundFadeStart: 0.6 * distance, fadeModels: true };
  if (sun[1] > 0.02)
    return {
      physicalSky: { turbidity: 2.4, intensity: 0.08, horizonBelow: true },
      sunDirection: [sun[0], sun[1], sun[2]],
      sunIntensity: 3.2,
      sunColor: [1, 0.96, 0.9],
      ...fade,
    };
  return {
    skyColor: [0.02, 0.03, 0.06],
    sunDirection: [-sun[0], Math.max(0.02, -sun[1]), -sun[2]],
    sunIntensity: 0.22,
    sunColor: [0.45, 0.55, 0.85],
    ...fade,
  };
}
