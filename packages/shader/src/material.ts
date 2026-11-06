import { MargoError } from '@margoengine/math/errors';
import { Material, type MaterialOptions } from '@margoengine/materials';
import type { CasterDisplacement } from '../../shared/caster.js';
import type { SurfaceGraph } from './graph.js';
import type { Engine } from '@margoengine/core/extension';
import {
  Program,
  builtin,
  cast,
  positionLocal,
  normalLocal,
  scalarOf,
  type Builder,
  type Node,
  type ShaderStage,
  type NodeInput,
} from './node.js';

/** Material slots a node replaces. Nodes read `@margoengine/materials` maps and factors through `materialColor` and friends. */
export interface NodeMaterialOptions extends MaterialOptions {
  /** Base colour (linear); vec3f keeps the computed alpha. Replaces color x map x vertex colour. */
  colorNode?: Node<'vec3f' | 'vec4f'>;
  opacityNode?: NodeInput<'f32'>;
  roughnessNode?: NodeInput<'f32'>;
  metalnessNode?: NodeInput<'f32'>;
  emissiveNode?: Node<'vec3f'>;
  /** World-space shading normal. */
  normalNode?: Node<'vec3f'>;
  /**
   * Object-space vertex position, e.g. `positionLocal.add(normalLocal.mul(offset))`. Every pass sees it: colour, G-buffer,
   * shadows and picking.
   */
  positionNode?: Node<'vec3f'>;
  /**
   * How normals follow `positionNode`. `'neighbours'` evaluates the graph 0.001 units to two sides of each vertex: smooth,
   * for shapes the graph works out from `positionLocal`. `'faces'` takes each triangle's own normal in the fragment, for
   * graphs that read `uv()`, whose neighbours are unknown. `'keep'` leaves the mesh's normals. Default: `'faces'` when the
   * graph reads `uv()`, else `'neighbours'`.
   */
  positionNormals?: 'neighbours' | 'faces' | 'keep';
}
/** The surface value this material computed before its nodes ran (fragment only). */
export const materialColor = /*@__PURE__*/ builtin('materialColor', 'vec4f'),
  materialNormal = /*@__PURE__*/ builtin('materialNormal', 'vec3f');
/** The material's own roughness (0..1), metalness (0..1) and emissive (linear RGB) before the nodes ran (fragment only). */
export const materialRoughness = /*@__PURE__*/ builtin('materialRoughness', 'f32'),
  materialMetalness = /*@__PURE__*/ builtin('materialMetalness', 'f32'),
  materialEmissive = /*@__PURE__*/ builtin('materialEmissive', 'vec3f');
