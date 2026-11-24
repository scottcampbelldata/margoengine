import {
  materialParameters,
  restoreMaterialParameters,
  type MaterialValueCodec,
} from '@margoengine/materials/serialization';
import { Program, UniformNode, vec2, vec3, type Resource } from './node.js';
import { texture, textureCube, texture3D, type BindableTexture } from './texture.js';
import { textureArray } from './texture-array.js';
import { StorageBuffer } from './compute.js';
import { NodeMaterial } from './material.js';
import { LightingMaterial } from './lighting.js';
import { RawShaderMaterial, type RawShaderMaterialOptions } from './raw.js';
import type { ShaderMaterial as ShaderMaterialClass, ShaderMaterialOptions } from './glsl-material.js';

const nodeFields = [
  'fragmentCode',
  'vertexCode',
  'varyingFields',
  'rederived',
  'depthVertex',
  'depthMove',
  'depthFragment',
  'depthFields',
  'colourBindings',
  'surfaceGraph',
  'program',
];
const lightingFields = ['lightingCode', 'lightModelCode', 'finalColor'];
const fields = (value: object, keys: string[]) => Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
/** Owner codecs preserve compiled node programs, live uniforms, sampled textures, storage data and raw WGSL parameters. */
export const shaderMaterialCodecs: readonly MaterialValueCodec[] = [
  {
    type: 'shader-node-material',
    test: (v) => v.constructor === NodeMaterial || v.constructor === LightingMaterial,
    capture: (value: NodeMaterial) => ({
      lighting: value instanceof LightingMaterial,
      parameters: materialParameters(value),
      compiled: fields(value, [...nodeFields, ...(value instanceof LightingMaterial ? lightingFields : [])]),
    }),
    restore: (data: { lighting: boolean; parameters: Record<string, unknown>; compiled: Record<string, unknown> }) => {
      const value = data.lighting ? new LightingMaterial() : new NodeMaterial();
      if (
        !data.compiled ||
        nodeFields.some((key) => !Object.hasOwn(data.compiled, key)) ||
        !(data.compiled.program instanceof Program)
      )
        throw new TypeError('Invalid compiled node material; use the matching shader serialization format');
      for (const key of [...nodeFields, ...(data.lighting ? lightingFields : [])])
        Reflect.set(value, key, data.compiled[key]);
      restoreMaterialParameters(value, data.parameters);
      return value;
    },
  },
  {
    type: 'shader-uniform',
    test: (v) => v instanceof UniformNode,
    capture: (value: UniformNode) => ({ type: value.type, name: value.name, value: value.value }),
    restore: (data: { type: UniformNode['type']; name?: string; value: never }) =>
      new UniformNode(data.value, data.type, data.name),
  },
  {
    type: 'shader-storage',
    test: (v) => v instanceof StorageBuffer,
    capture: (value: StorageBuffer) => ({ data: value.data, type: value.type, atomic: value.atomic }),
    restore: (data: { data: Float32Array | Int32Array | Uint32Array; type: StorageBuffer['type']; atomic: boolean }) =>
      new StorageBuffer(data.data, data.type, data.atomic),
  },
  {
    type: 'shader-texture-resource',
    test: (v) => (v as Resource).prefix === 'ndt' && !!(v as Resource).source,
    capture: (value: Resource) => ({
      source: value.source,
      dimension: Reflect.get(value.source as object, 'dimension') ?? '2d',
    }),
    restore: (data: { source: BindableTexture; dimension: string }) => {
      const node =
        data.dimension === 'cube'
          ? textureCube(data.source, vec3(1, 0, 0))
          : data.dimension === '3d'
            ? texture3D(data.source, vec3(0))
            : data.dimension === '2d-array'
              ? textureArray(data.source, 0, vec2(0))
              : texture(data.source, vec2(0));
      const program = new Program();
      program.stage({ kind: 'fragment', builtins: {} }, [node]);
      return program.resources[0].resource;
    },
  },
  {
    type: 'shader-program',
    test: (v) => v instanceof Program,
    capture: (program: Program) => ({
      base: program.base,
      compute: program.compute,
      size: program['size'],
      next: program.next,
      members: program.members,
      declarations: [...program['declarations']],
      resources: program.resources.map((row) =>
        row === program['block'] ? { name: row.name, binding: row.binding, block: true } : row,
      ),
    }),
    restore: (data: {
      base: number;
      compute: boolean;
      size: number;
      next: number;
      members: Program['members'];
      declarations: [string, string][];
      resources: { name: string; binding: number; block?: boolean; resource?: Resource }[];
    }) => {
      const program = new Program(data.base, data.compute);
      program['size'] = data.size;
      program.next = data.next;
      program.members.push(...data.members);
      for (const [key, value] of data.declarations) program['declarations'].set(key, value);
      for (const row of data.resources) {
        const item = {
          name: row.name,
          binding: row.binding,
          resource: row.resource ?? { prefix: 'ndu', bindings: 1, declare: () => '', entries: () => [] },
        };
        program.resources.push(item);
        if (row.block) program['block'] = item;
      }
      return program;
    },
  },
  {
    type: 'shader-raw-material',
    test: (v) => v.constructor === RawShaderMaterial,
    capture: (value: RawShaderMaterial) => ({
      vertexShader: value.vertexShader,
      fragmentShader: value.fragmentShader,
      vertexEntry: value['entries'].vertex,
      fragmentEntry: value['entries'].fragment,
      gbufferEntry: value['gbufferName'],
      velocityEntry: value.velocityName,
      groups: value['groups'],
      ...fields(value, [
        'name',
        'uniforms',
        'textures',
        'storage',
        'transparent',
        'blending',
        'depthTest',
        'depthWrite',
        'depthCompare',
        'depthBias',
        'depthBiasSlopeScale',
        'alphaToCoverage',
        'cull',
        'colorWrite',
        'wireframe',
        'onError',
      ]),
    }),
    restore: (data: RawShaderMaterialOptions) => new RawShaderMaterial(data),
  },
];

