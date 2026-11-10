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
fn margoFurMove(n:vec3f,uv:vec2f)->vec3f {
  let layer=margoFur.shape.x;let length=margoFur.shape.y;
  let phase=6.2831853*(margoFur.clock.x*margoFur.clock.z+dot(uv,vec2f(0.73,0.37)));
  let force=margoFur.gravity.xyz+margoFur.wind.xyz*sin(phase);
  return n*(length*layer)+force*(length*layer*layer);
}
fn margoFurCoverage(uv:vec2f)->f32 {
  let layer=margoFur.shape.x;if(layer<=0.0){return 1.0;}
  if(margoFur.shape.z<=0.0){return 0.0;}let cell=uv*margoFur.shape.z;let base=floor(cell);let random=margoFurHash(base);
  let center=vec2f(margoFurHash(base+vec2f(97,13)),margoFurHash(base+vec2f(7,157)))*0.3+0.35;
  let height=0.35+0.65*random;
  let radius=sqrt(margoFur.shape.w/3.14159265)*max(1.0-layer/height,0.0);
  return select(0.0,1.0,layer<height&&distance(fract(cell),center)<radius);
}
`;
let serial = 0;
/**
 * One displaced, cut-out shell of a fur volume. createFur makes a complete stack. PBR maps and lighting stay native;
 * the same strand mask and displacement reach shadow, contact-shadow, selection and depth passes via the caster hook.
 */
export class FurMaterial extends Material {
  readonly fur: Required<FurOptions>;
  private readonly buffers = new Map<
    GPUDevice,
    { buffer: GPUBuffer; last: Float32Array; layout?: GPUBindGroupLayout }
  >();
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
      o.coverage,
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
      held = {
        buffer: device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        last: new Float32Array(16).fill(NaN),
      };
      this.buffers.set(device, held);
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
  private depth(code: string, group: number): string {
    const out = /var o:(\w+);/.exec(code)?.[1];
    if (!out) throw new MargoError('unsupported', 'Fur needs a standard caster output; use matching effect packages');
    const moved = code
      .replace(
        new RegExp('(struct ' + out + ' \\{[^}]*)\\}'),
        (_all, body: string) =>
          body.trimEnd() + (body.trimEnd().endsWith(',') ? '' : ',') + '@location(7) margoFurUV:vec2f,}',
      )
      .replace('var o:' + out + ';', 'var o:' + out + ';o.margoFurUV=i.uv.xy;')
      .replace('vec4f(i.position.xyz,1)', 'vec4f(i.position.xyz+margoFurMove(i.normal.xyz,i.uv.xy),1)')
      .replace(
        /@fragment fn fragment\((i:\w+)\)([^{]*)\{/,
        (_s, input: string, out: string) =>
          `@fragment fn fragment(${input})${out}{if(margoFurCoverage(i.margoFurUV)<0.5){discard;}`,
      );
    if (!moved.includes('+margoFurMove(') || !moved.includes('if(margoFurCoverage('))
      throw new MargoError('unsupported', 'Fur needs a standard PBR caster shader; use matching effect packages');
    return declarations(group) + moved;
  }
  override caster(device: GPUDevice): CasterDisplacement {
    return {
      key: this.key,
      cuts: true,
      depth: (code, group) => this.depth(code, group),
      entries: () => [this.entry(device)],
      layout: () => {
        this.entry(device);
        const held = this.buffers.get(device)!;
        return (held.layout ??= device.createBindGroupLayout({
          entries: [{ binding: 180, visibility: 3, buffer: {} }],
        }));
      },
    };
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