/** True when the fragment belongs to a front face (fragment only). */
export const frontFacing = /*@__PURE__*/ builtin('frontFacing', 'bool');
const maxVaryings = 8;
/** The vertex stage with `positionLocal` at `position`: the vertex itself, or a neighbour of it. */
const vertexAt = (position: string): ShaderStage => {
  const world = `(f.model * vec4f(${position}, 1.0)).xyz`;
  return {
    kind: 'vertex',
    builtins: {
      uv: 'i.uv.xy',
      vertexColor: 'i.color',
      positionLocal: position,
      normalLocal: 'i.normal.xyz',
      positionWorld: world,
      normalWorld: 'normalize((f.normalMatrix * vec4f(i.normal.xyz, 0.0)).xyz)',
      cameraPosition: 'f.eye.xyz',
      viewDirection: `normalize(f.eye.xyz - ${world})`,
    },
  };
};
const vertex = /*@__PURE__*/ vertexAt('i.position.xyz');
/** @internal The fragment stage, for entries that compile more nodes into the same shader. */
export const fragmentStage: ShaderStage = {
  kind: 'fragment',
  builtins: {
    uv: 'i.uv.xy',
    vertexColor: 'i.color',
    positionWorld: 'i.position',
    normalWorld: 'normalize(i.normal)',
    cameraPosition: 'f.eye.xyz',
    viewDirection: 'normalize(f.eye.xyz - i.position)',
    screenCoordinate: 'i.clip.xy',
    screenUV: (b) => `(${b.local('i.clip.xy')} / ${b.frame('resolution', 'vec2f')})`,
    positionLocal: (b) => b.stage.varying!(b, positionLocal),
    normalLocal: (b) => b.stage.varying!(b, normalLocal),
    materialColor: 's.base',
    materialNormal: 's.n',
    materialRoughness: 's.roughness',
    materialMetalness: 's.metal',
    materialEmissive: 's.emissive',
    frontFacing: 'front',
  },
  varying(b, x) {
    const list = b.program.varyings,
      c = b.program.canon(x);
    let i = list.findIndex((y) => b.program.canon(y) === c);
    if (i < 0) {
      if (list.length >= maxVaryings)
        throw new RangeError(`NodeMaterial supports at most ${maxVaryings} varyings; use fewer varying nodes.`);
      i = list.push(x) - 1;
    }
    return b.local('i.ndv' + i);
  },
};
const fragmentSite = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/,
  vertexSite = 'let p=f.model*vec4f(i.position.xyz,1);',
  normalSite = 'o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;',
  // A triangle's own normal, facing the camera, in place of the interpolated one under any normal map.
  facesCode = `let margoView=f.eye.xyz-i.position;let margoMesh=normalize(i.normal);let margoEdges=cross(dpdx(i.position),dpdy(i.position));
s.n=normalize(s.n-select(-margoMesh,margoMesh,dot(margoMesh,margoView)>=0.0)+normalize(select(-margoEdges,margoEdges,dot(margoEdges,margoView)>=0.0)));`,
  // Two unit vectors across the surface at this vertex, and the points 0.001 units along them.
  neighbours = `let margoAcross=normalize(cross(i.normal.xyz,select(vec3f(1,0,0),vec3f(0,1,0),abs(i.normal.x)>0.9)));
let margoAlong=cross(i.normal.xyz,margoAcross);
let margoA=i.position.xyz+margoAcross*0.001;
let margoB=i.position.xyz+margoAlong*0.001;`;
const scoped = (name: string, lines: string[], value: string) =>
  `var ${name}=vec3f(0);{\n${lines.join('\n')}\n${name}=${value};\n}`;
/** Fragment and vertex stages of a depth pass: its shaders have no surface, camera or frame of the beauty pass. */
function depthStages(varyings: Node[], cut: { vertex: boolean; fragment: boolean }): [ShaderStage, ShaderStage] {
  const away = (part: 'vertex' | 'fragment') => () => {
      cut[part] = true;
      return 'vec3f(0)';
    },
    camera = { cameraPosition: away('vertex'), viewDirection: away('vertex') },
    through = (x: Node) => (b: Builder) => b.stage.varying!(b, x);
  return [
    {
      kind: 'vertex',
      builtins: {
        uv: 'i.uv.xy',
        vertexColor: 'i.color',
        positionLocal: 'i.position.xyz',
        normalLocal: 'i.normal.xyz',
        positionWorld: 'margoWorld',
        normalWorld: 'margoWorldNormal',
        ...camera,
      },
    },
    {
      kind: 'fragment',
      builtins: {
        uv: through(builtin('uv', 'vec2f')),
        vertexColor: through(builtin('vertexColor', 'vec4f')),
        positionWorld: through(builtin('positionWorld', 'vec3f')),
        normalWorld: (b) => `normalize(${b.stage.varying!(b, builtin('normalWorld', 'vec3f'))})`,
        positionLocal: through(positionLocal),
        normalLocal: through(normalLocal),
        screenCoordinate: fragmentStage.builtins.screenCoordinate,
        screenUV: fragmentStage.builtins.screenUV,
        frontFacing: 'front',
        cameraPosition: away('fragment'),
        viewDirection: away('fragment'),
        materialColor: away('fragment'),
        materialNormal: away('fragment'),
        materialRoughness: away('fragment'),
        materialMetalness: away('fragment'),
        materialEmissive: away('fragment'),
      },
      varying(b, x) {
        const c = b.program.canon(x);
        let i = varyings.findIndex((y) => b.program.canon(y) === c);
        if (i < 0) {
          if (varyings.length >= maxVaryings)
            throw new RangeError(`NodeMaterial supports at most ${maxVaryings} varyings; use fewer varying nodes.`);
          i = varyings.push(x) - 1;
        }
        return b.local('i.ndv' + i);
      },
    },
  ];
}
const varyingCode = (list: readonly Node[]) =>
  list
    .map(
      (x, i) =>
        `,\n  @location(${8 + i})${scalarOf(x.type) === 'f32' ? '' : ' @interpolate(flat)'} ndv${i}:${x.type}`,
    )
    .join('');

