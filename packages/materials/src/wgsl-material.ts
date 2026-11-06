// A Material whose surface is the caller's WGSL, spliced into gltf-pro's PBR shader through Material.shader() as
// @margoengine/shader's NodeMaterial is (same sites), with the caller's uniforms and textures in group 2.
import { whiteTexture } from '../../shared/white-texture.js';
import type { Engine } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Material, Texture, type MaterialOptions, type TextureDimension } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** `WgslMaterial` options: its WGSL, uniforms and textures, and any other Material option (shading, maps, state). */
export interface WgslMaterialOptions extends MaterialOptions {
  /**
   * WGSL module text. Required: `fn shade(i: Out, s: Surface) -> Surface`, run at the end of the material's surface
   * (before the face and alpha tests) in every pass. Optional: `fn displace(i: Input) -> vec3f`, the mesh-space vertex
   * position. Read the uniforms as `uniforms.<name>` and each texture as `<name>` with its sampler `<name>Sampler`.
   */
  wgsl: string;
  /** Live values by name: a number is an `f32`, 2 to 4 numbers a `vec2f` to `vec4f`. */
  uniforms?: Readonly<Record<string, number | readonly number[]>>;
  /**
   * Textures by name (a Texture's own colour space wins; sRGB otherwise), live: assign another Texture of the same
   * dimension to swap. Each is declared by its `dimension`: `texture_2d<f32>`, `texture_2d_array<f32>`,
   * `texture_3d<f32>` or `texture_cube<f32>`. 32-bit float textures filter only on devices with `float32-filterable`;
   * elsewhere read them with `textureLoad`.
   */
  textures?: Readonly<Record<string, Texture>>;
}
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/,
  // Module-scope names of gltf-pro's shader and of this package's patches, and the two entry points.
  taken =
    /^(?:f|uv|surface|ambient|hemisphere_ambient|direct_light|layers|ggx|uniforms|shade|displace|fragment|gbuffer|vertex|(?:base|mr|normal|ao|emissive)(?:Map|Sampler)|margo\w*|mat_\w*|nd\w*|cluster\w*|shadow\w*)$/,
  fragmentSite = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/,
  vertexSite = /let p=f\.model\*vec4f\(([^;]*),1\);/;
/** WGSL texture type of each dimension. */
const types: Record<TextureDimension, string> = {
  '2d': 'texture_2d<f32>',
  '2d-array': 'texture_2d_array<f32>',
  '3d': 'texture_3d<f32>',
  cube: 'texture_cube<f32>',
};
function name(label: string, key: string): string {
  if (!identifier.test(key) || taken.test(key))
    throw new TypeError(
      `WgslMaterial ${label} name '${key}' is not usable; pass a WGSL identifier not used by the PBR shader (not f, uv, surface, a margo prefix, ...)`,
    );
  return key;
}
/** The component count of uniform value `v`: a number (1) or 2 to 4 finite numbers. */
const components = (v: unknown, key: string): number => {
  const list = typeof v === 'number' ? [v] : Array.isArray(v) || v instanceof Float32Array ? Array.from(v) : undefined;
  if (!list || (typeof v !== 'number' && (list.length < 2 || list.length > 4)))
    throw new TypeError(`WgslMaterial uniform '${key}' must be a number or 2 to 4 numbers; pass one of those`);
  if (!list.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x))))
    throw new RangeError(`WgslMaterial uniform '${key}' must be finite as float32; pass finite numbers`);
  return list.length;
};

/**
 * A Material whose surface is your WGSL (`wgsl`), with your `uniforms` and `textures`; every other Material option
 * applies (shading, maps, render state, features). The WGSL is fixed at construction and checked for its entry points
 * and names (TypeError, RangeError); WGSL compile errors come from WebGPU's own validation when the shader is first
 * drawn. Uniform values and textures stay live.
 */
