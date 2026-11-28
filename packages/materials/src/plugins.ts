// Material plugins: your WGSL at named points of the stock PBR shader (gltf/pbr through this package's Material), with
// your own uniforms and textures, several per material in list order. Each plugin is a MaterialFeature; the first plugin
// of a material composes them all, so their functions, bindings and the shared vertex chain are written once. The vertex
// move is the same text in the colour pass and in every depth pass (shadows, picking, TAA velocity), through the
// material's caster record. Composing shader parts at named points with their own parameters follows M. McGuire,
// G. Stathis, H. Pfister and S. Krishnamurthi, "Abstract Shade Trees" (I3D 2006, https://doi.org/10.1145/1111411.1111425);
// Y. He, T. Foley, T. Hofstee, H. Long and K. Fatahalian, "Shader Components: Modular and High Performance Shader
// Development" (ACM TOG 36(4), 2017, https://research.nvidia.com/publication/2017-08_shader-components-modular-and-high-performance-shader-development);
// Y. He, K. Fatahalian and T. Foley, "Slang: Language Mechanisms for Extensible Real-time Shading Systems" (ACM TOG
// 37(4), 2018, https://research.nvidia.com/publication/2018-08_slang-language-mechanisms-extensible-real-time-shading-systems).
// From them: each plugin is a closed function with a typed interface at its point (no free edits of the host text), its
// parameters live in a block of their own bound per component, and the composition is ordered and keyed by identity.
import { whiteTexture } from '../../shared/white-texture.js';
import { displacementCode, reboundCaster } from '../../shared/displacement.js';
import type { CasterDisplacement } from '../../shared/caster.js';
import { MargoError } from '@margoengine/math/errors';
import type { Material, MaterialFeature, Texture } from './built-material.js';
import type { MaterialValueCodec } from './serialization.js';
import type { InstanceAttributes, InstanceAttributeSchema } from './instance-attributes.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** The named points of the stock PBR shader a plugin's WGSL runs at. Each is the body of a function; see the README. */
export interface MaterialPluginPoints {
  /** Mesh-space vertex, before the model and instance matrices: edit `var position: vec3f` and `var normal: vec3f`. Runs in the colour pass and every depth pass. */
  vertex?: string;
  /** The surface before lighting and before the face and alpha tests: edit `var s: Surface` (`base`, `n`, `roughness`, `metal`, `occlusion`, `emissive`); read `i: Out` (`position`, `normal`, `color`, ...). */
  surface?: string;
  /** After all light is summed, before fog and tone mapping: edit `var color: vec3f` (linear radiance); read `i`, `s` and `v` (unit vector to the eye). */
  light?: string;
  /** Last, before the pass writes: edit `var color: vec3f` (display-encoded when the engine tone-maps in the shader); read `i`, `s`, `v`. */
  output?: string;
}
/** The values a plugin's `uniforms` are declared with, by name. */
export type MaterialPluginValues = Record<string, number | readonly number[]>;
/** What a declared uniform reads as: a number stays a number, an array is a fixed-size Float32Array. */
export type MaterialPluginUniform<V> = V extends number ? number : Float32Array;
/** `materialPlugin()` options. */
export interface MaterialPluginOptions<U extends MaterialPluginValues = MaterialPluginValues>
  extends MaterialPluginPoints {
  /** WGSL identifier naming the plugin (letters and digits): its uniforms read as `<name>.<uniform>`, its textures as `<name>_<texture>`. One plugin of each name per material. */
  name: string;
  /** Live values by name: a number is an `f32`, 2 to 4 numbers a `vec2f` to `vec4f`. Default none. */
  uniforms?: Readonly<U>;
  /** Up to 4 filterable textures by name, read as `<name>_<texture>` with `<name>_<texture>Sampler` (use `textureSampleLevel` in `vertex`). Live: assign another Texture of the same dimension. Default none. */
  textures?: Readonly<Record<string, Texture>>;
  /** Module-scope WGSL helpers (functions, constants); prefix their names with the plugin's name. Default none. */
  declarations?: string;
  /** Per-instance values (`instanceAttributes()` of `/instance-attributes`), read at every point as `<name>_<attribute>`. Fixed at creation; their values stay live. Default none. */
  instanceAttributes?: InstanceAttributes<InstanceAttributeSchema>;
}
/** What `materialPlugin()` returns: a material feature with live uniforms and textures. */
export interface MaterialPlugin<U extends MaterialPluginValues = MaterialPluginValues> extends MaterialFeature {
  /** The plugin's own name (the feature's `name` is `plugin:<name>`). */
  readonly pluginName: string;
  /** The WGSL, fixed at creation; make a new plugin to change it. */
  readonly code: Readonly<MaterialPluginPoints & { declarations?: string }>;
  /** Live uniforms: `plugin.uniforms.time = 2`, or write an array uniform's elements in place. Sizes are fixed. */
  readonly uniforms: { -readonly [K in keyof U]: MaterialPluginUniform<U[K]> };
  /** Live textures: assign another Texture of the same dimension under the same name. */
  readonly textures: Record<string, Texture>;
  /** The per-instance values this plugin reads, when it was given any. */
  readonly instanceAttributes?: InstanceAttributes<InstanceAttributeSchema>;
}