let depthKeys = 0;
// GPUShaderStage's values, fixed by the WebGPU specification; this module loads where that global does not exist.
const vertexStage = 1,
  fragmentStageFlag = 2;
/** The layout entry of a module-scope declaration of this package's generated WGSL. */
function layoutEntry(binding: number, access: string | undefined, type: string): GPUBindGroupLayoutEntry {
  const visibility = vertexStage | fragmentStageFlag,
    image = /^texture_(depth_)?(multisampled_)?(2d_array|cube_array|2d|3d|cube)(?:<(\w+)>)?/.exec(type),
    writes = /^texture_storage_(2d_array|2d|3d)<(\w+), ?(\w+)>/.exec(type);
  if (access)
    return { binding, visibility, buffer: { type: access.includes('uniform') ? 'uniform' : 'read-only-storage' } };
  if (writes)
    return {
      binding,
      visibility: fragmentStageFlag,
      storageTexture: {
        format: writes[2] as GPUTextureFormat,
        access: writes[3] === 'read' ? 'read-only' : writes[3] === 'write' ? 'write-only' : 'read-write',
        viewDimension: writes[1].replace('_', '-') as GPUTextureViewDimension,
      },
    };
  if (image)
    return {
      binding,
      visibility,
      texture: {
        sampleType: image[1] ? 'depth' : image[4] === 'u32' ? 'uint' : image[4] === 'i32' ? 'sint' : 'float',
        viewDimension: image[3].replace('_', '-') as GPUTextureViewDimension,
        multisampled: !!image[2],
      },
    };
  return { binding, visibility, sampler: { type: type.includes('comparison') ? 'comparison' : 'filtering' } };
}
/**
 * A `@margoengine/materials` Material whose colour, opacity, roughness, metalness, emissive, normal and vertex position come from
 * shader nodes. Every Material option still applies; nodes are fixed at construction, uniform values stay live.
 */
