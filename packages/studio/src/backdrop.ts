/// <reference lib="esnext.disposable" preserve="true" />
import { Geometry, PbrMaterial, type EngineKernel, type Mesh, type PbrMaterialOptions } from '@margoengine/core';
import type { StudioLight } from '@margoengine/environment/studio';
import type { EnvironmentLighting, EnvironmentLoadOptions } from '@margoengine/environment';
import { rangeError, typeError } from '../../shared/errors.js';

/** The four photographic staging rigs, for a subject facing a camera on +Z. */
/**
 * Named softbox rigs. 'tent' is a product light tent for metal and other mirror-like parts: six panels ring the
 * horizon, so every vertical face reflects a lit panel instead of the dark room, under a large overhead box.
 */
export type StagingPreset = 'portrait' | 'rembrandt' | 'upfront' | 'soft' | 'tent';
/** Quarter-circle cyclorama dimensions, in world units. */
export interface BackdropShape {
  /** Horizontal width, 0.001..1e4. Default 8. */
  width?: number;
  /** Front-to-back depth, 0.001..1e4. Default 5. */
  depth?: number;
  /** Wall height, 0.001..1e4. Default 4. */
  height?: number;
  /** Bend radius, positive and smaller than depth and height. Default 1. */
  radius?: number;
  /** Quarter-circle subdivisions, integer 2..256. Default 32. */
  segments?: number;
}
/** A backdrop mesh's initial shape and surface. */
export interface BackdropOptions extends BackdropShape {
  /** Core material values; default matte grey (#b8b8b8, roughness 1, metalness 0). */
  material?: PbrMaterialOptions;
}

