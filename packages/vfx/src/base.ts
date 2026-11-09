/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import { viewMatrix } from '../../shared/view.js';
import { preset } from '../../shared/preset.js';
import { simulationShader, billboardShader, multisampled, foggedBillboard, transparentBillboard } from './shader.js';
import { checkFog, FOG_BYTES, writeFog, type FogLike } from '../../shared/fog.js';
export type { FogLike } from '../../shared/fog.js';
import { applyView } from '../../shared/view-rect.js';
import { loadCompatRoute } from '../../shared/compat.js';
import { surfacePass, transparencySlot, type SurfaceTransparency } from '../../shared/pass.js';
declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  INDIRECT: number;
  COPY_DST: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const defaultPosition: Vec3 = [0, 1, 0],
  defaultVelocity: Vec3 = [0, 3, 0],
  defaultGravity: Vec3 = [0, -9.81, 0],
  defaultColor: readonly [number, number, number, number] = [1, 0.5, 0.1, 1],
  defaultLife: readonly [number, number] = [1, 3];
/**
 * Particle emitter settings. Everything except `capacity` and the four feature options (`obstacles`, `wrap`, `sort`,
 * `texture`) may change between frames; validation runs before GPU commands and throws RangeError when a value is out
 * of range.
 */
export interface VFXOptions {
  /** Particle slots, an integer 1-1,000,000 (64 bytes each). Fixed at construction. Default 1,000,000 (or the quality preset's). */
  capacity?: number;
  /** Births queued on attach and after device restoration, an integer 0..capacity. Default 0. */
  initialCount?: number;
  /** Births per second, >= 0. Default capacity / 2. */
  rate?: number;
  /** Emitter centre in world units. Default [0, 1, 0]. */
  position?: Vec3;
  /** Initial velocity in world units per second. Default [0, 3, 0]. */
  velocity?: Vec3;
  /** Random velocity added at birth, world units per second, >= 0. Default 1. */
  spread?: number;
  /** Acceleration in world units per second squared. Default [0, -9.81, 0]. */
  gravity?: Vec3;
  /** Linear RGBA at birth, each 0..1; alpha fades out over the life. Default [1, 0.5, 0.1, 1]. */
  color?: readonly [number, number, number, number];
  /** Billboard diameter in world units, > 0 (ground and obstacle collisions use half of it). Default 0.1. */
  size?: number;
  /** Random life [min, max] in seconds, 0 < min <= max. Default [1, 3]. */
  lifetime?: readonly [number, number];
  /** Height (world y) of the collision plane. Default 0. */
  ground?: number;
  /** Fraction of speed kept when bouncing off the ground or an obstacle, 0..1. Default 0.3. */
  bounce?: number;
  /** Curl-noise acceleration strength, >= 0 (0 turns it off). Default 0.5. */
  turbulence?: number;
  /** Spatial frequency of the curl field, per world unit, >= 0. Default 1. */
  frequency?: number;
  /** Billboard spin in radians per second (each particle gets a random birth angle). Default 0. */
  angularVelocity?: number;
  /** Half extents of the box births are spread over, around `position`, each >= 0. Default [0, 0, 0] (a point). */
  emissionExtent?: Vec3;
  /** RGB multiplier for HDR emission, 0-16. Default 1. */
  intensity?: number;
  /** Up to 64 spheres/boxes that the flow bends around and particles bounce off. Contents are read each frame; pass an array (even `[]`) before attaching. */
  obstacles?: readonly VFXObstacle[];
  /** Keep particles inside the emission box, re-entering on the opposite face (every extent must be > 0). Read at attach. */
  wrap?: boolean;
  /** Draw back to front: bitonic sort of the live list each frame. Read at attach. */
  sort?: boolean;
  /**
   * Fade distance in world units, >= 0: a particle fades out over this distance in front of any opaque surface behind it
   * (measured along the view axis), so it no longer shows a hard line where it meets the floor or a wall. Needs the `soft`
   * feature and `depth`; changeable between frames. Default 0 (off: no extra shader code, bindings or per-frame work).
   */
  softness?: number;
  /**
   * Scene depth for `softness`: a function returning a sampleable depth texture (reversed Z: 1 at the near plane, 0 where
   * nothing is drawn; 1 sample or the scene's sample count) the size of the drawing buffer, or undefined before it
   * exists. For example `() => depth.texture` with `DepthTexture` from `@margoengine/post/depth`. Throws `MargoError`
   * `'state'` at draw time when it returns undefined while `softness` is on.
   */
  depth?: () => GPUTexture | undefined;
  /** RGBA8 sRGB sprite (or atlas of frames) multiplied by the particle colour, instead of the soft disc. Read at construction. */
  texture?: VFXTexture;
  /** Size, opacity and colour over each particle's life. Which curves are set is read at attach; their values are read each frame. Needs the `curves` feature. */
  curves?: VFXCurves;
  /** Where births start and which way `speed` pushes them: a sphere, a cone or the surface of a triangle mesh. The shape (and a mesh) is read at attach; the numbers each frame. Needs the `emitter` feature. */
  emitter?: VFXEmitter;
  /** A ribbon behind each particle through its last positions, for smoke and magic trails. Needs `ribbons` from `@margoengine/vfx/ribbons`. */
  ribbons?: VFXRibbons;
  /** Draw each particle as a small lit triangle mesh instead of a billboard. Needs `mesh` from `@margoengine/vfx/mesh`. */
  mesh?: VFXMeshParticles;
  /** Sub-emitters: particles born on the GPU where a particle dies or hits the ground. Needs `events` from `@margoengine/vfx/events`. */
  events?: VFXEvents;
  /** Billboards lit by the sun, clustered point and spot lights and sun shadows, as round particles. Needs `lit` from `@margoengine/vfx/lit`. */
  lit?: VFXLit;
  /** Particles bounce off whatever was drawn last frame, from the scene `depth`. Needs `depthCollide` from `@margoengine/vfx/depth-collide`. */
  depthCollide?: VFXDepthCollide;
  /** Billboards stretched along their motion on screen, for sparks, rain and tracers. Needs `stretch` from `@margoengine/vfx/stretch`. */
  stretch?: VFXStretch;
  /** Point attractors and a 3D vector field added to each particle's acceleration. Needs `fields` from `@margoengine/vfx/fields`. */
  fields?: VFXFields;
  /** Births on the surface of an animated (skinned or morphed) mesh, following its pose. Needs `skinned` from `@margoengine/vfx/skinned`. */
  skinned?: VFXSkinned;
  /** Blend each lifetime atlas frame into the next. Needs `flipbook` from `@margoengine/vfx/flipbook` and a texture atlas whose frames are `'lifetime'`. */
  flipbook?: VFXFlipbook;
  /** Particles cast sphere shadows and the first live slots emit point lights. Needs `shadows` from `@margoengine/vfx/shadows`. */
  shadows?: VFXShadows;
}
/**
 * What the skinned emitter reads of a primitive: an entry of `model.primitives` from `@margoengine/gltf-pro`, with a
 * deformer such as `Animation` from `@margoengine/animation` attached.
 */
