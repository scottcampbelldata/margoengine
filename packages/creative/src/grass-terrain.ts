/// <reference lib="esnext.disposable" preserve="true" />
import { Geometry, type EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { ScatterOptions } from '@margoengine/scatter';
import type { TrampledScatter, TrampleOptions } from '@margoengine/scatter/interact';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
/** Linear RGBA colour raster, sampled bilinearly at cell centres in world XZ. Alpha is retained but unused. */
export interface GrassColorMap {
  /** Integer 1..4096, with at most 1048576 pixels total. */
  readonly width: number;
  /** Integer 1..4096. */
  readonly height: number;
  /** Four finite components in 0..1 per texel, row-major. Snapshotted at creation. */
  readonly data: Float32Array;
  /** World [minX,minZ,maxX,maxZ]. Default: the scatter bounds or its area about centre. */
  readonly bounds?: readonly [number, number, number, number];
}
/** Scatter placement, rooted wind and sphere interaction, with a three-segment blade by default. */
export interface TerrainGrassOptions extends Omit<ScatterOptions, 'material'> {
  /** Optional custom blade geometry/LOD triplet. Defaults to a 1 m tall, 8 cm wide segmented blade. */
  geometry?: Geometry | readonly [Geometry, Geometry, Geometry];
  /** World colour map multiplied by the grass colour; omitted gives white. */
  colorMap?: GrassColorMap;
  /** Sphere field/recovery settings; defaults to scatter/interact's settings. */
  interaction?: TrampleOptions;
  /** Abort before import, creation or attachment. */
  signal?: AbortSignal;
}

function colors(options: TerrainGrassOptions): Float32Array {
  const map = options.colorMap ?? { width: 1, height: 1, data: new Float32Array([1, 1, 1, 1]) };
  const { width, height, data } = map,
    area = options.area ?? [50, 50],
    center = options.center ?? [0, 0, 0];
  const bounds = map.bounds ??
    options.bounds ?? [
      center[0] - area[0] / 2,
      center[2] - area[1] / 2,
      center[0] + area[0] / 2,
      center[2] + area[1] / 2,
    ];
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 1048576 ||
    !(data instanceof Float32Array) ||
    data.length !== width * height * 4 ||
    data.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
    bounds.length !== 4 ||
    bounds.some((x) => !Number.isFinite(Math.fround(x))) ||
    ![0, 1].every(
      (i) =>
        Number.isFinite(Math.fround(bounds[i + 2] - bounds[i])) &&
        Math.fround(bounds[i + 2]) > Math.fround(bounds[i]) &&
        Math.fround(bounds[i + 2] - bounds[i]) >= 2 ** -126,
    )
  )
    throw rangeError(
      'Grass colour map needs finite RGBA in 0..1, matching dimensions and ascending bounds; use at most 1048576 pixels',
      'arguments',
    );
  const packed = new Float32Array(8 + data.length);
  packed.set(bounds);
  packed.set([width, height], 4);
  packed.set(data, 8);
  return packed;
}
const tintShader = (group: number, binding: number) => `
@group(${group}) @binding(${binding}) var<storage,read> grassMap:array<vec4f>;
fn grassTexel(p:vec2i)->vec3f {
 let size=vec2i(grassMap[1].xy);let c=clamp(p,vec2i(0),size-1);
 return grassMap[2+c.y*size.x+c.x].rgb;
}
fn grassTint(root:vec3f)->vec3f {
 let texel=clamp((root.xz-grassMap[0].xy)/(grassMap[0].zw-grassMap[0].xy),vec2f(0),vec2f(1))*grassMap[1].xy-0.5;
 let c=vec2i(floor(texel));let f=fract(texel);
 return mix(mix(grassTexel(c),grassTexel(c+vec2i(1,0)),f.x),mix(grassTexel(c+vec2i(0,1)),grassTexel(c+vec2i(1,1)),f.x),f.y);
}
`;

/**
 * Creates terrain-rooted grass using scatter's existing height/density sampling, LODs, wind and moving spheres.
 * The scatter package loads only when called. Call setInteractors each frame; dispose the returned field to detach.
 */
export async function createTerrainGrass(
  engine: EngineKernel,
  options: TerrainGrassOptions = {},
): Promise<TrampledScatter> {
  options.signal?.throwIfAborted();
  const data = colors(options);
  const { TrampledScatter: Field } = await import('@margoengine/scatter/interact');
  options.signal?.throwIfAborted();
  const blade =
    options.geometry ??
    new Geometry(
      [-0.04, 0, 0, 0.04, 0, 0, -0.027, 1 / 3, 0, 0.027, 1 / 3, 0, -0.014, 2 / 3, 0, 0.014, 2 / 3, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6],
    );
  class TerrainField extends Field {
    #map?: GPUBuffer;
    protected override poseEntries(): { buffer: GPUBuffer }[] {
      const entries = super.poseEntries();
      if (!this.#map) {
        const device = this.engine!.gpu!;
        this.#map = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.#map, 0, data);
      }
      return [...entries, { buffer: this.#map }];
    }
    protected override poseCode(source: string, group: number, binding: number): string {
      const code = super.poseCode(source, group, binding),
        slot = binding + super.poseEntries().length;
      if (!code.includes('shade:f32}') || !code.includes('return ScatterPose('))
        throw fault(
          'state',
          'Terrain grass needs the scatter pose contract; rebuild compatible creative and scatter packages',
        );
      let result =
        tintShader(group, slot) +
        code
          .replace('shade:f32}', 'shade:f32,tint:vec3f}')
          .replace(/return ScatterPose\(([^;]+)\);/, 'return ScatterPose($1,grassTint(position.xyz));');
      if (result.includes('var color=frame.color.rgb*i.shade')) {
        result = result
          .replace(/struct Output \{([^}]+)\}/, 'struct Output {$1,@location(4) tint:vec3f}')
          .replace(/return Output\(([^;]+)\);/, 'return Output($1,pose.tint);')
          .replace('frame.color.rgb*i.shade', 'frame.color.rgb*i.shade*i.tint');
      }
      return result;
    }
    protected override release(): void {
      this.#map?.destroy();
      this.#map = undefined;
      super.release();
    }
  }
  const { geometry: _geometry, colorMap: _colorMap, interaction, signal, ...scatter } = options;
  // This composed field uses the unlit grass shading path; material systems stay with their owning scatter entries.
  if ('material' in options)
    throw rangeError(
      'Terrain grass takes colour and colour maps; use the scatter material entries for custom materials',
      'arguments',
    );
  const field = new TerrainField(blade, { wind: [1, 0.35, 0.45], maxSlope: 90, blades: {}, ...scatter }, interaction);
  signal?.throwIfAborted();
  engineRuntime(engine).use(field);
  return field;
}
