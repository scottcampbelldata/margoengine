import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { PBRModel, PBRMaterialShading } from '@margoengine/gltf-pro/model';
import { textureCoordinates } from '@margoengine/gltf-pro/coordinates';
import type { USDImagePlacement } from './extension.js';

/** Internal serializable opacity binding. */
export interface PreviewOpacity {
  texture: number;
  uv?: string;
  where: USDImagePlacement;
  texCoord?: 0 | 1;
}
interface PreviewValues {
  accessor: number;
  inputs: string[];
}
/** Attach independent opacity and interpolated numeric primvars through existing PBR hooks. */
export function attachPreviewOpacity(engine: EngineKernel, model: PBRModel): void {
  const plans = model.primitives.flatMap((primitive) => {
    const opacity = (primitive.material.extras as { usdPreviewOpacity?: PreviewOpacity } | undefined)
      ?.usdPreviewOpacity;
    const values = (primitive.definition.extras as { usdPreviewValues?: PreviewValues } | undefined)?.usdPreviewValues;
    if (
      !opacity &&
      !values &&
      !(primitive.material.extras as { usdPreviewStraightAlpha?: boolean } | undefined)?.usdPreviewStraightAlpha
    )
      return [];
    primitive.material = { ...primitive.material };
    return [{ primitive, opacity, values, previous: primitive.material.shading }];
  });
  if (!plans.length) return;
  const runtime = engineRuntime(engine),
    resources: (GPUTexture | GPUBuffer)[] = [];
  let id = 0;
  while (engine.hasPlugin('usd-preview-opacity-' + id)) id++;
  const release = () => {
    for (const resource of resources) resource.destroy();
    resources.length = 0;
  };
  const setup = () => {
    release();
    const gpu = runtime.gpu!,
      storage = new Map<number, GPUBuffer>();
    let white: GPUTexture | undefined;
    for (const { primitive, opacity, values, previous } of plans) {
      const material = primitive.material,
        bindings: GPUBindGroupEntry[] = [];
      let alpha = 's.base.a=f.base.a*i.color.a;',
        declarations = '',
        edits = '';
      const physical = (material.extras as { usdPreviewPhysical?: { clearcoat: number } } | undefined)
        ?.usdPreviewPhysical;
      if (physical) edits = 's.cc=' + physical.clearcoat.toFixed(8) + ';\n';
      if (opacity) {
        const definition = model.asset.doc.textures![opacity.texture],
          texture = model.uploadImage(definition.source!, gpu, false);
        resources.push(texture);
        const view = texture.createView(),
          wrap = (n: number): GPUAddressMode =>
            n === 33071 ? 'clamp-to-edge' : n === 33648 ? 'mirror-repeat' : 'repeat';
        const sampler = gpu.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: wrap(opacity.where.wrapS),
          addressModeV: wrap(opacity.where.wrapT),
        });
        const rows =
          textureCoordinates({ extensions: { KHR_texture_transform: opacity.where.transform } }).transform ??
          new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]);
        const coord = opacity.texCoord ?? 0,
          number = (n: number) => (Number.isInteger(n) ? n + '.0' : String(n)),
          p = coord ? 'i.uv.zw' : 'i.uv.xy';
        const uv = `vec2f(dot(vec3f(${p},1.0),vec3f(${Array.from(rows.slice(0, 3)).map(number).join(',')})),dot(vec3f(${p},1.0),vec3f(${Array.from(rows.slice(4, 7)).map(number).join(',')})))`;
        alpha = `s.base.a=f.base.a*i.color.a*textureSample(usdOpacityMap,usdOpacitySampler,${uv}).a;`;
        declarations +=
          '@group(GROUP) @binding(220) var usdOpacityMap:texture_2d<f32>;\n@group(GROUP) @binding(221) var usdOpacitySampler:sampler;\n';
        bindings.push({ binding: 220, resource: view }, { binding: 221, resource: sampler });
        const mask = { view, sampler, texCoord: coord, transform: rows };
        material.castMask = mask;
        material.pickMask = mask;
      } else {
        if (!white) {
          white = gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
          resources.push(white);
          gpu.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        }
        const mask = {
          view: white.createView(),
          sampler: gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          texCoord: 0 as const,
          transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
        };
        material.castMask = mask;
        material.pickMask = mask;
      }
      if (values) {
        let buffer = storage.get(values.accessor);
        if (!buffer) {
          const data = model.asset.accessor(values.accessor);
          if (data.byteLength > gpu.limits.maxStorageBufferBindingSize)
            throw new RangeError('USD primvars exceed the device buffer limit; split the mesh');
          buffer = gpu.createBuffer({ size: data.byteLength, usage: 136 /* STORAGE | COPY_DST */ });
          resources.push(buffer);
          gpu.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
          storage.set(values.accessor, buffer);
        }
        bindings.push({ binding: 222, resource: { buffer } });
        declarations += `@group(GROUP) @binding(222) var<storage,read> usdPrimvars:array<vec4f>;
fn usdPrimvar(slot:u32,p:vec4f)->vec4f {let tri=u32(round(p.x));let u=p.z;let v=p.w;let base=tri*${3 * values.inputs.length}u+slot;return usdPrimvars[base]*(1.0-u-v)+usdPrimvars[base+${values.inputs.length}u]*u+usdPrimvars[base+${2 * values.inputs.length}u]*v;}
`;
        const targets: Record<string, string> = {
          diffuseColor: 's.base=vec4f(VALUE.xyz,s.base.a);',
          opacity: 's.base.a=VALUE.x;',
          roughness: 's.roughness=clamp(VALUE.x,0.045,1.0);',
          metallic: 's.metal=clamp(VALUE.x,0.0,1.0);',
          emissiveColor: 's.emissive=VALUE.xyz;',
          occlusion: 's.occlusion=clamp(VALUE.x,0.0,1.0);',
          normal: 's.n=normalize((f.normalMatrix*vec4f(VALUE.xyz,0.0)).xyz)*select(-1.0,1.0,front==(f.coordsB.y>0.0));',
          clearcoat: 's.cc=clamp(VALUE.x,0.0,1.0);',
          clearcoatRoughness: 's.cr=clamp(VALUE.x,0.045,1.0);',
          specularColor: 's.f0=VALUE.xyz;',
          ior: '{let r=(max(VALUE.x,1.0)-1.0)/(max(VALUE.x,1.0)+1.0);s.f0=vec3f(r*r);}',
        };
        for (let slot = 0; slot < values.inputs.length; slot++) {
          const input = values.inputs[slot],
            value = `usdPrimvar(${slot}u,i.uvs)`;
          if (input === 'opacity') alpha = targets[input].replaceAll('VALUE', value);
          else edits += targets[input].replaceAll('VALUE', value) + '\n';
        }
      }
      const shading: PBRMaterialShading = {
        shaderRevision: 1,
        shader(source, group) {
          let code = previous?.shader?.(source, group) ?? source;
          if (alpha) {
            const anchor = '  let mr=';
            if (!code.includes(anchor))
              throw new TypeError('USD primvars need the PBR surface shader; use matching gltf-pro and usdz packages');
            code = code.replaceAll(anchor, alpha + '\n' + anchor);
          }
          if (edits) code = code.replaceAll('  return s;', edits + '  return s;');
          return declarations.replaceAll('GROUP', String(group)) + code;
        },
        bindings: () => [...(previous?.bindings() ?? []), ...bindings],
      };
      material.shading = shading;
    }
  };
  const plugin = { name: 'usd-preview-opacity-' + id, setup, onDeviceRestored: setup, dispose: release };
  engine.use(plugin);
  model.onDispose(() => engine.removePlugin(plugin.name));
}