export interface VFXSkinnedPrimitive {
  /** The bind pose, 20 floats a vertex, position first. Read at attach. */
  readonly vertices: Float32Array;
  /** Triangles, three vertex indices each. Read at attach. */
  readonly indices: ArrayLike<number>;
  /** The buffer the deformer writes the posed vertices to (80 bytes each). Read every frame; until set, the bind pose. */
  readonly deformed?: GPUBuffer;
  /** Bytes before the primitive's first vertex in `deformed`. Default 0. */
  readonly deformedOffset?: number;
}
/**
 * Births on an animated mesh: each birth picks a triangle by its bind-pose area (so a stretched limb does not emit
 * more) and a uniform point of it in this frame's pose, placed by `transform` (the emitter's `position` is not used; `emissionExtent` still jitters it), and flies along
 * the posed face's normal times `speed` on top of `velocity` and `spread`. Not with `emitter`. Needs the `skinned` feature.
 */
export interface VFXSkinned {
  primitive: VFXSkinnedPrimitive;
  /** The mesh's world matrix, 16 numbers column-major (the node's world transform). Read every frame. Default identity. */
  transform?: ArrayLike<number>;
  /** World units per second along the posed face normal, -1000..1000 (negative flies inward). Default 0. */
  speed?: number;
}
/**
 * Blend successive frames of a lifetime atlas: the vertex stage passes this frame, the next (the last frame holds)
 * and the fraction between them, and the fragment stage samples both cells and mixes. Pass `{}`. Needs a `texture`
 * whose atlas frames are `'lifetime'`, and the `flipbook` feature.
 */
export interface VFXFlipbook {}
/** One point light packed from a live particle. `decay` is 2, the windowed inverse-square term. */
export interface VFXParticleLight {
  position: [number, number, number];
  /** World units, not scaled by the particle's size. */
  range: number;
  color: [number, number, number];
  intensity: number;
  decay: 2;
}
/**
 * Particles cast sun shadows into `cast` and the first live slots emit point lights into `into`. `count`, `range` and
 * `intensity` are read every frame; `cast` and `into` are fixed at attach. The feature sets `buffer`.
 */
export interface VFXShadows {
  /** How many of the first live slots, in slot order, become lights. A whole number from 0 to 64. Default 8. */
  count?: number;
  /** Light range in world units, finite and above 0. Default 4. */
  range?: number;
  /** Light intensity, finite and 0 or more. Default 1. */
  intensity?: number;
  /** A `Shadows` from `@margoengine/shadows`, or anything with `add`. Fixed at attach. */
  cast?: {
    add(source: { drawShadow(ctx: unknown): void; disposed?: boolean }, options?: { static?: boolean }): () => void;
  };
  /** A `Clustered` from `@margoengine/clustered`, or anything with `setLights`. Fixed at attach. */
  into?: { setLights(lights: readonly VFXParticleLight[]): void };
  /** The light list on the GPU (a header, then up to 64 lights). Set by the feature at attach. */
  buffer?: GPUBuffer;
}
/** A point that pulls particles towards it (or pushes them away with a negative strength). */
export interface VFXAttractor {
  position: Vec3;
  /** Pull in world units^3 per second^2: the acceleration is strength x d / (|d|^2 + radius^2)^1.5; negative pushes. */
  strength: number;
  /** Softening radius in world units, > 0, so the pull stays finite at the centre. Default 0.5. */
  radius?: number;
}
/** A 3D vector field over a box: one acceleration vector per cell, at the cell centres, trilinear between them. */
export interface VFXVectorField {
  /** Cells along x, y and z, whole numbers >= 1, at most 2,097,152 in all. */
  size: Vec3;
  /** Vectors x, y, z per cell, x fastest then y then z. Copied at attach. */
  data: Float32Array;
  /** The box centre in world units. Default [0, 0, 0]. */
  center?: Vec3;
  /** Half the box size on each axis, > 0. */
  halfSize: Vec3;
  /** Scale on the field's vectors. Default 1. */
  strength?: number;
}
/**
 * Force fields: up to 16 attractors and one vector field (zero outside its box, the edge cells' value between the outer
 * cell centres and the box edge) added to each particle's acceleration, with gravity and turbulence. Attractors, the
 * box and the strengths are read every frame; whether there is a field, and its cells, are fixed at attach. Needs the
 * `fields` feature.
 */
export interface VFXFields {
  attractors?: readonly VFXAttractor[];
  field?: VFXVectorField;
}
/**
 * Velocity-stretched billboards: each billboard's long axis follows the particle's velocity across the screen and it
 * is `size + factor x speed` long (never shorter than `size`), `size` across. A particle with no motion across the
 * screen stays round; spin is ignored. Read every frame. Needs the `stretch` feature.
 */
export interface VFXStretch {
  /** Seconds of travel the streak is long, 0..10. Default 0.05. */
  factor?: number;
}
/**
 * Collisions with the scene depth: each frame, before the simulation, a particle on last frame's draw list that meets
 * the surface drawn under it last frame (within `thickness` behind it, or less than its radius in front) has its
 * velocity into the surface reflected and scaled by the effect's `bounce`, and moves out to a radius in front. Needs
 * the `depth` option (the scene depth, as for `softness`) and the `depthCollide` feature.
 */
export interface VFXDepthCollide {
  /** How far behind a surface, in world units, a particle still counts as touching it (and not as hidden behind it), > 0. Default 0.5. */
  thickness?: number;
}
/**
 * Where lit particles get their light from: `Clustered` from `@margoengine/clustered` or `Shadows` from
 * `@margoengine/shadows` (or anything with their `pbr` and `bindings`), attached to the same engine.
 */
export interface VFXLightSource {
  pbr(group: number): { readonly declarations: string };
  bindings(): GPUBindGroupEntry[];
}
/**
 * Lighting for the billboards: each one is shaded as a ball (its normal from where the pixel lies on the disc) in its
 * own colour, by the engine's sun with wrap lighting, the ambient light, and optionally clustered lights and sun
 * shadows. `lights` and `shadows` are read at attach; `wrap` and `ambient` every frame (change them on the same
 * object). Needs the `lit` feature.
 */