/**
 * The codec of a GLSL `ShaderMaterial` (`@margoengine/shader/glsl-material`): it keeps the GLSL, the options, the live
 * uniform values and the render state, and restoring translates the GLSL again. It takes the class, so this entry
 * stays free of the GLSL front end: `codecs: [...shaderMaterialCodecs, glslMaterialCodec(ShaderMaterial)]`. Without
 * it a ShaderMaterial has no codec, and capturing one throws rather than saving it as plain WGSL.
 */
export function glslMaterialCodec(ShaderMaterial: typeof ShaderMaterialClass): MaterialValueCodec {
  if (typeof ShaderMaterial !== 'function' || !(ShaderMaterial.prototype instanceof RawShaderMaterial))
    throw new TypeError('glslMaterialCodec got no ShaderMaterial class; pass ShaderMaterial from @margoengine/shader/glsl-material');
  return {
    type: 'shader-glsl-material',
    test: (v) => v instanceof ShaderMaterial,
    capture: (value: RawShaderMaterial & Record<string, unknown>) => {
      const { uniformNames: _, ...source } = value['source'] as Record<string, unknown>,
        uniforms = value.uniforms as Record<string, { value: unknown }>;
      return {
        source,
        uniforms: Object.fromEntries(Object.keys(uniforms).map((name) => [name, { value: uniforms[name]!.value }])),
        state: fields(value, [
          'name',
          'transparent',
          'blending',
          'depthTest',
          'depthWrite',
          'depthCompare',
          'polygonOffset',
          'polygonOffsetFactor',
          'polygonOffsetUnits',
          'depthBias',
          'depthBiasSlopeScale',
          'alphaToCoverage',
          'cull',
          'colorWrite',
          'wireframe',
          'onError',
        ]),
      };
    },
    restore: (data: { source: Record<string, unknown>; uniforms: Record<string, { value: unknown }>; state: Record<string, unknown> }) => {
      const { name, ...state } = data.state,
        material = new ShaderMaterial({ ...(data.source as object), uniforms: data.uniforms, ...(name !== undefined ? { name: name as string } : {}) } as ShaderMaterialOptions);
      // Polygon offset first: its setters write depthBias, which a saved bias of its own then replaces.
      const order = ['polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits'];
      for (const key of [...order, ...Object.keys(state).filter((k) => !order.includes(k))])
        if (state[key] !== undefined) Reflect.set(material, key, state[key]);
      return material;
    },
  };
}