const help = '; see https://margoengine.com/errors#material-plugins',
  points = ['vertex', 'surface', 'light', 'output'] as const,
  known = new Set<string>([...points, 'name', 'uniforms', 'textures', 'declarations', 'instanceAttributes']),
  identifier = /^[A-Za-z][A-Za-z0-9]*$/,
  // Module-scope names of the PBR shader and its patches, the locals each point gives, and WGSL keywords and types.
  taken =
    /^(?:f|i|s|v|o|p|uv|color|position|normal|front|surface|ambient|hemisphere_ambient|direct_light|layers|ggx|uniforms|shade|displace|fragment|gbuffer|vertex|transparent|capture|(?:base|mr|normal|ao|emissive)(?:Map|Sampler)|margo\w*|mat_\w*|nd\w*|cluster\w*|shadow\w*|alias|break|case|const|continue|continuing|default|diagnostic|discard|else|enable|false|fn|for|if|let|loop|override|requires|return|struct|switch|true|var|while|bool|f16|f32|i32|u32|vec[234][fiuh]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler|texture\w*)$/,
  MAX_PLUGINS = 8,
  MAX_TEXTURES = 4,
  // Binding of plugin k (its place among a material's plugins) in the material's group: a block of 16 from 300, its
  // instance attributes after the uniforms and texture pairs.
  first = (k: number) => 300 + 16 * k,
  ROWS = 1 + 2 * MAX_TEXTURES,
  types: Record<string, string> = {
    '2d': 'texture_2d<f32>',
    '2d-array': 'texture_2d_array<f32>',
    '3d': 'texture_3d<f32>',
    cube: 'texture_cube<f32>',
  },
  surfaceSite = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/,
  surfaceHead = 'fn surface(i:Out,front:bool)->Surface {',
  chainStart = 'var margoPV=MargoPluginVertex(i.position.xyz,i.normal.xyz);';

function checkName(label: string, key: string): string {
  if (typeof key !== 'string' || !identifier.test(key) || taken.test(key))
    throw new TypeError(
      `Material plugin ${label} '${String(key)}' is not usable; pass letters and digits starting with a letter, not a WGSL keyword or a name the PBR shader uses (f, s, color, margo...)${help}`,
    );
  return key;
}
const components = (v: unknown, key: string): number => {
  const list = typeof v === 'number' ? [v] : Array.isArray(v) || v instanceof Float32Array ? Array.from(v) : undefined;
  if (!list || (typeof v !== 'number' && (list.length < 2 || list.length > 4)))
    throw new TypeError(
      `Material plugin uniform '${key}' must be a number or 2 to 4 numbers; pass one of those${help}`,
    );
  if (!list.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x))))
    throw new RangeError(`Material plugin uniform '${key}' must be finite as float32; pass finite numbers${help}`);
  return list.length;
};
/**
 * A Texture of this package, told by its shape so this entry does not import the Texture class (and the material code
 * that comes with it): what plugins call of it is `bind` and `dimension`.
 */
const isTexture = (v: unknown): v is Texture =>
  typeof v === 'object' &&
  v !== null &&
  typeof Reflect.get(v, 'bind') === 'function' &&
  Reflect.get(v, 'dimension') in types;
const unsupported = (what: string) =>
  new MargoError(
    'unsupported',
    `Material plugin ${what} needs the standard PBR shader; use matching @margoengine/materials and gltf/pbr versions${help}`,
  );

