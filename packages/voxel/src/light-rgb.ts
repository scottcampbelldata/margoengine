// @margoengine/voxel/light-rgb: coloured block light. Each emitter's `light` level is split into red, green and blue
// levels by its colour, and each channel floods like `VoxelLighting`'s block light (the same costs, slabs and stairs),
// in three copies of the world's blocks, one per channel. The levels of the cells around the camera go into a 3D
// texture (wrapping, so moving the camera uploads only the chunks that come into range); a `VoxelRenderer` lighting
// effect samples it per pixel, smoothly over the open cells, and adds the coloured light with the renderer's own
// level-to-brightness curve.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { type BlockType, BlockTypes } from './blocks.js';
import { VoxelChunk } from './chunk.js';
import { VoxelLighting } from './light.js';
import { chunkKey, VoxelWorld } from './world.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of {@link VoxelColorLight.attach}. */
export interface VoxelColorLightOptions {
  /** The world whose emitters light it. */
  world: VoxelWorld;
  /**
   * Light colour per block type name, linear RGB 0..1: the channels' levels are the type's `light` times each
   * channel, rounded. Types not named give white light (all three channels at `light`). Live: set a colour and the
   * light floods again.
   */
  colors?: Readonly<Record<string, Vec3>>;
  /** Cells flooded per {@link VoxelColorLight.update} per channel, as `VoxelLighting`'s budget. Default 4096. */
  budget?: number;
  /** Size in blocks of the lit box kept on the GPU around the camera: multiples of 32. Default [128, 64, 128]. */
  extent?: readonly [number, number, number];
  /** Scale of the coloured light. Live. Default 1. */
  strength?: number;
}