export class NodeMaterial extends Material {
  readonly program = new Program(48);
  /** Generated statements spliced into gltf-pro's surface() and vertex() (for inspection and tests). */
  readonly fragmentCode: string;
  readonly vertexCode: string;
  readonly varyingFields: string;
  /**
   * The validated surface graph a `createGraphMaterial` material was built from, so a baking host can evaluate the
   * same pattern with `evaluateSurfaceGraph`. Undefined for other node materials.
   */
  surfaceGraph?: SurfaceGraph;
  private readonly patched = new Map<string, string>();
  private readonly rederived: boolean;
  private readonly depthVertex: string;
  private readonly depthFragment: string;
  private readonly depthFields: string;
  private depthRecord?: { device: GPUDevice; record: CasterDisplacement };
  /** `extra` is for subclasses: it compiles nodes of its own after the fragment stage and before the vertex stage. */
  constructor(options: NodeMaterialOptions = {}, extra?: (program: Program) => void) {
    const {
      colorNode,
      opacityNode,
      roughnessNode,
      metalnessNode,
      emissiveNode,
      normalNode,
      positionNode,
      positionNormals,
      ...rest
    } = options;
    super(rest);
    if (colorNode !== undefined && colorNode?.type !== 'vec3f' && colorNode?.type !== 'vec4f')
      throw new TypeError('colorNode must be a vec3f or vec4f node');
    const slots: [Node | undefined, (v: string) => string][] = [
      [colorNode, (v) => (colorNode!.type === 'vec4f' ? `s.base = ${v};` : `s.base = vec4f(${v}, s.base.a);`)],
      [opacityNode === undefined ? undefined : cast(opacityNode, 'f32', 'opacityNode'), (v) => `s.base.a = ${v};`],
      [
        // 0.045: minimum perceptual roughness, Filament design document (published engine standard).
        roughnessNode === undefined ? undefined : cast(roughnessNode, 'f32', 'roughnessNode'),
        (v) => `s.roughness = clamp(${v}, 0.045, 1.0);`,
      ],
      [
        metalnessNode === undefined ? undefined : cast(metalnessNode, 'f32', 'metalnessNode'),
        (v) => `s.metal = clamp(${v}, 0.0, 1.0);`,
      ],
      [emissiveNode && cast(emissiveNode, 'vec3f', 'emissiveNode'), (v) => `s.emissive = ${v};`],
      [normalNode && cast(normalNode, 'vec3f', 'normalNode'), (v) => `s.n = normalize(${v});`],
    ];
    const used = slots.filter((s) => s[0]),
      f = this.program.stage(
        fragmentStage,
        used.map((s) => s[0]!),
      );
    extra?.(this.program);
    const position = positionNode && cast(positionNode, 'vec3f', 'positionNode'),
      v = this.program.stage(vertex, [...(position ? [position] : []), ...this.program.varyings]),
      values = [...v.values];
    const pos = position ? values.shift()! : 'i.position.xyz';
    // The graph once more at each neighbour: the same nodes with positionLocal moved, so the normal follows the shape.
    const a = position && this.program.stage(vertexAt('margoA'), [position]),
      normals = !a
        ? 'keep'
        : (positionNormals ?? (/i\.uv/.test(a.lines.join('\n') + a.values[0]) ? 'faces' : 'neighbours')),
      across: string[] = [];
    if (a && normals === 'neighbours') {
      const b = this.program.stage(vertexAt('margoB'), [position]);
      across.push(
        neighbours,
        scoped('margoAt', a.lines, a.values[0]),
        scoped('margoUp', b.lines, b.values[0]),
        `let margoCross=cross(margoAt-(${pos}),margoUp-(${pos}));`,
        `let margoNormal=select(i.normal.xyz,normalize(margoCross),dot(margoCross,margoCross)>1e-20);`,
      );
    }
    this.rederived = across.length > 0;
    this.fragmentCode = [
      ...(normals === 'faces' && !normalNode ? [facesCode] : []),
      ...f.lines,
      ...used.map((s, i) => s[1](f.values[i])),
    ]
      .map((l) => '  ' + l + '\n')
      .join('');
    this.vertexCode = [
      ...v.lines,
      ...across,
      `let p=f.model*vec4f(${pos},1);`,
      ...values.map((x, i) => `o.ndv${i} = ${x};`),
    ]
      .map((l) => '  ' + l + '\n')
      .join('');
    this.varyingFields = varyingCode(this.program.varyings);
    // The depth passes' view of the same graph. Nodes they cannot serve leave that half of the graph out (README).
    const list: Node[] = [],
      cut = { vertex: false, fragment: false },
      [depthVertex, depthFragment] = depthStages(list, cut),
      cutout = this.program.stage(
        depthFragment,
        used.map((s) => s[0]!),
      ),
      fragmentLines = cutout.lines.join('\n'),
      keeps = !cut.fragment && fragmentLines.includes('discard;');
    this.depthFragment = keeps ? fragmentLines : '';
    if (!keeps) list.length = 0;
    const place = this.program.stage(depthVertex, [...(position ? [position] : []), ...list]),
      placed = [...place.values],
      moved = position && !cut.vertex ? placed.shift()! : (position && placed.shift(), undefined);
    this.depthFields = varyingCode(list);
    this.depthVertex =
      moved === undefined && !keeps
        ? ''
        : [
            ...place.lines,
            ...(moved === undefined ? [] : [`margoPosition=${moved};`]),
            ...placed.map((x, i) => `o.ndv${i}=${x};`),
          ].join('\n');
  }
  override shader(source: string, group: number): string {
    // Material maps can change their sparse resource layout while the native PBR source stays identical.
    const material = super.shader(source, group),
      key = group + material;
    let code = this.patched.get(key);
    if (code) return code;
    let count = 0;
    code = material
      .replace(fragmentSite, (site) => {
        count++;
        return this.fragmentCode.trimStart() + '  ' + site;
      })
      .replace(vertexSite, () => {
        count++;
        return this.vertexCode.trim();
      });
    if (this.rederived)
      code = code.replace(normalSite, () => {
        count++;
        return 'o.normal=(f.normalMatrix*vec4f(margoNormal,0)).xyz;';
      });
    if (this.varyingFields)
      code = code.replace(/(struct Out \{[^}]*?)\n\}/, (_, body) => {
        count++;
        return body + this.varyingFields + '\n}';
      });
    if (count !== 2 + (this.varyingFields ? 1 : 0) + (this.rederived ? 1 : 0))
      throw new MargoError(
        'unsupported',
        'NodeMaterial requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and shader versions',
      );
    code = this.program.declare(group) + '\n' + code;
    this.patched.set(key, code);
    return code;
  }
  /** `code`, a caster depth shader with the mesh normal in its input, drawing this graph's position and discards. */
  private depthShader(code: string, group: number): string {
    const out = /var o:(\w+);/.exec(code)?.[1],
      model = /(\w+\.model)\*vec4f\(i\.position\.xyz,1\)/.exec(code)?.[1];
    if (!out || !model)
      throw new MargoError(
        'unsupported',
        'NodeMaterial requires a standard caster depth shader; use matching @margoengine/shader and effect package versions',
      );
    return (
      this.program.declare(group) +
      '\n' +
      code
        .replace('vec4f(i.position.xyz,1)', 'vec4f(margoPosition,1)')
        .replace(
          `var o:${out};`,
          () =>
            `var o:${out};let margoWorld=(${model}*vec4f(i.position.xyz,1)).xyz;let margoWorldNormal=normalize((${model}*vec4f(i.normal.xyz,0)).xyz);` +
            `var margoPosition=i.position.xyz;{\n${this.depthVertex}\n}`,
        )
        .replace(new RegExp(`(struct ${out} \\{[^}]*)\\}`), (_, body) => body + this.depthFields + '}')
        .replace(
          /@fragment fn fragment\((i:\w+)\)([^{]*)\{/,
          (_, input, result) =>
            `@fragment fn fragment(${input},@builtin(front_facing) front:bool)${result}{\n${this.depthFragment}\n`,
        )
    );
  }
  /** @internal What a depth pass draws: the record of gltf-pro's `displacement`, undefined for an unchanged shape. */
  override caster(device: GPUDevice, engine?: Engine): CasterDisplacement | undefined {
    if (!this.depthVertex) return undefined;
    if (this.depthRecord?.device === device) return this.depthRecord.record;
    const canvas = engine?.canvas,
      body = this.depthVertex + this.depthFragment,
      declared = this.program.declare(0),
      // Auto layouts hold what the shader reaches, which can be less than the beauty pass binds.
      reached = new Map<number, GPUBindGroupLayoutEntry>();
    for (const [, binding, access, name, type] of declared.matchAll(
      /@binding\((\d+)\) var(<[^>]*>)? (\w+) ?: ?([^;\n]+);/g,
    ))
      if ((body + declared).match(new RegExp(`\\b${name}\\b`, 'g'))!.length > 1)
        reached.set(+binding, layoutEntry(+binding, access, type));
    let layout: GPUBindGroupLayout | undefined;
    const record: CasterDisplacement = {
      key: `n${++depthKeys}`,
      cuts: !!this.depthFragment,
      depth: (code, group) => this.depthShader(code, group),
      layout: () => (layout ??= device.createBindGroupLayout({ entries: [...reached.values()] })),
      entries: () =>
        this.program
          .entries(device, { width: canvas?.width ?? 1, height: canvas?.height ?? 1 })
          .filter((entry) => reached.has(entry.binding)),
    };
    this.depthRecord = { device, record };
    return record;
  }
  override bindings(device: GPUDevice, engine?: Engine): GPUBindGroupEntry[] {
    const canvas = engine?.canvas;
    return [
      ...super.bindings(device, engine),
      ...this.program.entries(device, { width: canvas?.width ?? 1, height: canvas?.height ?? 1 }),
    ];
  }
}