export interface VFXLit {
  /** Point and spot lights: `Clustered` from `@margoengine/clustered`. Fixed at attach. */
  lights?: VFXLightSource;
  /** Sun shadows on the particles: `Shadows` from `@margoengine/shadows`. Fixed at attach. */
  shadows?: VFXLightSource;
  /** How far the sun wraps round the dark side, 0 (a hard ball) to 1 (dark only at the far pole). Default 0.5. */
  wrap?: number;
  /** Ambient light, linear RGB, each 0..16. Default the engine's: `lighting.radiance[3]` times `lighting.ambient`. */
  ambient?: readonly [number, number, number];
}
/**
 * Sub-emitters: a particle that dies (`on: 'death'`), or meets the ground faster than `speed` (`on: 'collision'`),
 * raises an event on the GPU, and in the next frame `count` particles are born where it was into free slots of the same
 * effect, with their own life, size, velocity and colour. Children never raise events. `on` is read at attach, the rest
 * every frame. Needs the `events` feature.
 */
export interface VFXEvents {
  on: 'death' | 'collision';
  /** Particles born per event, an integer 1..64. Default 8. */
  count?: number;
  /** Random life [min, max] of the children in seconds, 0 < min <= max. Default [0.5, 1]. */
  lifetime?: readonly [number, number];
  /** The children's billboard diameter in world units, > 0. Default 0.05. */
  size?: number;
  /** The children's velocity in world units per second, added to `inherit` times the parent's. Default [0, 0, 0]. */
  velocity?: Vec3;
  /** Random velocity added to each child, world units per second, >= 0. Default 1. */
  spread?: number;
  /** Fraction of the parent's velocity (at its death or impact) the children start with, -10..10. Default 0. */
  inherit?: number;
  /** With `on: 'collision'`, the slowest impact (world units per second towards the ground) that raises an event, >= 0. Default 0.5. */
  speed?: number;
  /** The children's linear RGBA at birth, each 0..1, times `intensity`; alpha fades over their life. Default [1, 1, 1, 1]. */
  color?: readonly [number, number, number, number];
}
/**
 * A mesh drawn for every particle in place of its billboard, opaque and depth written, scaled so its farthest vertex from
 * the mesh origin is half the particle `size` away, in the particle colour lit by one directional light. The geometry and
 * `align` are read at attach; `light`, `lightColor` and `ambient` every frame (change them on the same object). Needs the
 * `mesh` feature.
 */
export interface VFXMeshParticles {
  /** Vertex positions as xyz triples around the mesh origin, finite, not all at the origin. */
  positions: ArrayLike<number>;
  /** Triangle corner indices, a multiple of 3 (1 to 65,536 triangles), counter-clockwise from outside; omit when `positions` is a triangle list. */
  indices?: ArrayLike<number>;
  /** One xyz normal per vertex; omitted, each triangle uses its face normal (flat shading). */
  normals?: ArrayLike<number>;
  /** `'random'`: each particle tumbles about its own random axis by its spin (`angularVelocity`); `'velocity'`: the mesh's +y follows the particle's motion and the spin turns it about that line. Default `'random'`. */
  align?: 'random' | 'velocity';
  /** Direction towards the light in world space, not zero. Default [0.4, 1, 0.3]. */
  light?: readonly [number, number, number];
  /** Linear RGB of the light, each 0..16. Default [1, 1, 1]. */
  lightColor?: readonly [number, number, number];
  /** Light that reaches faces turned away, 0..1. Default 0.35. */
  ambient?: number;
}
/**
 * A ribbon behind each particle: a camera-facing strip through the particle and its last `points - 1` recorded
 * positions, fading from the particle's own opacity at the head to 0 at the tail. `points` is read at attach; the rest
 * every frame. Needs the `ribbons` feature.
 */
export interface VFXRibbons {
  /** Points along the ribbon, the particle included, an integer 2..64. Default 16. Fixed at attach. */
  points?: number;
  /** Seconds between recorded points, 0..1; 0 records one every frame. Default 1/60. */
  interval?: number;
  /** Width in world units, > 0. Default the particle `size`. */
  width?: number;
  /** Draw the particles' billboards as well as their ribbons. Default true. */
  heads?: boolean;
}
/**
 * Size, opacity and colour over a particle's life, from birth (0) to death (1). Needs the `curves` feature; set at
 * least one of the three.
 */
export interface VFXCurves {
  /** 2 to 32 multipliers of `size`, each 0..1, evenly spaced over the life and linearly interpolated: `[0, 1, 0]` swells then shrinks. */
  size?: readonly number[];
  /** 2 to 32 opacities, each 0..1, evenly spaced over the life; replaces the default fade-out: `[0, 1, 1, 0]` fades in and out. */
  alpha?: readonly number[];
  /** 2 to 8 stops ascending by `at` (0..1) with a linear RGB `color` (each 0..16) that multiplies the particle `color`: pass `color: [1, 1, 1, 1]` to draw the gradient as it is. */
  color?: readonly { at: number; color: readonly [number, number, number] }[];
}
/**
 * An emitter shape. Births start at `position` (plus `emissionExtent`) offset by the shape and move along the shape's
 * direction times `speed` (world units per second, -1000..1000, default 0; negative flies inward) on top of `velocity`
 * and `spread`. Needs the `emitter` feature.
 */
export type VFXEmitter =
  | {
      shape: 'sphere';
      /** Radius in world units, 0..1,000,000. Default 1. */
      radius?: number;
      /** Births on the surface only, not through the volume. Default false. */
      shell?: boolean;
      speed?: number;
    }
  | {
      shape: 'cone';
      /** Radius of the disc at the apex that births start on, world units, 0..1,000,000. Default 0 (a point). */
      radius?: number;
      /** Half angle off the axis in radians, 0..PI/2. Default PI/6. */
      angle?: number;
      /** Direction the cone opens along; need not be unit length, not zero. Default [0, 1, 0]. */
      axis?: Vec3;
      speed?: number;
    }
  | {
      shape: 'mesh';
      /** Vertex positions as xyz triples (world units around `position`), finite, at least one triangle. */
      positions: ArrayLike<number>;
      /** Triangle corner indices, a multiple of 3 (up to 262,144 triangles); omit when `positions` is a triangle list. */
      indices?: ArrayLike<number>;
      /** Multiplies `positions`, 1e-6..1e6. Default 1. */
      scale?: number;
      speed?: number;
    };
/**
 * A sphere or axis-aligned box (world units) the curl flow bends around within one unit and particles bounce off with
 * `bounce`. Up to 64 per effect; needs the `obstacles` feature.
 */