/** Internal state of one plugin, reached from its feature object. */
interface State {
  /** Names the plugin in shader and caster caches; renewed when its GPU buffers are freed. */
  id: number;
  readonly name: string;
  readonly code: MaterialPluginPoints & { declarations?: string };
  readonly sizes: Record<string, number>;
  readonly keys: string[];
  readonly data: Float32Array;
  readonly textures: Record<string, Texture>;
  readonly buffers: Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>;
  readonly rows: InstanceAttributes<InstanceAttributeSchema> | undefined;
}
const states = new WeakMap<MaterialFeature, State>();
let nextId = 1;
/** The plugins of `m`, in its feature order. */
const pluginsOf = (m: Material): State[] => m.features.flatMap((v) => states.get(v) ?? []);

/** The uniform buffer of `p` on `device`, with this frame's values (a steady plugin uploads nothing). */
function uniformBuffer(p: State, device: GPUDevice): GPUBuffer {
  let held = p.buffers.get(device);
  if (!held)
    p.buffers.set(
      device,
      (held = {
        buffer: device.createBuffer({
          size: p.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        last: new Float32Array(p.data.length).fill(Number.NaN),
      }),
    );
  if (p.data.some((v, k) => v !== held.last[k])) {
    device.queue.writeBuffer(held.buffer, 0, p.data as Float32Array<ArrayBuffer>);
    held.last.set(p.data);
  }
  return held.buffer;
}
/** Bind group entries of `p`, plugin `k` of its material. */
function entriesOf(p: State, k: number, device: GPUDevice): GPUBindGroupEntry[] {
  const base = first(k),
    out: GPUBindGroupEntry[] = p.keys.length ? [{ binding: base, resource: { buffer: uniformBuffer(p, device) } }] : [];
  Object.values(p.textures).forEach((texture, j) => {
    const [view, sampler] = texture.bind(device, true) ?? whiteTexture(device, texture.dimension);
    out.push({ binding: base + 1 + 2 * j, resource: view }, { binding: base + 2 + 2 * j, resource: sampler });
  });
  if (p.rows) out.push(p.rows.entry(device, base + ROWS));
  return out;
}
/** Resource declarations, helpers and point functions of `p`, plugin `k`, in `group`; `only` limits the points. */
function declare(p: State, k: number, group: number, only: readonly (typeof points)[number][] = points): string {
  const base = first(k),
    n = p.name,
    type = (c: number) => (c === 1 ? 'f32' : `vec${c}f`);
  let out = p.keys.length
    ? `struct MargoPlugin_${n} {${p.keys.map((key) => `@align(16) ${key}:${type(p.sizes[key])}`).join(', ')}}\n@group(${group}) @binding(${base}) var<uniform> ${n}:MargoPlugin_${n};\n`
    : '';
  Object.keys(p.textures).forEach((key, j) => {
    out += `@group(${group}) @binding(${base + 1 + 2 * j}) var ${n}_${key}:${types[p.textures[key].dimension]};\n@group(${group}) @binding(${base + 2 + 2 * j}) var ${n}_${key}Sampler:sampler;\n`;
  });
  if (p.rows) out += p.rows.declare(n, group, base + ROWS);
  if (p.code.declarations) out += p.code.declarations + '\n';
  const c = p.code;
  if (c.vertex && only.includes('vertex'))
    out += `fn margoPlugin_${n}_vertex(p0:vec3f,n0:vec3f)->MargoPluginVertex {var position=p0;var normal=n0;{\n${c.vertex}\n}return MargoPluginVertex(position,normal);}\n`;
  if (c.surface && only.includes('surface'))
    out += `fn margoPlugin_${n}_surface(i:Out,s0:Surface)->Surface {var s=s0;{\n${c.surface}\n}return s;}\n`;
  for (const point of ['light', 'output'] as const)
    if (c[point] && only.includes(point))
      out += `fn margoPlugin_${n}_${point}(i:Out,s:Surface,v:vec3f,c0:vec3f)->vec3f {var color:vec3f=c0;{\n${c[point]}\n}return color;}\n`;
  return out;
}
/** Phony uses of every binding of `list`, so each entry point's automatic layout keeps them. */
const phony = (list: readonly State[]) =>
  list
    .map(
      (p) =>
        (p.keys.length ? `_=${p.name};` : '') +
        Object.keys(p.textures)
          .map((key) => `_=${p.name}_${key};_=${p.name}_${key}Sampler;`)
          .join(''),
    )
    .join('');
/** The vertex function body of `code` as [start of body, end of body] (after `{`, at the matching `}`). */
function vertexBody(code: string): [number, number] | undefined {
  const head = code.indexOf('@vertex fn vertex(');
  if (head < 0) return undefined;
  const open = code.indexOf('{', head);
  if (open < 0) return undefined;
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return [open + 1, k];
  }
  return undefined;
}
/**
 * The vertex chain of `list` (plugins with vertex code): `margoPV` from the mesh position and normal through each, each
 * after its instance attributes of row `row` are loaded.
 */
const chain = (list: readonly State[], row: string) =>
  chainStart +
  list
    .map(
      (p) =>
        (p.rows ? `margoInstanceLoad_${p.name}(${row});` : '') +
        `margoPV=margoPlugin_${p.name}_vertex(margoPV.position,margoPV.normal);`,
    )
    .join('');
/**
 * `code` with its vertex stage reading the plugins' moved position and normal in place of the mesh's: every
 * `i.position.xyz` and `i.normal.xyz` of the vertex body, after the chain at its start (and `extra`). The moved normal
 * is `margoNormal`, the name gltf/pbr's instancing and a NodeMaterial's normal move already read; a body that declares
 * one of its own (a NodeMaterial graph) reads `margoPV.normal` inside it instead.
 */
function moveVertex(code: string, list: readonly State[], row: string, extra = ''): string {
  const body = vertexBody(code);
  if (!body || !/\bnormal:vec4f/.test(code) || !code.slice(body[0], body[1]).includes('i.position.xyz'))
    throw unsupported('vertex');
  const before = code.slice(body[0], body[1]),
    own = /\bmargoNormal\b/.test(before),
    inner = before
      .replaceAll('i.position.xyz', 'margoPV.position')
      .replaceAll('i.normal.xyz', own ? 'margoPV.normal' : 'margoNormal');
  return (
    code.slice(0, body[0]) +
    chain(list, row) +
    extra +
    (own ? '' : 'let margoNormal=margoPV.normal;') +
    inner +
    code.slice(body[1])
  );
}
const vertexStruct = 'struct MargoPluginVertex {position:vec3f, normal:vec3f}\n';

/** The beauty shader edit of a material's plugins `list` (composed once, by the first plugin). */
function composeShader(code: string, group: number, list: readonly State[]): string {
  if (list.length > MAX_PLUGINS)
    throw new RangeError(`A material takes at most ${MAX_PLUGINS} plugins; merge some of them${help}`);
  if (!code.includes(surfaceHead) || !surfaceSite.test(code)) throw unsupported('surface');
  const moved = list.filter((p) => p.code.vertex);
  let out = code.replace(surfaceHead, () => `${surfaceHead}\n  ${phony(list)}`);
  const calls = list
    .filter((p) => p.code.surface)
    .map((p) => `s=margoPlugin_${p.name}_surface(i,s);`)
    .join('');
  if (calls) out = out.replace(surfaceSite, (site) => calls + '\n  ' + site);
  if (moved.length) out = moveVertex(out, moved, 'i.ndInstance');
  const instanced = list.filter((p) => p.rows);
  if (instanced.length)
    out = instanced[0].rows!.host(
      out,
      instanced.filter((p) => p.code.surface || p.code.light || p.code.output).map((p) => p.name),
    );
  return (
    (moved.length ? vertexStruct : '') +
    list.map((p, k) => declare(p, k, group, ['vertex', 'surface', 'light', 'output'])).join('') +
    out
  );
}
/**
 * The lit shader edit: light after the summed colour, output before the fragment's return. The point functions declare
 * `var color:vec3f`, so no `var color=` site of the host (this one, lighting effects, env maps) lands in them.
 */
function composeLit(code: string, list: readonly State[]): string {
  let out = code;
  const light = list.filter((p) => p.code.light).map((p) => `color=margoPlugin_${p.name}_light(i,s,v,color);`),
    output = list.filter((p) => p.code.output).map((p) => `color=margoPlugin_${p.name}_output(i,s,v,color);`);
  if (light.length) {
    const sum = /var color=[^;]*;/.exec(out)?.[0];
    if (!sum) throw unsupported('light');
    out = out.replace(sum, () => sum + light.join(''));
  }
  if (output.length) {
    if (!out.includes('return vec4f(color,')) throw unsupported('output');
    out = out
      .replace('return vec4f(color,', () => output.join('') + 'return vec4f(color,')
      // Unlit, normal and matcap shadings return before the lit code: their colour goes through the point there.
      .replace(
        /return vec4f\(((?:mat_out|normalize)\(.*?),alpha\);/g,
        (_, own: string) =>
          `{let v=normalize(f.eye.xyz-i.position);var color:vec3f=${own};${output.join('')}return vec4f(color,alpha);}`,
      );
  }
  return out;
}

/**
 * Caster records of a material, kept while the device, its plugin list, its displacement map and what the vertex plugins
 * bind stay the same: depth passes keep a bind group for as long as they see the same record.
 */
interface CasterState {
  device: GPUDevice;
  key: string;
  map: CasterDisplacement | undefined;
  record: CasterDisplacement;
  /** The buffers, views and samplers the record's bind groups hold. */
  readonly bound: unknown[];
  layout?: GPUBindGroupLayout;
}
const casters = new WeakMap<Material, CasterState>();
/** What depth passes draw for the vertex plugins of `m` (after its own `displacementMap`, `map`), or undefined. */
function casterOf(m: Material, device: GPUDevice, map: CasterDisplacement | undefined): CasterDisplacement | undefined {
  const list = pluginsOf(m),
    moved = list.filter((p) => p.code.vertex);
  if (!moved.length) return undefined;
  // A map with a key is a subclass's own move; plugins build on a plain displacementMap only.
  const own = map && map.key === undefined ? map : undefined,
    key = 'plugins:' + list.map((p) => p.id).join(',') + (own ? ':map' : '');
  const used = list.flatMap((p, k) => (p.code.vertex ? [[p, k] as const] : []));
  // Gathering the entries also uploads what the depth passes read: a caster the colour pass skips has no other upload.
  const gather = () => used.flatMap(([p, k]) => entriesOf(p, k, device)),
    kept = casters.get(m);
  if (kept && kept.device === device && kept.key === key && kept.map === own) {
    // Once a pass has bound them, a swapped or rebuilt texture takes a new record, so every pass binds it afresh.
    if (kept.bound.length && reboundCaster(gather(), kept.bound)) kept.record = { ...kept.record };
    return kept.record;
  }
  const bound: unknown[] = [];
  const declarations = (group: number) =>
    (own ? displacementCode(group) : '') +
    vertexStruct +
    used.map(([p, k]) => declare(p, k, group, ['vertex'])).join('');
  // The map moves along the moved normal after the plugins, as the colour pass does.
  const mapMove = own ? 'margoPV.position+=margoPV.normal*margoDisplacement(i.uv);' : '';
  // A depth pass reads its row from the built-in itself: it draws a primitive's instances in row order.
  const withRow = (code: string) => {
    if (!moved.some((p) => p.rows)) return code;
    const entry = '@vertex fn vertex(';
    if (!code.includes(entry)) throw unsupported('vertex');
    return code.replace(entry, `${entry}@builtin(instance_index) margoRow:u32,`);
  };
  const state: CasterState = {
    device,
    key,
    map: own,
    bound,
    record: {
      key,
      cuts: false,
      depth: (code: string, group: number) =>
        declarations(group) + withRow(moveVertex(code, moved, 'margoRow', phony(moved) + mapMove)),
      velocity: (code: string, group: number) => {
        const start = '{var o:Out;';
        if (!code.includes(start) || !/\bnormal:vec4f/.test(code)) throw unsupported('vertex');
        return (
          declarations(group) +
          withRow(code).replace(
            start,
            () => `${start}${chain(moved, 'margoRow')}${phony(moved)}${mapMove}let margoPosition=margoPV.position;`,
          )
        );
      },
      entries: () => {
        const plugins = gather();
        if (!bound.length) reboundCaster(plugins, bound);
        return [
          ...(own
            ? [
                { binding: 0, resource: { buffer: own.buffer } },
                { binding: 1, resource: own.view },
                { binding: 2, resource: own.sampler },
              ]
            : []),
          ...plugins,
        ];
      },
      layout: () =>
        (state.layout ??= device.createBindGroupLayout({
          entries: [
            ...(own
              ? [
                  { binding: 0, visibility: 3, buffer: {} },
                  { binding: 1, visibility: 3, texture: {} },
                  { binding: 2, visibility: 3, sampler: {} },
                ]
              : []),
            ...used.flatMap(([p, k]) => [
              ...(p.keys.length ? [{ binding: first(k), visibility: 3, buffer: {} }] : []),
              ...(p.rows
                ? [{ binding: first(k) + ROWS, visibility: 3, buffer: { type: 'read-only-storage' as const } }]
                : []),
              ...Object.values(p.textures).flatMap((t, j) => [
                {
                  binding: first(k) + 1 + 2 * j,
                  visibility: 3,
                  texture: { viewDimension: t.dimension as GPUTextureViewDimension },
                },
                { binding: first(k) + 2 + 2 * j, visibility: 3, sampler: {} },
              ]),
            ]),
          ],
        })),
    } as CasterDisplacement,
  };
  casters.set(m, state);
  return state.record;
}

/**
 * A material plugin: your WGSL at named points of the stock PBR shader (`vertex`, `surface`, `light`, `output`), with
 * your own `uniforms` and `textures`. Put it in a `PbrMaterial`'s (or any Material's) `features`; several plugins run
 * in list order. The WGSL and names are fixed and checked here (TypeError, RangeError); uniforms and textures stay live.
 * WGSL compile errors come from WebGPU's validation when the shader first draws.
 */
export function materialPlugin<U extends MaterialPluginValues = MaterialPluginValues>(
  options: MaterialPluginOptions<U>,
): MaterialPlugin<U> {
  if (!options || typeof options !== 'object')
    throw new TypeError(`materialPlugin needs an options object with a name and WGSL for a point${help}`);
  for (const key of Object.keys(options))
    if (!known.has(key))
      throw new TypeError(
        `Material plugin option '${key}' is unknown; use name, uniforms, textures, declarations, vertex, surface, light or output${help}`,
      );
  const { name, textures = {}, declarations } = options,
    uniforms: MaterialPluginValues = options.uniforms ?? {};
  checkName('name', name);
  const code: MaterialPluginPoints & { declarations?: string } = {};
  for (const point of [...points, 'declarations'] as const) {
    const text = options[point];
    if (text === undefined) continue;
    if (typeof text !== 'string')
      throw new TypeError(`Material plugin '${name}' ${point} must be WGSL text; pass a string${help}`);
    code[point] = text;
  }
  if (!points.some((point) => code[point]))
    throw new TypeError(`Material plugin '${name}' has no code; give WGSL for vertex, surface, light or output${help}`);
  if (declarations !== undefined && /@(?:group|binding)\s*\(/.test(declarations))
    throw new TypeError(
      `Material plugin '${name}' declarations may not bind resources; use uniforms and textures${help}`,
    );
  const rows = options.instanceAttributes;
  if (rows !== undefined && (typeof Reflect.get(Object(rows), 'entry') !== 'function' || !rows.types))
    throw new TypeError(
      `Material plugin '${name}' instanceAttributes must come from instanceAttributes(); pass that object${help}`,
    );
  const keys = Object.keys(uniforms).map((k) => checkName('uniform', k)),
    sizes: Record<string, number> = {};
  for (const k of keys) sizes[k] = components(uniforms[k], k);
  const textureKeys = Object.keys(textures).map((k) => checkName('texture', k));
  if (textureKeys.length > MAX_TEXTURES)
    throw new RangeError(
      `Material plugin '${name}' takes at most ${MAX_TEXTURES} textures; pack channels together${help}`,
    );
  // An attribute reads as `<name>_<attribute>`, in the namespace of the textures and of the PBR shader's own names.
  for (const k of Object.keys(rows?.types ?? {}))
    if (textureKeys.some((t) => k === t || k === t + 'Sampler') || taken.test(`${name}_${k}`))
      throw new TypeError(
        `Material plugin instance attribute '${k}' reads as '${name}_${k}', a texture's or the PBR shader's name; rename one${help}`,
      );
  for (const k of textureKeys) {
    if (k in sizes) throw new TypeError(`Material plugin texture '${k}' is also a uniform; rename one${help}`);
    if (!isTexture(textures[k]))
      throw new TypeError(`Material plugin texture '${k}' must be a Texture; pass one${help}`);
  }
  const data = new Float32Array(Math.max(4, keys.length * 4)),
    liveUniforms = {},
    liveTextures = {},
    store: Record<string, Texture> = { ...textures };
  keys.forEach((key, k) =>
    Object.defineProperty(liveUniforms, key, {
      enumerable: true,
      get: () => (sizes[key] === 1 ? data[k * 4] : data.subarray(k * 4, k * 4 + sizes[key])),
      set: (v: number | readonly number[]) => {
        if (components(v, key) !== sizes[key])
          throw new TypeError(
            `Material plugin uniform '${key}' has ${sizes[key]} component(s); assign the same number${help}`,
          );
        data.set(typeof v === 'number' ? [v] : v, k * 4);
      },
    }),
  );
  for (const key of textureKeys)
    Object.defineProperty(liveTextures, key, {
      enumerable: true,
      get: () => store[key],
      set: (v: Texture) => {
        if (!isTexture(v) || v.dimension !== store[key].dimension)
          throw new TypeError(
            `Material plugin texture '${key}' is a ${store[key].dimension} Texture; assign a ${store[key].dimension} Texture${help}`,
          );
        store[key] = v;
      },
    });
  for (const k of keys) (liveUniforms as Record<string, unknown>)[k] = uniforms[k];
  const state: State = {
    id: nextId++,
    name,
    code: Object.freeze(code),
    sizes,
    keys,
    data,
    textures: store,
    buffers: new Map(),
    rows,
  };
  let users = 0;
  const cached = new Map<string, string>();
  const feature: MaterialPlugin<U> = {
    name: 'plugin:' + name,
    pluginName: name,
    code: state.code,
    uniforms: Object.seal(liveUniforms) as MaterialPlugin<U>['uniforms'],
    textures: Object.seal(liveTextures) as Record<string, Texture>,
    instanceAttributes: rows,
    // Read by GPU cullers and sorters: reordered instance rows would give instances each other's values.
    instanceRows: !!rows,
    shader(source, group, material) {
      const list = pluginsOf(material);
      if (list[0] !== state) return source;
      const id = group + ':' + list.map((p) => p.id).join(',') + ':' + source;
      let out = cached.get(id);
      if (out === undefined) {
        out = composeShader(source, group, list);
        if (cached.size >= 16) cached.clear();
        cached.set(id, out);
      }
      return out;
    },
    lit(source, material) {
      const list = pluginsOf(material);
      return list[0] === state ? composeLit(source, list) : source;
    },
    bindings(device, _owner, material) {
      const k = pluginsOf(material).indexOf(state);
      return k < 0 ? [] : entriesOf(state, k, device);
    },
    caster(device, material, map) {
      return pluginsOf(material)[0] === state ? casterOf(material, device, map) : undefined;
    },
    attach() {
      if (!users) rows?.retain();
      users++;
    },
    detach() {
      if (--users > 0) return;
      for (const { buffer } of state.buffers.values()) buffer.destroy();
      state.buffers.clear();
      rows?.release();
      // Caster records bind the freed buffers: a material that takes the plugin back must make new ones.
      state.id = nextId++;
    },
  };
  states.set(feature, state);
  return feature;
}

/**
 * The `/serialization` codec of material plugins: pass it in `codecs` to `captureMaterialLibrary` and
 * `restoreMaterialLibrary`. It saves the name, WGSL, current uniform values and textures; a restore makes a new plugin.
 */
export const materialPluginCodec: MaterialValueCodec = {
  type: 'material-plugin',
  test: (v) => states.has(v as MaterialFeature),
  capture: (v: MaterialPlugin) => ({
    name: v.pluginName,
    ...v.code,
    uniforms: Object.fromEntries(
      Object.entries(v.uniforms).map(([k, x]) => [k, typeof x === 'number' ? x : Array.from(x)]),
    ),
    textures: { ...v.textures },
    ...(v.instanceAttributes ? { instanceAttributes: v.instanceAttributes } : {}),
  }),
  restore: (data: MaterialPluginOptions) => materialPlugin(data),
};
