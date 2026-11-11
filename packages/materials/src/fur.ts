/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import {
  Material,
  createMesh,
  type MaterialOptions,
  type MaterialMesh,
  type MeshGeometry,
} from '@margoengine/materials';
import type { CasterDisplacement } from '../../shared/caster.js';
import { MargoError } from '@margoengine/math/errors';
import { retire } from '../../shared/frame-resources.js';
import { displacementCode } from '../../shared/displacement.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Shell fur controls, in the mesh's local axes. All values are live on FurMaterial.fur. */
export interface FurOptions {
  /** Normalized shell height, root 0 to tip 1. Default 0.5. */
  layer?: number;
  /** Length in mesh units. Default 0.1. */
  length?: number;
  /** Strand cells per UV unit. Default 64. */
  density?: number;
  /** Fraction of each cell covered by a strand at its root. Default 0.65. */
  coverage?: number;
  /** Quadratic bend in mesh axes, relative to length. Default [0, -0.3, 0]. */
  gravity?: readonly [number, number, number];
  /** Oscillating bend in mesh axes, relative to length. Default [0, 0, 0]. */
  wind?: readonly [number, number, number];
  /** Wind cycles per second. Default 1. */
  windFrequency?: number;
  /** Caller-supplied time in seconds. Default 0. */
  time?: number;
  /** Integer random seed, 0 to 16777215. Default 1. */
  seed?: number;
  /** Fraction of base colour retained at the root. Default 0.35. */
  rootShade?: number;
}
/** Fur plus the usual PBR material parameters, maps and lighting controls. */
export interface FurMaterialOptions extends MaterialOptions {
  fur?: FurOptions;
}
const scalar = (value: number, low: number, high: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || value < low || value > high)
    throw new RangeError(`Fur ${label} must be finite from ${low} to ${high}; pass a number in that range`);
  return value;
};
const vector = (value: readonly number[], label: string): void => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
  )
    throw new TypeError(`Fur ${label} needs three finite components; pass [x, y, z] in mesh axes`);
};
const declarations = (group: number) => `struct MargoFur {shape:vec4f,gravity:vec4f,wind:vec4f,clock:vec4f}
@group(${group}) @binding(180) var<uniform> margoFur:MargoFur;
fn margoFurHash(cell:vec2f)->f32 {
  var k=bitcast<vec2u>(vec2i(cell));
  var h=k.x*1664525u+k.y*1013904223u+u32(margoFur.clock.y)*747796405u;
  h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;
  return f32((h^(h>>16u))>>8u)/16777216.0;
}
fn margoFurMoveWith(shape:vec4f,gravity:vec4f,wind:vec4f,clock:vec4f,n:vec3f,uv:vec2f)->vec3f {
  let layer=shape.x;let length=shape.y;
  let phase=6.2831853*(clock.x*clock.z+dot(uv,vec2f(0.73,0.37)));
  let force=gravity.xyz+wind.xyz*sin(phase);
  return n*(length*layer)+force*(length*layer*layer);
}
fn margoFurMove(n:vec3f,uv:vec2f)->vec3f {
  return margoFurMoveWith(margoFur.shape,margoFur.gravity,margoFur.wind,margoFur.clock,n,uv);
}
fn margoFurCoverage(uv:vec2f)->f32 {
  let layer=margoFur.shape.x;if(layer<=0.0){return 1.0;}
  if(margoFur.shape.z<=0.0){return 0.0;}let cell=uv*margoFur.shape.z;let base=floor(cell);let random=margoFurHash(base);
  // shape.w is the root radius (furRootRadius); the centre moves only as far as keeps that disc inside its cell.
  let center=0.5+(vec2f(margoFurHash(base+vec2f(97,13)),margoFurHash(base+vec2f(7,157)))-0.5)*max(1.0-2.0*margoFur.shape.w,0.0);
  let height=0.35+0.65*random;
  let radius=margoFur.shape.w*max(1.0-layer/height,0.0);
  return select(0.0,1.0,layer<height&&distance(fract(cell),center)<radius);
}
`;
/**
 * The root radius, in cell widths, of a strand disc covering `coverage` of its unit cell. Up to pi / 4 that is
 * sqrt(coverage / pi) and the disc fits the cell; above it the disc is centred and its corners are cut by the cell's
 * sides, so its area is pi r^2 less four circular segments r^2 acos(1 / 2r) - (1 / 2) sqrt(r^2 - 1 / 4), solved by
 * bisection up to r = sqrt(2) / 2, where the cell is covered.
 */