export type VFXObstacle =
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'box'; center: Vec3; halfSize: Vec3 };
/** A particle sprite: RGBA8 sRGB texels, row-major from the top-left. Copied at construction; needs the `texture` feature. */
export interface VFXTexture {
  /** Pixels, an integer 1-4096. */
  width: number;
  /** Pixels, an integer 1-4096. */
  height: number;
  /** `width * height * 4` bytes; RGB multiplies the particle colour, alpha its opacity. */
  data: Uint8Array | Uint8ClampedArray;
  /** Treat the texture as a grid of frames instead of one sprite. */
  atlas?: ParticleAtlas;
}
/**
 * The `atlas` of a particle texture: `columns` x `rows` equal frames, numbered left to right from the top row. With
 * `frames: 'random'` each particle shows one frame picked at random when it spawns (debris that uses parts of a block
 * texture); with `'lifetime'` it steps through every frame in order from spawn to death. `@margoengine/vfx/flipbook`
 * blends each of those frames into the next; without it the step is instant.
 */
export interface ParticleAtlas {
  /** Frames across, 1 to the texture width. */
  columns: number;
  /** Frames down, 1 to the texture height. */
  rows: number;
  frames: 'random' | 'lifetime';
}
/** Features add each GPU object they create here at once, so a setup that fails part-way still releases it. */
export type OwnedResources = { destroy(): void }[];
/** What an added feature builds on: the effect's buffers and its simulation module. */
export interface VFXState {
  device: GPUDevice;
  capacity: number;
  uniform: GPUBuffer;
  particles: GPUBuffer;
  alive: GPUBuffer;
  visible: GPUBuffer;
  indirect: GPUBuffer;
  /** The simulation module, with every feature's patch in it, for extra entry points. */
  module: GPUShaderModule;
  options: VFXOptions;
  /** The engine's frame statistics: a feature's own draw adds to `drawCalls`. */
  stats: { drawCalls: number };
  /** The engine the effect is attached to (its `lighting` is read every frame by `lit`). */
  engine: Engine;
}

/** The GPU side of an added feature, made at attach and again after device restoration. */
export interface VFXRuntime {
  /** Entries added to the simulation's bind group. */
  compute?: GPUBindGroupEntry[];
  /** Entries added to the billboard's bind group. */
  render?: GPUBindGroupEntry[];
  /** Per frame, before the simulation pass is recorded. */
  write?(c: Context): void;
  /** Extra dispatches at the end of the simulation pass. */
  run?(pass: GPUComputePassEncoder): void;
  /** Its own draw, after the billboards. */
  draw?(c: Context): void;
  /** True while the billboards are not drawn: the feature draws the particles itself. */
  hides?(): boolean;
  /** Births can come from the feature's own list, so the deaths and births scan run in frames without emitter births. */
  births?: boolean;
  /** Called by `VFX.reset()` after the particle buffers are cleared. */
  reset?(): void;
  /** Part of the billboard pipeline's cache key when its bind group `group` (1, or 2 under a transparency hook) is the feature's. */
  key?(group: number): string;
  /** The finished billboard shader with the feature's declarations for bind group `group` added. */
  shade?(code: string, group: number): string;
  /** Sets the feature's bind group `group` on a billboard draw with `pipeline`. */
  bind?(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, group: number): void;
  /** Drops what the feature registered, before its buffers are destroyed (device restore and `dispose`). */
  dispose?(): void;
}
/** A feature beyond the first seven (ribbons and later). The shape is internal: pass the entry's export. */
export interface VFXExtension<T> {
  /** Checks the option at construction and every frame. Values fixed at attach are checked by the runtime. */
  validate(value: T, options: VFXOptions): void;
  simulation?(code: string, value: T): string;
  billboard?(code: string, value: T): string;
  create?(state: VFXState, value: T, owned: OwnedResources): VFXRuntime;
}
/** Added features, in the order their patches apply. */
const extensions = [
  'ribbons',
  'mesh',
  'events',
  'lit',
  'depthCollide',
  'stretch',
  'fields',
  'skinned',
  'flipbook',
  'shadows',
] as const;
/** One compute dispatch of the slot-order passes. */
type Step = [GPUComputePipeline, GPUBindGroup];
/**
 * The optional parts of a particle effect. Pass the exports of the feature entries, for example `{sort}` from
 * `@margoengine/vfx/sort`; the shapes are internal. Effects without a feature compile the same WGSL as before.
 */
export interface VFXFeatures {
  obstacles?: { patch(simulation: string): string; write(list: readonly VFXObstacle[], extra: Float32Array): void };
  wrap?: { patch(simulation: string): string };
  sort?: {
    create(
      device: GPUDevice,
      particles: GPUBuffer,
      alive: GPUBuffer,
      indirect: GPUBuffer,
      extra: GPUBuffer,
      size: number,
      owned: OwnedResources,
    ): { run(pass: GPUComputePassEncoder): void };
  };
  texture?: {
    copy(texture: VFXTexture): VFXTexture;
    patch(billboard: string, texture: VFXTexture): string;
    create(device: GPUDevice, texture: VFXTexture, owned: OwnedResources): GPUBindGroupEntry[];
  };
  soft?: {
    patch(billboard: string, samples: number): string;
    create(
      device: GPUDevice,
      owned: OwnedResources,
    ): {
      /** Bind group entries (uniform at 11, depth at 12) for the depth last given to `write`. */
      entries: GPUBindGroupEntry[];
      /** True when `write` was given a different depth texture than before (bind groups are stale). */
      changed: boolean;
      /** Validates `depth` against the pass, uploads the frame's uniform and returns the depth's sample count. */
      write(c: Context, depth: GPUTexture | undefined, view: ArrayLike<number>, softness: number): number;
    };
  };
  curves?: {
    validate(curves: VFXCurves): void;
    patch(billboard: string, curves: VFXCurves): string;
    create(
      device: GPUDevice,
      owned: OwnedResources,
    ): { entries: GPUBindGroupEntry[]; write(queue: GPUQueue, curves: VFXCurves): void };
  };
  emitter?: {
    validate(emitter: VFXEmitter, mesh?: boolean): void;
    patch(simulation: string, emitter: VFXEmitter): string;
    create(
      device: GPUDevice,
      emitter: VFXEmitter,
      owned: OwnedResources,
    ): { entries: GPUBindGroupEntry[]; write(queue: GPUQueue, emitter: VFXEmitter): void };
  };
  ribbons?: VFXExtension<VFXRibbons>;
  mesh?: VFXExtension<VFXMeshParticles>;
  events?: VFXExtension<VFXEvents>;
  lit?: VFXExtension<VFXLit>;
  depthCollide?: VFXExtension<VFXDepthCollide>;
  stretch?: VFXExtension<VFXStretch>;
  fields?: VFXExtension<VFXFields>;
  skinned?: VFXExtension<VFXSkinned>;
  flipbook?: VFXExtension<VFXFlipbook>;
  shadows?: VFXExtension<VFXShadows>;
}
let nextId = 0;
/**
 * GPU particles built from the features given: `new VFX(options, {sort})`. `VFX` from `@margoengine/vfx` has every feature.
 * @throws RangeError when an option is out of range or the capacity exceeds device limits; TypeError when an option
 * needs a feature that was not given.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` from `gpuState`
 * before attachment.
 */