export class WgslMaterial extends Material {
  readonly wgsl: string;
  /** Live uniforms: `material.uniforms.time = 2`, or write an array uniform's elements in place. Types are fixed. */
  readonly uniforms: Record<string, number | Float32Array>;
  /** Live textures: assign another Texture under the same name. */
  readonly textures: Record<string, Texture>;
  private readonly sizes: Record<string, number> = {};
  private data: Float32Array;
  private readonly buffers = new WeakMap<GPUDevice, GPUBuffer>();
  /** The patched shader per gltf-pro source (and its group). */
  private readonly patched = new Map<string, [number, string]>();
  constructor(options: WgslMaterialOptions) {
    const { wgsl, uniforms = {}, textures = {}, ...rest } = options ?? ({} as WgslMaterialOptions);
    super(rest);
    if (
      typeof wgsl !== 'string' ||
      !/\bfn\s+shade\s*\(\s*\w+\s*:\s*Out\s*,\s*\w+\s*:\s*Surface\s*\)\s*->\s*Surface\b/.test(wgsl)
    )
      throw new TypeError('WgslMaterial wgsl must define fn shade(i: Out, s: Surface) -> Surface; add that function');
    if (/\bfn\s+displace\b/.test(wgsl) && !/\bfn\s+displace\s*\(\s*\w+\s*:\s*Input\s*\)\s*->\s*vec3f\b/.test(wgsl))
      throw new TypeError('WgslMaterial displace must be fn displace(i: Input) -> vec3f; fix its signature');
    this.wgsl = wgsl;
    const keys = Object.keys(uniforms).map((k) => name('uniform', k));
    keys.forEach((k) => (this.sizes[k] = components(uniforms[k], k)));
    this.data = new Float32Array(Math.max(4, keys.length * 4));
    this.uniforms = this.uniformAccess(keys);
    this.textures = this.textureAccess({ ...textures });
    for (const k of keys) this.uniforms[k] = uniforms[k] as number;
  }
  private uniformAccess(keys: string[]): Record<string, number | Float32Array> {
    const out = {};
    keys.forEach((key, k) =>
      Object.defineProperty(out, key, {
        enumerable: true,
        get: () => (this.sizes[key] === 1 ? this.data[k * 4] : this.data.subarray(k * 4, k * 4 + this.sizes[key])),
        set: (v: number | readonly number[]) => {
          if (components(v, key) !== this.sizes[key])
            throw new TypeError(
              `WgslMaterial uniform '${key}' has ${this.sizes[key]} component(s); assign the same number`,
            );
          this.data.set(typeof v === 'number' ? [v] : v, k * 4);
        },
      }),
    );
    return Object.seal(out);
  }
  private textureAccess(textures: Record<string, Texture>): Record<string, Texture> {
    const out = {},
      store: Record<string, Texture> = {};
    for (const key of Object.keys(textures)) {
      if (key in this.sizes) throw new TypeError(`WgslMaterial texture '${key}' is also a uniform; rename one`);
      name('texture', key);
      Object.defineProperty(out, key, {
        enumerable: true,
        get: () => store[key],
        set: (v: Texture) => {
          if (!(v instanceof Texture)) throw new TypeError(`WgslMaterial texture '${key}' must be a Texture; pass one`);
          // The WGSL declares each texture by its dimension, fixed at construction.
          if (store[key] && v.dimension !== store[key].dimension)
            throw new TypeError(
              `WgslMaterial texture '${key}' is a ${store[key].dimension} texture; assign a ${store[key].dimension} Texture`,
            );
          store[key] = v;
        },
      });
      (out as Record<string, Texture>)[key] = textures[key];
    }
    return Object.seal(out);
  }
  /** A new WgslMaterial with this one's values (its own uniforms), sharing the textures. */
  override clone(): this {
    const c = super.clone(),
      w: WgslMaterial = c;
    w.data = this.data.slice();
    Object.assign(w, {
      uniforms: w.uniformAccess(Object.keys(this.sizes)),
      textures: w.textureAccess({ ...this.textures }),
      buffers: new WeakMap(),
    });
    return c;
  }
  override shader(source: string, group: number): string {
    const base = super.shader(source, group),
      hit = this.patched.get(base);
    if (hit?.[0] === group) return hit[1];
    const names = Object.keys(this.textures);
    let count = 0;
    let code = base
      .replace(fragmentSite, (site) => {
        count++;
        return 's=shade(i,s);\n  ' + site;
      })
      .replace('fn surface(i:Out,front:bool)->Surface {', (head) => {
        count++;
        // Every binding stays in each entry point's layout, used by the WGSL or not.
        return `${head}\n  ${Object.keys(this.sizes).length ? '_=&uniforms;' : ''}${names.map((n) => `_=${n};_=${n}Sampler;`).join('')}`;
      });
    if (/\bfn\s+displace\b/.test(this.wgsl))
      code = code.replace(vertexSite, () => {
        count++;
        return 'let p=f.model*vec4f(displace(i),1);';
      });
    if (count !== (/\bfn\s+displace\b/.test(this.wgsl) ? 3 : 2))
      throw new MargoError(
        'unsupported',
        'WgslMaterial requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
      );
    const keys = Object.keys(this.sizes),
      type = (n: number) => (n === 1 ? 'f32' : `vec${n}f`),
      declarations =
        (keys.length
          ? `struct WgslUniforms {${keys.map((k) => `@align(16) ${k}:${type(this.sizes[k])}`).join(', ')}}\n@group(${group}) @binding(48) var<uniform> uniforms:WgslUniforms;\n`
          : '') +
        names
          .map(
            (n, k) =>
              `@group(${group}) @binding(${50 + k * 2}) var ${n}:${types[this.textures[n].dimension]};\n@group(${group}) @binding(${51 + k * 2}) var ${n}Sampler:sampler;\n`,
          )
          .join('');
    code = `${declarations}${code}\n${this.wgsl}\n`;
    if (this.patched.size >= 16) this.patched.clear();
    this.patched.set(base, [group, code]);
    return code;
  }
  override bindings(device: GPUDevice, engine?: Engine): GPUBindGroupEntry[] {
    const entries = super.bindings(device, engine);
    if (Object.keys(this.sizes).length) {
      let buffer = this.buffers.get(device);
      if (!buffer)
        this.buffers.set(
          device,
          (buffer = device.createBuffer({
            size: this.data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })),
        );
      device.queue.writeBuffer(buffer, 0, this.data as Float32Array<ArrayBuffer>);
      entries.push({ binding: 48, resource: { buffer } });
    }
    Object.values(this.textures).forEach((texture, k) => {
      const [view, sampler] = texture.bind(device, true) ?? whiteTexture(device, texture.dimension);
      entries.push({ binding: 50 + k * 2, resource: view }, { binding: 51 + k * 2, resource: sampler });
    });
    return entries;
  }
}
