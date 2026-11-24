import type { MaterialFeature, Texture } from '@margoengine/materials';

type Rows = Map<GPUDevice, { buffer: GPUBuffer; values: Float32Array }>;
// The features with a uniform on each device, told once when it is lost. A reaction on device.lost cannot be removed:
// one made per feature kept every detached feature, with its textures, alive as long as the device. The one reaction,
// made outside any feature's scope, holds the device and this set, which a feature leaves on detach.
const lostWatch = new WeakMap<GPUDevice, Set<Rows>>();
function watchLost(device: GPUDevice, rows: Rows): void {
  let set = lostWatch.get(device);
  if (!set) {
    const watching = (set = new Set());
    lostWatch.set(device, watching);
    void device.lost?.then(() => {
      for (const r of watching) r.get(device)?.buffer.destroy(), r.delete(device);
      watching.clear();
    });
  }
  set.add(rows);
}

/** A separate green roughness map keeps an existing combined map's blue metalness channel and UV transform. */
export function separateRoughness(texture: Texture, fallback: Texture): MaterialFeature {
  const buffers: Rows = new Map();
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
        watchLost(device, buffers);
      }
      row.values.set(material.uvt.slice(8, 16));
      device.queue.writeBuffer(row.buffer, 0, row.values);
      return [{ binding: 700, resource: view }, { binding: 701, resource: sampler }, { binding: 702, resource: { buffer: row.buffer } }];
    },
    detach() {
      // Core records and submits synchronously. End this task before retiring a buffer a draw may still reference.
      for (const [device, row] of buffers) lostWatch.get(device)?.delete(buffers), queueMicrotask(() => row.buffer.destroy());
      buffers.clear(); queueMicrotask(() => fallback.dispose());
    },
  };
}