const BINDING = 40;
const DECLARATIONS = (group: number) => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var voxelRgbVolume:texture_3d<f32>;
@group(${group}) @binding(${BINDING + 1}) var voxelRgbSampler:sampler;
@group(${group}) @binding(${BINDING + 2}) var<uniform> voxelRgbWindow:vec4f;
// Coloured block light at p on a face with normal n: the levels of the open cells around the point half a cell in front
// (one trilinear fetch of level x open and open, divided), turned to brightness by the renderer's curve (equal CIE L*
// steps), times the surface colour.
fn voxelRgbLight(p:vec3f,n:vec3f,base:vec3f)->vec3f {
 let size=vec3f(textureDimensions(voxelRgbVolume));let q=p+n*0.5;let l=q-voxelRgbWindow.xyz;
 if(any(l<vec3f(0.5))||any(l>size-vec3f(0.5))){return vec3f(0.0);}
 let t=textureSampleLevel(voxelRgbVolume,voxelRgbSampler,q/size,0.0);
 if(t.a<0.002){return vec3f(0.0);}
 let lightness=clamp(t.rgb/t.a,vec3f(0.0),vec3f(1.0))*100.0;let cube=(lightness+16.0)/116.0;
 return base*select(lightness*(27.0/24389.0),cube*cube*cube,lightness>vec3f(8.0))*voxelRgbWindow.w;
}`;

interface Gpu {
  device: GPUDevice;
  texture: GPUTexture;
  sampler: GPUSampler;
  window: GPUBuffer;
  entries: GPUBindGroupEntry[];
}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && c >= 0 && c <= 1);

/**
 * Coloured block light for a block world: red lava, blue lamps, green crystals. Attach it with the engine, add it to
 * the world's `VoxelRenderer` with {@link VoxelColorLight.add}, call {@link VoxelColorLight.update} every frame, and set
 * the renderer's `blockLightColor` to `[0, 0, 0]` so its single-channel block light does not add on top.
 */
export class VoxelColorLight {
  readonly world: VoxelWorld;
  /** The engine whose device holds the light volume (a renderer of another engine refuses it). */
  readonly owner: EngineKernel;
  /** Scale of the coloured light. Live. */
  strength: number;
  #colors = new Map<string, Vec3>();
  #channels: { blocks: BlockTypes; world: VoxelWorld; lighting: VoxelLighting }[];
  #off: (() => void)[];
  #extent: [number, number, number];
  #origin: [number, number, number] | undefined; // window corner, in chunks
  #upload = new Set<string>();
  #gpu?: Gpu;
  #hooks = new Map<number, { declarations: string; light: string }>();
  #disposed = false;

  /**
   * @throws TypeError for a wrong engine, world or option type; RangeError for options out of range.
   */
  static attach(engine: EngineKernel, options: VoxelColorLightOptions): VoxelColorLight {
    return new VoxelColorLight(engine, options);
  }

  private constructor(engine: EngineKernel, options: VoxelColorLightOptions) {
    if (!engine || typeof engine !== 'object') throw new TypeError('VoxelColorLight.attach expects (engine, {world})');
    if (!options || !(options.world instanceof VoxelWorld))
      throw new TypeError('VoxelColorLight world must be a VoxelWorld; pass {world}');
    const { world, colors = {}, budget = 4096, extent = [128, 64, 128], strength = 1 } = options;
    if (
      !Array.isArray(extent) ||
      extent.length !== 3 ||
      !extent.every((e) => Number.isInteger(e) && e >= 32 && e <= 1024 && e % 32 === 0)
    )
      throw new RangeError(`VoxelColorLight extent ${extent} must be three multiples of 32 from 32 to 1024`);
    if (!colors || typeof colors !== 'object') throw new TypeError('VoxelColorLight colors must be {name: [r, g, b]}');
    for (const [name, color] of Object.entries(colors)) {
      if (!isVec3(color)) throw new RangeError(`VoxelColorLight color of "${name}" must be [r, g, b] in 0..1`);
      this.#colors.set(name, [color[0], color[1], color[2]]);
    }
    this.strength = strength;
    this.owner = engine;
    this.world = world;
    this.#extent = [extent[0], extent[1], extent[2]];
    this.#channels = [0, 1, 2].map(() => {
      const blocks = new BlockTypes(),
        copy = new VoxelWorld({ blocks, minY: world.minY, maxY: world.maxY });
      return { blocks, world: copy, lighting: VoxelLighting.attach(copy, { budget }) };
    });
    this.#define();
    this.#off = [
      world.onChunk((cx, cy, cz, chunk) => {
        for (const c of this.#channels) {
          if (c.world.getChunk(cx, cy, cz)) c.world.removeChunk(cx, cy, cz);
          if (chunk) c.world.addChunk(cx, cy, cz, VoxelChunk.unpack({ ...chunk.pack(), light: 0 }));
        }
        this.#upload.add(chunkKey(cx, cy, cz));
      }),
      world.onChange((x, y, z, state) => {
        if (this.world.blocks.table.length !== this.#channels[0].blocks.table.length) this.#define();
        for (const c of this.#channels) c.world.setBlock(x, y, z, state);
      }),
    ];
  }

  // The world's block types in each channel copy, in id order, emitting their channel of `light`.
  #define(): void {
    const table = this.world.blocks.table;
    this.#channels.forEach((c, channel) => {
      for (let id = c.blocks.table.length; id < table.length; id++) {
        const t = table[id];
        c.blocks.define(t.name, {
          layer: t.layer,
          shape: t.shape,
          solid: t.solid,
          liquid: t.liquid,
          light: this.#emits(t, channel),
          opacity: t.opacity,
          ...(t.waterlog ? { waterlog: t.waterlog } : {}),
        });
      }
    });
  }

  #emits(t: BlockType, channel: number): number {
    return Math.round(t.light * (this.#colors.get(t.name)?.[channel] ?? 1));
  }

  /**
   * The light colour of a block type (by name). Setting one re-lights its emitters: their cells change level in each
   * channel copy and flood again over the next updates.
   * @throws RangeError for a colour outside 0..1 or a type that is not defined.
   */
  setColor(name: string, color: Vec3): void {
    if (!isVec3(color)) throw new RangeError(`VoxelColorLight color of "${name}" must be [r, g, b] in 0..1`);
    const type = this.world.blocks.table.find((t) => t.name === name);
    if (!type) throw new RangeError(`VoxelColorLight block "${name}" is not defined; define it with blocks.define()`);
    this.#colors.set(name, [color[0], color[1], color[2]]);
    // A channel's types are fixed once defined: swap in a fresh copy of each, lit from scratch.
    const budget = this.#channels[0].lighting.budget;
    for (const c of this.#channels) c.lighting.dispose();
    const chunks: [number, number, number, VoxelChunk][] = [];
    this.world.onChunk((cx, cy, cz, chunk) => {
      if (chunk) chunks.push([cx, cy, cz, chunk]);
    })();
    this.#channels = [0, 1, 2].map(() => {
      const blocks = new BlockTypes(),
        copy = new VoxelWorld({ blocks, minY: this.world.minY, maxY: this.world.maxY });
      return { blocks, world: copy, lighting: VoxelLighting.attach(copy, { budget }) };
    });
    this.#define();
    for (const [cx, cy, cz, chunk] of chunks)
      for (const c of this.#channels) c.world.addChunk(cx, cy, cz, VoxelChunk.unpack({ ...chunk.pack(), light: 0 }));
  }

  /** Red, green and blue block light levels (0..15) of a cell, as flooded so far. */
  levels(x: number, y: number, z: number): [number, number, number] {
    return this.#channels.map((c) => c.lighting.blockLight(x, y, z)) as [number, number, number];
  }

  /**
   * Floods each channel up to `budget` cells, follows the camera and uploads the chunks whose light changed or that came
   * into range. Call it once a frame. Returns the cells flooded.
   * @throws MargoError `disposed` after `dispose()`.
   */
  update(): number {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelColorLight is disposed; attach a new one');
    if (this.world.blocks.table.length !== this.#channels[0].blocks.table.length) this.#define();
    let cells = 0;
    for (const c of this.#channels) {
      cells += c.lighting.update();
      for (const key of c.world.dirty) this.#upload.add(key);
      c.world.dirty.clear();
    }
    const device = engineRuntime(this.owner as never).gpu as GPUDevice | undefined;
    if (device) this.#sync(device);
    return cells;
  }

  #sync(device: GPUDevice): void {
    const [X, Y, Z] = this.#extent;
    let gpu = this.#gpu;
    if (!gpu || gpu.device !== device) {
      gpu?.texture.destroy();
      gpu?.window.destroy();
      const texture = device.createTexture({
          size: [X, Y, Z],
          dimension: '3d',
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          label: 'voxel coloured light',
        }),
        sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'repeat',
          addressModeV: 'repeat',
          addressModeW: 'repeat',
        }),
        window = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = this.#gpu = {
        device,
        texture,
        sampler,
        window,
        entries: [
          { binding: BINDING, resource: texture.createView() },
          { binding: BINDING + 1, resource: sampler },
          { binding: BINDING + 2, resource: { buffer: window } },
        ],
      };
      this.#origin = undefined;
    }
    // The window: the chunks around the camera's chunk; chunks newly in it are uploaded.
    const eye = (this.owner as unknown as { camera: { position: ArrayLike<number> } }).camera.position,
      origin: [number, number, number] = [
        Math.floor(eye[0] / 32) - (X >> 6),
        Math.floor(eye[1] / 32) - (Y >> 6),
        Math.floor(eye[2] / 32) - (Z >> 6),
      ],
      was = this.#origin,
      inside = (o: number[], cx: number, cy: number, cz: number) =>
        cx >= o[0] && cy >= o[1] && cz >= o[2] && cx < o[0] + X / 32 && cy < o[1] + Y / 32 && cz < o[2] + Z / 32;
    if (!was || was.some((v, i) => v !== origin[i])) {
      for (let cz = origin[2]; cz < origin[2] + Z / 32; cz++)
        for (let cy = origin[1]; cy < origin[1] + Y / 32; cy++)
          for (let cx = origin[0]; cx < origin[0] + X / 32; cx++)
            if (!was || !inside(was, cx, cy, cz)) this.#upload.add(chunkKey(cx, cy, cz));
      this.#origin = origin;
    }
    device.queue.writeBuffer(
      gpu.window,
      0,
      Float32Array.of(origin[0] * 32, origin[1] * 32, origin[2] * 32, this.strength),
    );
    const data = new Uint8Array(32 * 32 * 32 * 4),
      table = this.world.blocks.table;
    for (const key of this.#upload) {
      const [cx, cy, cz] = key.split(',').map(Number);
      if (!inside(origin, cx, cy, cz)) continue;
      const chunk = this.world.getChunk(cx, cy, cz),
        r = this.#channels[0].world.getChunk(cx, cy, cz),
        g = this.#channels[1].world.getChunk(cx, cy, cz),
        b = this.#channels[2].world.getChunk(cx, cy, cz);
      data.fill(0);
      if (chunk && r && g && b)
        for (let y = 0, o = 0; y < 32; y++)
          for (let z = 0; z < 32; z++)
            for (let x = 0; x < 32; x++, o += 4) {
              const type = table[chunk.get(x, y, z) & 0xffff],
                open = !type || type.layer !== 'opaque' || type.shape !== 'cube';
              if (!open) continue;
              data[o] = (r.getLight(x, y, z) & 15) * 17;
              data[o + 1] = (g.getLight(x, y, z) & 15) * 17;
              data[o + 2] = (b.getLight(x, y, z) & 15) * 17;
              data[o + 3] = 255;
            }
      // Texture rows run along x, images along z: reorder the y-major loop above into that layout.
      const texel = new Uint8Array(data.length);
      for (let y = 0; y < 32; y++)
        for (let z = 0; z < 32; z++)
          texel.set(data.subarray((y * 32 + z) * 128, (y * 32 + z + 1) * 128), (z * 32 + y) * 128);
      device.queue.writeTexture(
        {
          texture: gpu.texture,
          origin: [(((cx * 32) % X) + X) % X, (((cy * 32) % Y) + Y) % Y, (((cz * 32) % Z) + Z) % Z],
        },
        texel,
        { bytesPerRow: 128, rowsPerImage: 32 },
        [32, 32, 32],
      );
    }
    this.#upload.clear();
  }

  /** Adds the light to a `VoxelRenderer` (its `addLighting`). Returns the remover. */
  add(voxels: { addLighting(effect: VoxelColorLight): () => void }): () => void {
    return voxels.addLighting(this);
  }

  /** The renderer's lighting hooks: the coloured light term. Undefined until the first `update()` made the volume. */
  pbr(group: number): { declarations: string; light: string } | undefined {
    if (!this.#gpu || this.#disposed) return undefined;
    let hook = this.#hooks.get(group);
    if (!hook) {
      hook = { declarations: DECLARATIONS(group), light: 'voxelRgbLight(i.position,s.n,s.base.rgb)' };
      this.#hooks.set(group, hook);
    }
    return hook;
  }

  /** Bind group entries of the hooks: the volume, its sampler and the window. */
  bindings(): GPUBindGroupEntry[] {
    return this.#gpu?.entries ?? [];
  }

  /** Stops following the world and frees the volume. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#off) off();
    for (const c of this.#channels) c.lighting.dispose();
    this.#gpu?.texture.destroy();
    this.#gpu?.window.destroy();
    this.#gpu = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
