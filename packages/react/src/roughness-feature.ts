import type { MaterialFeature, Texture } from '@margoengine/materials';

/** A separate green roughness map keeps an existing combined map's blue metalness channel and UV transform. */
export function separateRoughness(texture: Texture, fallback: Texture): MaterialFeature {
  const buffers = new Map<GPUDevice, { buffer: GPUBuffer; values: Float32Array }>();
  return {
    name: 'react:roughness',
    shader(code, group) {
      return `struct ReactRoughnessUV {a:vec4f,b:vec4f}
@group(${group}) @binding(700) var reactRoughness:texture_2d<f32>;
@group(${group}) @binding(701) var reactRoughnessSampler:sampler;
@group(${group}) @binding(702) var<uniform> reactRoughnessUV:ReactRoughnessUV;
fn reactRoughUV(i:Out)->vec2f {
let p=vec3f(select(i.uv.xy,i.uv.zw,reactRoughnessUV.a.w>0.5),1);
return vec2f(dot(reactRoughnessUV.a.xyz,p),dot(reactRoughnessUV.b.xyz,p));
}
` + code.replaceAll('mr.g*f.factors.x', 'textureSample(reactRoughness,reactRoughnessSampler,reactRoughUV(i)).g*f.factors.x');
    },
    bindings(device, _, material) {
      const [view, sampler] = texture.bind(device, false) ?? fallback.bind(device, false)!;
      let row = buffers.get(device);
      if (!row) {
        row = { buffer: device.createBuffer({ size: 32, usage: 64 | 8 }), values: new Float32Array(8) };
        buffers.set(device, row);
        void device.lost.then(() => { buffers.get(device)?.buffer.destroy(); buffers.delete(device); });
      }
      row.values.set(material.uvt.slice(8, 16));
      device.queue.writeBuffer(row.buffer, 0, row.values);
      return [{ binding: 700, resource: view }, { binding: 701, resource: sampler }, { binding: 702, resource: { buffer: row.buffer } }];
    },
    detach() {
      // Core records and submits synchronously. End this task before retiring a buffer a draw may still reference.
      for (const row of buffers.values()) queueMicrotask(() => row.buffer.destroy());
      buffers.clear(); queueMicrotask(() => fallback.dispose());
    },
  };
}