export class VFX implements EnginePlugin {
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private renderFormat = '';
  private renderDepth = '';
  private renderKey = '';
  readonly name = 'vfx:' + nextId++;
  readonly capacity: number;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private particles?: GPUBuffer;
  private alive?: GPUBuffer;
  private indirect?: GPUBuffer;
  private visible?: GPUBuffer;
  private respawn?: GPUBuffer;
  private simulation?: GPUComputePipeline;
  private computeGroup?: GPUBindGroup;
  private births?: Step[];
  private listing?: Step[];
  private renderGroups = new Map<GPURenderPipeline, GPUBindGroup>();
  private renders = new Map<string, GPURenderPipeline>();
  private billboard = '';
  private extra?: GPUBuffer;
  private readonly extraValues = new Float32Array(524);
  private sprite?: VFXTexture;
  private spriteEntries: GPUBindGroupEntry[] = [];
  private curveRuntime?: ReturnType<NonNullable<VFXFeatures['curves']>['create']>;
  private emitterRuntime?: ReturnType<NonNullable<VFXFeatures['emitter']>['create']>;
  private emitterShape?: string;
  private readonly transparency = transparencySlot();
  private sorter?: ReturnType<NonNullable<VFXFeatures['sort']>['create']>;
  private runtimes: VFXRuntime[] = [];
  /** On the WebGL2 layer, once loaded: the simulation as point draws on the GPU and the draw without a read-back (./compat.js). */
  private route?: { kernels: import('./compat.js').SimulationRoute; billboard(code: string): string; binding: number };
  private owned: OwnedResources = [];
  private softRuntime?: ReturnType<NonNullable<VFXFeatures['soft']>['create']>;
  private fogSource: FogLike | null = null;
  private fogBuffer?: GPUBuffer;
  private readonly fogData = new Float32Array(12);
  private readonly values = new Float32Array(56);
  private readonly ints = new Uint32Array(this.values.buffer);
  private readonly view = new Float32Array(16);
  private time = 0;
  private remainder = 0;
  private frames = 0;
  private burstCount = 0;
  private disposed = false;
  constructor(
    readonly options: VFXOptions = {},
    private readonly features: VFXFeatures = {},
  ) {
    // A preset capacity below an explicit initialCount is ignored: the app asked for that many particles.
    const tier = preset('vfx', options);
    this.options = (tier.capacity ?? 0) < (options.initialCount ?? 0) ? options : tier;
    this.capacity = this.options.capacity ?? 1_000_000;
    this.validate();
    const t = options.texture;
    if (t) {
      if (!features.texture)
        throw new TypeError(
          'VFX texture needs textureFeature from @margoengine/vfx/texture: pass {texture: textureFeature}',
        );
      this.sprite = features.texture.copy(t);
    }
  }
  static attach(instance: EngineKernel, options: VFXOptions = {}, features: VFXFeatures = {}): VFX {
    const effect = new VFX(options, features);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (!Number.isInteger(o.initialCount ?? 0) || (o.initialCount ?? 0) < 0 || (o.initialCount ?? 0) > this.capacity)
      throw new RangeError('initialCount must be a whole number up to capacity; pass a smaller count.');
    if (o.emissionExtent) {
      finiteVector(o.emissionExtent, 3, 'Emission extent');
      for (let i = 0; i < 3; i++)
        if (o.emissionExtent[i] < 0)
          throw new RangeError('Emission extent must be nonnegative; pass half-sizes of 0 or more.');
    }
    if (!Number.isFinite(o.intensity ?? 1) || (o.intensity ?? 1) < 0 || (o.intensity ?? 1) > 16)
      throw new RangeError('Particle intensity must be between 0 and 16; pass a value in range.');
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 1_000_000 ||
      (o.capacity !== undefined && o.capacity !== this.capacity) ||
      !Number.isFinite(o.rate ?? this.capacity / 2) ||
      (o.rate ?? this.capacity / 2) < 0 ||
      !Number.isFinite(Math.fround(o.ground ?? 0)) ||
      !Number.isFinite(Math.fround(o.angularVelocity ?? 0)) ||
      !Number.isFinite(o.bounce ?? 0.3) ||
      (o.bounce ?? 0.3) < 0 ||
      (o.bounce ?? 0.3) > 1 ||
      !Number.isFinite(Math.fround(o.size ?? 0.1)) ||
      (o.size ?? 0.1) <= 0
    )
      throw new RangeError('VFX capacity, rate, bounce, size or ground is out of range; check the options.');
    for (let i = 0; i < 3; i++) {
      const v = i === 0 ? (o.spread ?? 1) : i === 1 ? (o.turbulence ?? 0.5) : (o.frequency ?? 1);
      if (!Number.isFinite(Math.fround(v)) || v < 0)
        throw new RangeError('VFX spread, turbulence and frequency must be 0 or more; check the options.');
    }
    finiteVector(o.position ?? defaultPosition, 3, 'Emitter position');
    finiteVector(o.velocity ?? defaultVelocity, 3, 'Emitter velocity');
    finiteVector(o.gravity ?? defaultGravity, 3, 'Particle gravity');
    finiteVector(o.color ?? defaultColor, 4, 'Particle color');
    const color = o.color ?? defaultColor;
    for (let i = 0; i < 4; i++)
      if (color[i] < 0 || color[i] > 1)
        throw new RangeError('Particle color channels must be between 0 and 1; pass [r, g, b, a].');
    const life = o.lifetime ?? defaultLife;
    finiteVector(life, 2, 'Particle lifetime');
    if (life[0] <= 0 || life[1] < life[0])
      throw new RangeError('Particle lifetime must be [min, max] seconds, 0 < min <= max; pass both.');
    if (
      (o.sort !== undefined && typeof o.sort !== 'boolean') ||
      (o.wrap !== undefined && typeof o.wrap !== 'boolean') ||
      (o.wrap && !o.emissionExtent?.every((v) => v > 0))
    )
      throw new RangeError('VFX sort and wrap must be booleans; wrap needs emissionExtent above 0.');
    if (o.softness !== undefined && (!Number.isFinite(Math.fround(o.softness)) || o.softness < 0))
      throw new RangeError('VFX softness must be a world distance of 0 or more; pass e.g. 0.5, or 0 to turn it off.');
    if (o.depth !== undefined && typeof o.depth !== 'function')
      throw new TypeError('VFX depth must be a function returning the scene depth texture; pass () => depth.texture');
    if (o.softness) {
      if (!this.features.soft) throw new TypeError('VFX softness needs soft from @margoengine/vfx/soft: pass {soft}');
      if (!o.depth)
        throw new TypeError(
          'VFX softness needs scene depth: add DepthTexture from @margoengine/post/depth and pass depth: () => depth.texture',
        );
    }
    for (const key of ['obstacles', 'wrap', 'sort', 'curves', 'emitter'] as const)
      if (o[key] && !this.features[key]) throw new TypeError(`VFX ${key} needs ${key} from @margoengine/vfx/${key}`);
    if (o.curves) {
      this.features.curves!.validate(o.curves);
      if (!o.curves.size && !o.curves.alpha && !o.curves.color)
        throw new TypeError('VFX curves needs at least one of size, alpha or color; pass e.g. {size: [0, 1, 0]}');
    }
    if (o.emitter) {
      // The mesh is read once at attach; only the cheap numbers are checked again every frame.
      this.features.emitter!.validate(o.emitter, !this.emitterShape);
      if (this.emitterShape && o.emitter.shape !== this.emitterShape)
        throw new TypeError(
          `VFX emitter shape is fixed at attach (${this.emitterShape}); attach a new VFX to change it`,
        );
    } else if (this.emitterShape)
      throw new TypeError('VFX emitter was set at attach and cannot be removed; attach a new VFX to drop it');
    if (o.obstacles) this.features.obstacles!.write(o.obstacles, this.extraValues);
    for (const key of extensions) {
      const value = o[key],
        feature = this.features[key] as VFXExtension<unknown> | undefined;
      if (value === undefined) continue;
      if (!feature)
        throw new TypeError(
          `VFX ${key} needs ${key} from @margoengine/vfx/${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: pass {${key}}`,
        );
      feature.validate(value, o);
    }
  }
  /** The fog the particles are drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }
  /**
   * Fogs the particles: `fog` is `@margoengine/environment`'s `Fog` or any object with its fields, read every frame,
   * with Fog's maths (linear near/far, exp2 density, height falloff). Each pixel of a particle fades toward the fog
   * colour by the fog at its world position (particles blend alpha over the scene, so fog covers them as it covers
   * meshes). `null` (the default) draws exactly as without fog. The first fogged frame compiles a second billboard
   * shader; changing the fog or its `enabled` flag never does.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }
  burst(count: number): this {
    if (this.disposed || !Number.isInteger(count) || count < 0 || count > this.capacity)
      throw new RangeError('Particle burst must be a whole number up to capacity; pass a smaller count.');
    this.burstCount = Math.min(this.capacity, this.burstCount + count);
    return this;
  }
  /**
   * Back to how the effect began: no particles, its clock at 0 and `initialCount` waiting, so the same frames after it
   * give the same particles, for a seek. Call it between frames.
   * @throws MargoError `'disposed'` after `dispose()`.
   */
  reset(): this {
    if (this.disposed) throw new MargoError('disposed', 'VFX is disposed; attach a new VFX to reset it');
    this.time = this.remainder = this.frames = this.burstCount = 0;
    // Before attachment there is nothing to clear, and attaching adds initialCount itself.
    if (!this.device) return this;
    this.burstCount = this.options.initialCount ?? 0;
    for (const buffer of [this.particles!, this.alive!])
      this.device.queue.writeBuffer(buffer, 0, new Uint8Array(buffer.size));
    for (const buffer of [this.indirect!, this.visible!])
      this.device.queue.writeBuffer(buffer, 0, new Uint32Array([3, 0, 0, 0, 0]));
    for (const r of this.runtimes) r.reset?.();
    return this;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VFX requires WebGPU and a live effect; attach a new VFX to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    if (
      this.capacity * 64 > this.device.limits.maxStorageBufferBindingSize ||
      this.capacity * 64 > this.device.limits.maxBufferSize ||
      this.device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      this.device.limits.maxComputeWorkgroupSizeX < 256
    )
      throw new RangeError('VFX capacity exceeds the device limits; reduce capacity.');
    const buffer = (size: number, usage: number) =>
        this.device!.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }),
      o = this.options,
      f = this.features;
    this.uniform = buffer(224, GPUBufferUsage.UNIFORM);
    this.particles = buffer(this.capacity * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const size = o.sort ? 2 ** Math.ceil(Math.log2(this.capacity)) : this.capacity;
    if (o.obstacles || o.sort) this.extra = buffer(2096, GPUBufferUsage.UNIFORM);
    // Optional features patch the default shaders, so effects without them compile byte-identical WGSL.
    let simulation = simulationShader;
    if (o.obstacles) simulation = f.obstacles!.patch(simulation);
    if (o.wrap) simulation = f.wrap!.patch(simulation);
    if (o.emitter) {
      simulation = f.emitter!.patch(simulation, o.emitter);
      this.emitterRuntime = f.emitter!.create(this.device, o.emitter, this.owned);
      this.emitterShape = o.emitter.shape;
    }
    this.billboard = this.sprite ? f.texture!.patch(billboardShader, this.sprite) : billboardShader;
    if (o.curves) {
      this.billboard = f.curves!.patch(this.billboard, o.curves);
      this.curveRuntime = f.curves!.create(this.device, this.owned);
    }
    // Added features in their fixed order; validate() has checked that each one used is given.
    const added = extensions.flatMap((key): [VFXExtension<unknown>, unknown][] =>
      o[key] === undefined ? [] : [[f[key] as VFXExtension<unknown>, o[key]]],
    );
    for (const [feature, value] of added) {
      if (feature.simulation) simulation = feature.simulation(simulation, value);
      if (feature.billboard) this.billboard = feature.billboard(this.billboard, value);
    }
    this.alive = buffer(size * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.indirect = buffer(20, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
    // respawn receives the births scan's sum (unused); births and drawn hold one count, then offset, per workgroup.
    this.respawn = buffer(20, GPUBufferUsage.STORAGE);
    // indirect counts live particles; visible holds the draw's [vertexCount, instanceCount, firstVertex, firstInstance] for the on-screen ones listed in alive.
    this.visible = buffer(20, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
    for (const b of [this.indirect, this.visible])
      this.device.queue.writeBuffer(b, 0, new Uint32Array([3, 0, 0, 0, 0]));
    // Each scan buffer is owned as soon as it exists, so a later allocation that fails releases the earlier ones.
    const groups = Math.ceil(this.capacity / 256),
      owned = (size: number) => {
        const made = buffer(size, GPUBufferUsage.STORAGE);
        this.owned.push(made);
        return made;
      },
      births = owned(groups * 4),
      drawn = owned(groups * 4),
      listed = owned(groups * 1024),
      module = this.device.createShaderModule({ code: simulation }),
      u = this.uniform!,
      // One pipeline per entry point of the simulation module; buffers[k] goes to binding k (0: none).
      step = (entryPoint: string, buffers: (GPUBuffer | 0)[], more: GPUBindGroupEntry[] = []): Step => {
        const p = this.device!.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
        return [
          p,
          this.device!.createBindGroup({
            layout: p.getBindGroupLayout(0),
            entries: [
              ...buffers.flatMap((buffer, binding) => (buffer ? [{ binding, resource: { buffer } }] : [])),
              ...more,
            ],
          }),
        ];
      };
    this.runtimes = added.flatMap(([feature, value]) =>
      feature.create
        ? [
            feature.create(
              {
                device: this.device!,
                capacity: this.capacity,
                uniform: u,
                particles: this.particles!,
                alive: this.alive!,
                visible: this.visible!,
                indirect: this.indirect!,
                module,
                options: o,
                stats: this.engine!.stats,
                engine: this.engine!,
              },
              value,
              this.owned,
            ),
          ]
        : [],
    );
    const computeEntries = this.runtimes.flatMap((r) => r.compute ?? []);
    [this.simulation, this.computeGroup] = step(
      'main',
      [u, this.particles!, drawn, 0, this.indirect!, births, 0, 0, 0, listed],
      [
        ...(o.obstacles ? [{ binding: 6, resource: { buffer: this.extra! } }] : []),
        ...(this.emitterRuntime?.entries ?? []),
        ...computeEntries,
      ],
    );
    // Slot order (shader.ts): deaths and the births scan before main; the drawn scan and compact after it.
    this.births = [
      step('deaths', [u, this.particles!, births]),
      step('scan', [u, 0, births, 0, 0, 0, 0, 0, 0, 0, this.respawn!]),
    ];
    this.listing = [
      step('scan', [u, 0, drawn, 0, 0, 0, 0, 0, 0, 0, this.visible!]),
      step('compact', [u, 0, drawn, this.alive!, 0, 0, 0, 0, 0, listed, this.visible!]),
    ];
    if (o.sort)
      this.sorter = f.sort!.create(
        this.device,
        this.particles,
        this.alive,
        this.visible,
        this.extra!,
        size,
        this.owned,
      );
    if (this.sprite) this.spriteEntries = f.texture!.create(this.device, this.sprite, this.owned);
    this.burst(this.options.initialCount ?? 0);
    const particles = this.particles;
    loadCompatRoute(this.device, () => import('./compat.js'))?.then((compat) => {
      if (this.particles !== particles) return;
      this.route = {
        kernels: new compat.SimulationRoute(
          this.device!,
          simulation,
          this.capacity,
          {
            uniform: u,
            particles,
            alive: this.alive!,
            indirect: this.indirect!,
            visible: this.visible!,
          },
          [
            ...(o.obstacles ? [{ binding: 6, resource: { buffer: this.extra! } }] : []),
            ...(this.emitterRuntime?.entries ?? []),
            ...computeEntries,
          ],
          this.owned,
        ),
        billboard: compat.countedBillboard,
        binding: compat.COUNT_BINDING,
      };
      this.renders.clear();
      this.renderGroups.clear();
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':simulate',
      order: -8,
      execute: (c) => {
        if (c.backend === 'webgpu') this.simulate(c);
      },
    });
    graph.add({
      name: this.name + ':draw',
      order: 6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private simulate(c: Context): void {
    this.validate();
    const o = this.options;
    this.time += c.delta;
    const emissions = (o.rate ?? this.capacity / 2) * c.delta + this.remainder;
    this.remainder = emissions % 1;
    const budget = Math.min(this.capacity, Math.floor(emissions) + this.burstCount);
    this.burstCount = 0;
    this.values.set(c.camera.matrix);
    viewMatrix(this.view, c.camera);
    for (let i = 0; i < 3; i++) {
      this.values[16 + i] = this.view[i * 4];
      this.values[20 + i] = this.view[i * 4 + 1];
      this.values[48 + i] = o.emissionExtent?.[i] ?? 0;
    }
    this.values[19] = this.transparency.hook ? this.view[14] : 0;
    // up.w: pixels per world unit at clip w = 1, the clip-space length of the camera's up axis times half the viewport
    // height, so the billboard can keep far particles at least 1.5 px across.
    const m = this.values,
      x = m[0] * m[20] + m[4] * m[21] + m[8] * m[22],
      y = m[1] * m[20] + m[5] * m[21] + m[9] * m[22];
    m[23] = Math.sqrt(x * x + y * y) * c.height * 0.5;
    this.values.set(o.gravity ?? defaultGravity, 24);
    this.values[27] = c.delta;
    this.values.set(o.position ?? defaultPosition, 28);
    this.values[31] = this.time;
    this.values.set(o.velocity ?? defaultVelocity, 32);
    this.values[35] = o.spread ?? 1;
    this.values.set(o.color ?? defaultColor, 36);
    const life = o.lifetime ?? defaultLife;
    this.values[40] = o.size ?? 0.1;
    this.values[41] = life[0];
    this.values[42] = life[1];
    this.values[43] = o.ground ?? 0;
    this.values[44] = o.turbulence ?? 0.5;
    this.values[45] = o.frequency ?? 1;
    this.values[46] = o.bounce ?? 0.3;
    this.values[47] = o.angularVelocity ?? 0;
    this.values[51] = o.intensity ?? 1;
    this.ints[52] = this.capacity;
    this.ints[53] = budget;
    this.ints[54] = this.frames++;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    if (this.extra) {
      const e = this.extraValues;
      e.set(c.camera.position);
      for (let i = 0; i < 3; i++) e[4 + i] = -this.view[i * 4 + 2];
      c.device.queue.writeBuffer(this.extra, 0, e as Float32Array<ArrayBuffer>);
    }
    if (o.curves) this.curveRuntime!.write(c.device.queue, o.curves);
    if (o.emitter) this.emitterRuntime!.write(c.device.queue, o.emitter);
    for (const r of this.runtimes) r.write?.(c);
    if (!this.route) c.encoder.clearBuffer(this.indirect!, 4, 4);
    const pass = c.encoder.beginComputePass(),
      groups = Math.ceil(this.capacity / 256),
      step = ([pipeline, group]: Step, count: number) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(count);
      },
      [deaths, births] = this.births!,
      [scan, compact] = this.listing!;
    // A feature that gives births of its own needs the free slots counted in every frame.
    const counted = budget > 0 || this.runtimes.some((r) => r.births);
    if (this.route) this.route.kernels.encode(pass, counted);
    else {
      if (counted) {
        step(deaths, groups);
        step(births, 1);
      }
      step([this.simulation!, this.computeGroup!], groups);
      step(scan, 1);
      step(compact, groups);
    }
    this.sorter?.run(pass);
    for (const r of this.runtimes) r.run?.(pass);
    pass.end();
  }
  /** The pipeline and group 0 of a draw into the frame, or with `hook` into its pass. */
  private prepare(c: Context, hook?: SurfaceTransparency): [GPURenderPipeline, GPUBindGroup] {
    if (this.renderFormat !== c.format || this.renderDepth !== c.descriptor.depthStencil!.format) {
      this.renderFormat = c.format;
      this.renderDepth = c.descriptor.depthStencil!.format;
      this.renderKey = this.renderFormat + ':' + this.renderDepth;
    }
    const fog = this.fogSource;
    if (fog) {
      // The billboard writes its colour as it is, so on an 8-bit (non -srgb) target the fog colour goes in encoded.
      writeFog(fog, c.camera.position, this.fogData, !c.format.includes('float') && !c.format.endsWith('-srgb'));
      this.fogBuffer ??= c.device.createBuffer({
        size: FOG_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      c.device.queue.writeBuffer(this.fogBuffer, 0, this.fogData);
    }
    // Soft particles: the feature checks the depth and uploads its uniform; a new depth texture rebinds.
    const softness = this.options.softness ?? 0;
    let samples = 0;
    if (softness > 0) {
      this.softRuntime ??= this.features.soft!.create(c.device, this.owned);
      samples = this.softRuntime.write(c, this.options.depth!(), this.view, softness);
      if (this.softRuntime.changed) this.renderGroups.clear();
    }
    // A feature's own bind group comes after group 0, and after the hook's group 1.
    const declarations = hook?.surface(1),
      slot = hook ? 2 : 1;
    let key =
      this.renderKey +
      ':' +
      c.descriptor.multisample?.count +
      (fog ? ':fog' : '') +
      (samples ? ':soft' + samples : '') +
      (declarations ?? '');
    for (const r of this.runtimes) if (r.key) key += r.key(slot);
    let pipeline = this.renders.get(key);
    if (!pipeline) {
      const lit = samples ? this.features.soft!.patch(this.billboard, samples) : this.billboard,
        fogged = fog ? foggedBillboard(lit) : lit,
        billboard = this.route ? this.route.billboard(fogged) : fogged;
      let code = declarations
        ? transparentBillboard(billboard, declarations)
        : (c.descriptor.multisample?.count ?? 1) > 1
          ? multisampled(billboard)
          : billboard;
      for (const r of this.runtimes) if (r.shade) code = r.shade(code, slot);
      const module = c.device.createShaderModule({ code });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: hook ? 'transparent' : 'fragment',
          ...(hook?.blends ? { constants: { margoKind: 0 } } : {}),
          targets: hook
            ? [...hook.targets]
            : [
                {
                  format: c.format,
                  blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  },
                },
              ],
        },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
        },
      });
      this.renders.set(key, pipeline);
    }
    // Auto layouts are pipeline-specific, including output format variants.
    let group = this.renderGroups.get(pipeline);
    if (!group) {
      group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...[this.uniform!, this.particles!, this.alive!].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
          ...this.spriteEntries,
          ...(this.curveRuntime?.entries ?? []),
          ...this.runtimes.flatMap((r) => r.render ?? []),
          ...(fog ? [{ binding: 5, resource: { buffer: this.fogBuffer! } }] : []),
          ...(samples ? this.softRuntime!.entries : []),
          ...(this.route ? [{ binding: this.route.binding, resource: { buffer: this.visible! } }] : []),
        ],
      });
      this.renderGroups.set(pipeline, group);
    }
    return [pipeline, group];
  }
  private draw(c: Context): void {
    // An order-independent pass takes the billboards only; added features' own draws (meshes, ribbons) stay here.
    if (!this.transparency.hook && !this.runtimes.some((r) => r.hides?.())) this.billboards(c);
    for (const r of this.runtimes) r.draw?.(c);
  }
  private billboards(c: Context): void {
    const [pipeline, group] = this.prepare(c);
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    this.depthAttachment.stencilReadOnly = c.descriptor.depthStencil!.format.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    for (const r of this.runtimes) r.bind?.(pass, pipeline, 1);
    applyView(pass, c);
    if (this.route) pass.draw(3, this.capacity);
    else pass.drawIndirect(this.visible!, 0);
    pass.end();
    this.engine!.stats.drawCalls++;
  }
  /**
   * Leaves the frame's draw (order 6) to an order-independent pass, which calls `drawTransparent`. Use `addEffect` from
   * `@margoengine/oit/vfx`. Returns a remover; `released` runs if this effect is disposed first.
   */
  setTransparency(hook: SurfaceTransparency, released?: () => void): () => void {
    return this.transparency.set(hook, released);
  }
  /** Draws the particles into `hook`'s pass, depth tested and not written. */
  drawTransparent(c: Context, hook: SurfaceTransparency): void {
    if (!this.visible || this.runtimes.some((r) => r.hides?.())) return;
    const [pipeline, group] = this.prepare(c, hook),
      pass = surfacePass(c.device, hook, pipeline, group);
    for (const r of this.runtimes) r.bind?.(pass, pipeline, 2);
    if (this.route) pass.draw(3, this.capacity);
    else pass.drawIndirect(this.visible, 0);
    this.engine!.stats.drawCalls++;
  }
  get gpuState(): { particles: GPUBuffer; indirect: GPUBuffer; alive: GPUBuffer; visible: GPUBuffer } {
    if (!this.indirect || !this.particles || !this.alive || !this.visible)
      throw new MargoError('state', 'VFX is not attached; attach it to an engine first');
    return { particles: this.particles, indirect: this.indirect, alive: this.alive, visible: this.visible };
  }
  private release(): void {
    for (const runtime of this.runtimes) runtime.dispose?.();
    for (const buffer of [
      this.uniform,
      this.particles,
      this.alive,
      this.indirect,
      this.visible,
      this.respawn,
      this.extra,
      this.fogBuffer,
      ...this.owned,
    ])
      buffer?.destroy();
    this.fogBuffer = undefined;
    this.softRuntime = undefined;
    this.owned = [];
    this.spriteEntries = [];
    this.curveRuntime = this.emitterRuntime = undefined;
    this.extra = this.sorter = this.route = undefined;
    this.runtimes = [];

    this.uniform = this.particles = this.alive = this.indirect = this.visible = this.respawn = undefined;
    this.computeGroup = this.births = this.listing = undefined;
    this.renderGroups.clear();
    this.renders.clear();
    this.simulation = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transparency.released?.();
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