function furRootRadius(coverage: number): number {
  if (coverage <= Math.PI / 4) return Math.sqrt(coverage / Math.PI);
  const area = (r: number) => Math.PI * r * r - 4 * (r * r * Math.acos(0.5 / r) - 0.5 * Math.sqrt(r * r - 0.25));
  let low = 0.5,
    high = Math.SQRT1_2;
  for (let k = 0; k < 40; k++) {
    const mid = (low + high) / 2;
    if (area(mid) < coverage) low = mid;
    else high = mid;
  }
  return high;
}
let serial = 0;
/**
 * One displaced, cut-out shell of a fur volume. createFur makes a complete stack. PBR maps and lighting stay native;
 * the same strand mask and displacement reach shadow, contact-shadow, selection and depth passes via the caster hook.
 */
export class FurMaterial extends Material {
  readonly fur: Required<FurOptions>;
  private readonly buffers = new Map<
    GPUDevice,
    {
      buffer: GPUBuffer;
      last: Float32Array;
      bytes: Uint8Array;
      layouts: Map<string, GPUBindGroupLayout>;
      records: Map<string, { map: CasterDisplacement | undefined; record: CasterDisplacement }>;
    }
  >();
  /** TAA's program contract: last frame's bytes of the fur block (`bytes`) are bound beside it at `next`. */
  private readonly program = {
    next: 181,
    buffers: new WeakMap<GPUDevice, { bytes: Uint8Array }>(),
  };
  private readonly rows = new Float32Array(16);
  private readonly key = 'fur:' + serial++;
  constructor({ fur = {}, ...options }: FurMaterialOptions = {}) {
    super(options);
    const defined = Object.fromEntries(Object.entries(fur).filter(([, value]) => value !== undefined));
    this.fur = {
      layer: 0.5,
      length: 0.1,
      density: 64,
      coverage: 0.65,
      gravity: [0, -0.3, 0],
      wind: [0, 0, 0],
      windFrequency: 1,
      time: 0,
      seed: 1,
      rootShade: 0.35,
      ...defined,
    };
    this.pack();
  }
  private pack(): void {
    const o = this.fur;
    scalar(o.layer, 0, 1, 'layer');
    scalar(o.length, 0, 1e6, 'length');
    scalar(o.density, 0, 1e6, 'density');
    scalar(o.coverage, 0, 1, 'coverage');
    scalar(o.windFrequency, 0, 1e6, 'windFrequency');
    scalar(o.time, -1e12, 1e12, 'time');
    scalar(o.seed, 0, 16777215, 'seed');
    scalar(o.rootShade, 0, 1, 'rootShade');
    if (!Number.isInteger(o.seed)) throw new RangeError('Fur seed must be an integer; pass a whole number');
    vector(o.gravity, 'gravity');
    vector(o.wind, 'wind');
    this.rows.set([
      o.layer,
      o.length,
      o.density,
      furRootRadius(o.coverage),
      ...o.gravity,
      0,
      ...o.wind,
      0,
      o.time,
      o.seed,
      o.windFrequency,
      o.rootShade,
    ]);
  }
  private entry(device: GPUDevice): GPUBindGroupEntry {
    this.pack();
    let held = this.buffers.get(device);
    if (!held) {
      const last = new Float32Array(16).fill(NaN);
      held = {
        buffer: device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        last,
        bytes: new Uint8Array(last.buffer),
        layouts: new Map(),
        records: new Map(),
      };
      this.buffers.set(device, held);
      this.program.buffers.set(device, held);
    }
    if (this.rows.some((n, k) => held!.last[k] !== n)) {
      device.queue.writeBuffer(held.buffer, 0, this.rows);
      held.last.set(this.rows);
    }
    return { binding: 180, resource: { buffer: held.buffer } };
  }
  override shader(source: string, group: number): string {
    let code = super.shader(source, group);
    const vertex = /let p=f\.model\*vec4f\(([^;]*),1\);/;
    const clip = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/g;
    code = code
      .replace(vertex, (_line, p: string) => `let p=f.model*vec4f(${p}+margoFurMove(i.normal.xyz,i.uv.xy),1);`)
      .replace(
        clip,
        (found) =>
          `if(margoFurCoverage(i.uv.xy)<0.5){discard;}s.base=vec4f(s.base.rgb*mix(margoFur.clock.w,1.0,margoFur.shape.x),s.base.a);${found}`,
      );
    if (!code.includes('+margoFurMove(') || !code.includes('if(margoFurCoverage('))
      throw new MargoError(
        'unsupported',
        'Fur needs the standard PBR shader; use matching materials and gltf-pro versions',
      );
    return declarations(group) + code;
  }
  override bindings(device: GPUDevice, engine?: Engine): GPUBindGroupEntry[] {
    return [...super.bindings(device, engine), this.entry(device)];
  }
  /** The vertex move of the beauty shader, as WGSL added to the mesh-space position: map displacement, then fur. */
  private static move(mapped: boolean, block = 'margoFur'): string {
    return (
      (mapped ? 'i.normal.xyz*margoDisplacement(i.uv)+' : '') +
      (block === 'margoFur'
        ? 'margoFurMove(i.normal.xyz,i.uv.xy)'
        : `margoFurMoveWith(${block}.shape,${block}.gravity,${block}.wind,${block}.clock,i.normal.xyz,i.uv.xy)`)
    );
  }
  private depth(code: string, group: number, mapped = false): string {
    const out = /var o:(\w+);/.exec(code)?.[1];
    if (!out) throw new MargoError('unsupported', 'Fur needs a standard caster output; use matching effect packages');
    const moved = code
      .replace(
        new RegExp('(struct ' + out + ' \\{[^}]*)\\}'),
        (_all, body: string) =>
          body.trimEnd() + (body.trimEnd().endsWith(',') ? '' : ',') + '@location(7) margoFurUV:vec2f,}',
      )
      .replace('var o:' + out + ';', 'var o:' + out + ';o.margoFurUV=i.uv.xy;')
      .replace('vec4f(i.position.xyz,1)', `vec4f(i.position.xyz+${FurMaterial.move(mapped)},1)`)
      .replace(
        /@fragment fn fragment\((i:\w+)\)([^{]*)\{/,
        (_s, input: string, out: string) =>
          `@fragment fn fragment(${input})${out}{if(margoFurCoverage(i.margoFurUV)<0.5){discard;}`,
      );
    if (!moved.includes('+margoFurMove(') || !moved.includes('if(margoFurCoverage('))
      throw new MargoError('unsupported', 'Fur needs a standard PBR caster shader; use matching effect packages');
    return (mapped ? displacementCode(group) : '') + declarations(group) + moved;
  }
  /** TAA's object velocity shader (taa objectVelocity, graph form): the same move and strand cut as `depth`. */
  private velocity(code: string, group: number, mapped: boolean): string {
    const start = '{var o:Out;';
    const fragment = /@fragment fn fragment\(i:Out\)->Motion \{/;
    if (!code.includes(start) || !fragment.test(code) || !code.includes('@location(3) normal:vec4f'))
      throw new MargoError('unsupported', 'Fur needs the standard TAA velocity shader; use matching taa and materials');
    return (
      (mapped ? displacementCode(group) : '') +
      declarations(group) +
      'alias NdUniforms=MargoFur;\n' +
      code
        .replace(start, `${start}var margoPosition=i.position.xyz+${FurMaterial.move(mapped)};`)
        .replace(fragment, (found) => `${found}if(margoFurCoverage(i.uv.xy)<0.5){discard;}`)
    );
  }
  /**
   * The caster record, kept while the device and `map` (the material's own displacementMap record) stay the same: the
   * fur move on top of the map, the strand cut, and TAA's velocity patch, whose move runs again on last frame's block.
   */
  override caster(device: GPUDevice, _engine?: Engine, map?: CasterDisplacement): CasterDisplacement {
    this.entry(device);
    const held = this.buffers.get(device)!;
    const own = map && map.key === undefined ? map : undefined;
    const key = own ? 'map' : 'fur';
    const kept = held.records.get(key);
    if (kept && kept.map === own) return kept.record;
    const mapped = !!own;
    const record: CasterDisplacement = {
      key: this.key + (mapped ? ':map' : ''),
      cuts: true,
      depth: (code, group) => this.depth(code, group, mapped),
      velocity: (code, group) => this.velocity(code, group, mapped),
      move: [`margoPosition+=${FurMaterial.move(mapped, 'ndu')};`],
      program: this.program,
      entries: () => [
        ...(own
          ? [
              { binding: 0, resource: { buffer: own.buffer } },
              { binding: 1, resource: own.view },
              { binding: 2, resource: own.sampler },
            ]
          : []),
        this.entry(device),
      ],
      layout: () => {
        let layout = held.layouts.get(key);
        if (!layout)
          held.layouts.set(
            key,
            (layout = device.createBindGroupLayout({
              entries: [
                ...(own
                  ? [
                      { binding: 0, visibility: 3, buffer: {} },
                      { binding: 1, visibility: 3, texture: {} },
                      { binding: 2, visibility: 3, sampler: {} },
                    ]
                  : []),
                { binding: 180, visibility: 3, buffer: {} },
              ],
            })),
          );
        return layout;
      },
    };
    held.records.set(key, { map: own, record });
    return record;
  }
  override clone(): this {
    const copy = new FurMaterial({
      shading: this.shading,
      fur: { ...this.fur, gravity: [...this.fur.gravity], wind: [...this.fur.wind] },
    });
    copy.copy(this);
    return copy as this;
  }
  override dispose(): void {
    for (const [device, held] of this.buffers) retire(device, held.buffer);
    this.buffers.clear();
    super.dispose();
  }
}
/** Options for a full shell stack. Shells share geometry and texture objects; each has its own material uniform. */
export interface FurShellOptions extends FurMaterialOptions {
  /** Number of shells, including the solid root. Integer 2 to 128, default 24. */
  shells?: number;
}
/** One shell model with its fur material. */
export type FurShell = MaterialMesh & { material: FurMaterial };
/** Owned shell stack, rooted at shells[0].root. Set time explicitly for deterministic wind. */
export class Fur {
  /** Creates an owned shell stack in this engine. Defaults match the constructor. */
  static attach(engine: EngineKernel, geometry: MeshGeometry, options: FurShellOptions = {}): Fur {
    return new Fur(engine, geometry, options);
  }
  readonly shells: readonly FurShell[];
  readonly root: Mesh;
  private disposed = false;
  constructor(
    engine: EngineKernel,
    geometry: MeshGeometry,
    { shells = 24, fur = {}, ...material }: FurShellOptions = {},
  ) {
    if (!Number.isInteger(shells) || shells < 2 || shells > 128)
      throw new RangeError('Fur shells must be an integer from 2 to 128; pass 24');
    const meshes: FurShell[] = [];
    try {
      for (let k = 0; k < shells; k++) {
        const skin = new FurMaterial({ ...material, fur: { ...fur, layer: k / shells } });
        let mesh: FurShell;
        try {
          mesh = createMesh(engine, geometry, skin) as FurShell;
        } catch (error) {
          skin.dispose();
          throw error;
        }
        meshes.push(mesh);
        if (k) mesh.root.setParent(meshes[0].root);
      }
    } catch (error) {
      for (const mesh of meshes) {
        mesh.dispose();
        mesh.material.dispose();
      }
      throw error;
    }
    this.shells = Object.freeze(meshes);
    this.root = meshes[0].root;
  }
  /** Sets seconds on every shell; identical time and transforms produce identical wind. */
  setTime(seconds: number): this {
    if (this.disposed) throw new MargoError('disposed', 'Fur is disposed; create a new shell stack');
    scalar(seconds, -1e12, 1e12, 'time');
    for (const mesh of this.shells) mesh.material.fur.time = seconds;
    return this;
  }
  /** Validates controls before updating the whole stack; normalized shell heights stay fixed. */
  setOptions(options: Omit<FurOptions, 'layer'>): this {
    if (this.disposed) throw new MargoError('disposed', 'Fur is disposed; create a new shell stack');
    const checked = new FurMaterial({ fur: { ...this.shells[0].material.fur, ...options } });
    for (const mesh of this.shells) Object.assign(mesh.material.fur, checked.fur, { layer: mesh.material.fur.layer });
    checked.dispose();
    return this;
  }
  /** Frees shell models and materials, retaining every caller-owned texture. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let k = this.shells.length - 1; k >= 0; k--) {
      const mesh = this.shells[k];
      mesh.dispose();
      mesh.material.dispose();
    }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Makes a shell-layered fur model with PBR maps, deterministic strands, gravity and wind. */
export function createFur(engine: EngineKernel, geometry: MeshGeometry, options?: FurShellOptions): Fur {
  return new Fur(engine, geometry, options);
}