/** Build a smooth floor-to-wall sweep with exact analytic unit normals and outward winding. */
export function backdropGeometry(options: BackdropShape = {}): Geometry {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw typeError('Invalid backdrop shape; pass an options object', 'arguments');
  const width = options.width ?? 8,
    depth = options.depth ?? 5,
    height = options.height ?? 4,
    radius = options.radius ?? 1,
    segments = options.segments ?? 32;
  if (
    ![width, depth, height].every((v) => Number.isFinite(v) && v >= 0.001 && v <= 1e4) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius >= Math.min(depth, height) ||
    !Number.isInteger(segments) ||
    segments < 2 ||
    segments > 256
  )
    throw rangeError(
      'Invalid backdrop dimensions; use finite width/depth/height .001..1e4, positive radius below depth/height and 2..256 integer segments',
      'arguments',
    );
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  let previousY = NaN,
    previousZ = NaN;
  const row = (y: number, z: number, ny: number, nz: number) => {
    const fy = Math.fround(y),
      fz = Math.fround(z);
    if (fy === previousY && fz === previousZ)
      throw rangeError(
        'Backdrop bend collapses at float32 precision; increase radius or reduce segments/depth',
        'arguments',
      );
    previousY = fy;
    previousZ = fz;
    positions.push(-width / 2, y, z, width / 2, y, z);
    normals.push(0, ny, nz, 0, ny, nz);
  };
  row(0, depth / 2, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const angle = ((i / segments) * Math.PI) / 2,
      s = Math.sin(angle),
      c = Math.cos(angle);
    row(radius * (1 - c), -depth / 2 + radius - radius * s, c, s);
  }
  row(height, -depth / 2, 0, 1);
  for (let i = 0; i < segments + 2; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  return new Geometry(positions, normals, indices);
}

/** A real mesh cyclorama, with the ordinary core mesh transform/material API. */
export class Backdrop {
  /** Borrowed mesh handle; translate/rotate/scale it with normal mesh setters. */
  readonly mesh: Mesh;
  private disposed = false;
  private constructor(engine: EngineKernel, options: BackdropOptions) {
    const geometry = backdropGeometry(options),
      material = new PbrMaterial({ color: '#b8b8b8', roughness: 1, metalness: 0, ...options.material });
    this.mesh = engine.createMesh().setGeometry(geometry).setMaterial(material);
  }
  /** Create a cyclorama in the default scene. Mesh disposal remains owned by the engine too. */
  static attach(engine: EngineKernel, options: BackdropOptions = {}): Backdrop {
    return new Backdrop(engine, options);
  }
  /** Release the mesh. Repeated calls and using cleanup are safe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

// Original photographic directions/ratios and softbox angular extents; no rival preset data.
const rigs: Record<StagingPreset, readonly StudioLight[]> = {
  portrait: [
    { direction: [-1, 1.1, 1.2], width: 0.8, height: 1.1, intensity: 7 },
    { direction: [1, 0.3, 1], width: 0.9, height: 0.9, intensity: 2.5 },
    { direction: [0.5, 1, -1], width: 0.35, height: 1, intensity: 4 },
  ],
  rembrandt: [
    { direction: [-1, 1.4, 1], width: 0.55, height: 0.8, intensity: 9 },
    { direction: [1, 0.4, 1], width: 0.7, height: 0.8, intensity: 0.8 },
    { direction: [0.7, 0.8, -1], width: 0.3, height: 1, intensity: 3 },
  ],
  upfront: [
    { direction: [0, 0.6, 1], width: 1.1, height: 1.1, intensity: 7 },
    { direction: [-1, 0.4, 0.7], width: 0.7, height: 0.8, intensity: 1.5 },
    { direction: [1, 0.4, 0.7], width: 0.7, height: 0.8, intensity: 1.5 },
  ],
  soft: [
    { direction: [-0.6, 1, 1], width: 1.7, height: 1.4, intensity: 4 },
    { direction: [1, 0.6, 0.6], width: 1.5, height: 1.3, intensity: 3 },
    { direction: [0, 1, -0.5], width: 1.4, height: 1.1, intensity: 2 },
  ],
  // A light tent (the diffuse enclosure of product and jewellery photography): six panels 60 degrees apart, each 1.2
  // rad wide, ring the horizon with soft overlapping edges, so a flat metal face at any heading mirrors a panel. The
  // front-left panel is brightest and the back ones dimmest, so faces still read as a gradient of form, not one tone.
  tent: [
    { direction: [0, 1, 0], width: 1.6, height: 1.6, intensity: 3 },
    ...[3, 2.2, 1.6, 1.3, 1.6, 2.2].map((intensity, i) => {
      const a = Math.PI / 4 + (i * Math.PI) / 3;
      return { direction: [-Math.sin(a), 0.22, Math.cos(a)] as [number, number, number], width: 1.2, height: 0.9, intensity, softness: 0.3 };
    }),
  ],
};

// The room each rig's softboxes hang in (environment/studio floor, walls and ceiling radiance). A tent is white
// fabric all round, floor included, so a vertical face seen from above mirrors lit cloth instead of a dark floor;
// the other rigs keep studio's grey room.
type Rgb = [number, number, number];
/** The room radiance a staging rig sets in environment/studio (linear RGB); undefined keeps studio's grey room. */
export interface StagingRoom {
  floor: Rgb;
  walls: Rgb;
  ceiling: Rgb;
}
const rooms: Partial<Record<StagingPreset, StagingRoom>> = {
  tent: { floor: [0.6, 0.6, 0.6], walls: [0.8, 0.8, 0.8], ceiling: [1, 1, 1] },
};

/** A fresh copy of the named rig's room (floor, walls, ceiling), or undefined for studio's default grey room. */
export function stagingRoom(preset: StagingPreset): StagingRoom | undefined {
  stagingLights(preset);
  const room = rooms[preset];
  return room && (structuredClone(room) as StagingRoom);
}

/** Fresh softbox descriptors for the named rig, ready for environment/studio. Default rembrandt. */
export function stagingLights(preset: StagingPreset = 'rembrandt'): StudioLight[] {
  if (!Object.hasOwn(rigs, preset))
    throw rangeError('Unknown staging preset; choose portrait, rembrandt, upfront, soft or tent', 'arguments');
  return structuredClone(rigs[preset]) as StudioLight[];
}
/** Environment preparation settings, with an optional procedural image width. */
export interface StagingLightingOptions extends EnvironmentLoadOptions {
  /** Equirect image width, a power of two 16..4096. Default 256. */
  width?: number;
}
/** Lazily create a named studio environment and its lighting; dispose the returned lighting to detach both. */
export async function stagingLighting(
  engine: EngineKernel,
  preset: StagingPreset = 'rembrandt',
  options: StagingLightingOptions = {},
): Promise<EnvironmentLighting> {
  options.signal?.throwIfAborted();
  const lights = stagingLights(preset),
    { width = 256, ...settings } = options;
  const [{ studio }, { EnvironmentLighting }] = await Promise.all([
    import('@margoengine/environment/studio'),
    import('@margoengine/environment'),
  ]);
  options.signal?.throwIfAborted();
  return EnvironmentLighting.load(engine, studio({ width, lights, ...stagingRoom(preset) }), settings);
}
