// A full material can consume thirteen sampled textures before lighting. WebGL2 also spends texture units on
// storage emulation and depth load/comparison pairs. Store the five base maps as linear float array layers and
// evaluate their independent glTF samplers explicitly. No channel, mip, UV, wrapping or filter is discarded.
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
export interface BaseTextureSource {
  view: GPUTextureView;
  width: number;
  height: number;
  levels: number;
  sampler: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number };
}
export interface PackedBaseTextures {
  texture: GPUTexture;
  view: GPUTextureView;
  params: GPUBuffer;
  destroy(): void;
}
const copyCode = `@group(0) @binding(0) var source:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(source,vec2i(p.xy),0);}`;
const copies = new WeakMap<GPUDevice, Map<number, GPURenderPipeline>>();

interface PackedRecord {
  texture: GPUTexture;
  view: GPUTextureView;
  params: GPUBuffer;
  users: number;
}
const packedCaches = new WeakMap<
  GPUDevice,
  { ids: WeakMap<object, number>; next: number; entries: Map<string, PackedRecord> }
>();
/** Internal: preserve original linear texels at each logical mip size in independently addressed array layers. */
export function packBaseTextures(device: GPUDevice, sources: readonly BaseTextureSource[]): PackedBaseTextures {
  let cache = packedCaches.get(device);
  if (!cache) packedCaches.set(device, (cache = { ids: new WeakMap(), next: 0, entries: new Map() }));
  const owner = cache;
  const key = sources
    .map((source) => {
      let id = owner.ids.get(source.view);
      if (id === undefined) owner.ids.set(source.view, (id = owner.next++));
      const s = source.sampler;
      return [id, source.width, source.height, source.levels, s.magFilter, s.minFilter, s.wrapS, s.wrapT].join(',');
    })
    .join(';');
  const lease = (record: PackedRecord): PackedBaseTextures => {
    record.users++;
    let released = false;
    return {
      texture: record.texture,
      view: record.view,
      params: record.params,
      destroy() {
        if (released) return;
        released = true;
        if (--record.users === 0) {
          owner.entries.delete(key);
          record.texture.destroy();
          record.params.destroy();
        }
      },
    };
  };
  const existing = owner.entries.get(key);
  if (existing) return lease(existing);

  const width = Math.max(...sources.map((s) => s.width)),
    height = Math.max(...sources.map((s) => s.height)),
    levels = Math.max(...sources.map((s) => s.levels));
  const texture = device.createTexture({
    label: 'glTF packed base maps',
    size: [width, height, 5],
    mipLevelCount: levels,
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let params: GPUBuffer | undefined;
  try {
    params = device.createBuffer({
      label: 'glTF packed base samplers',
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const rows = new Float32Array(40);
    const wrap = (v: number | undefined) => (v === 33071 ? 0 : v === 33648 ? 2 : 1);
    sources.forEach((s, i) =>
      rows.set(
        [
          s.width,
          s.height,
          s.levels,
          s.sampler.magFilter === 9728 ? 0 : 1,
          [9728, 9984, 9986].includes(s.sampler.minFilter!) ? 0 : 1,
          [9728, 9729].includes(s.sampler.minFilter!) ? 2 : [9984, 9985].includes(s.sampler.minFilter!) ? 0 : 1,
          wrap(s.sampler.wrapS),
          wrap(s.sampler.wrapT),
        ],
        i * 8,
      ),
    );
    device.queue.writeBuffer(params, 0, rows);
    let pipelines = copies.get(device);
    if (!pipelines) copies.set(device, (pipelines = new Map()));
    const encoder = device.createCommandEncoder();
    sources.forEach((source, layer) => {
      for (let level = 0; level < source.levels; level++) {
        // The shader selects each source mip and performs sRGB decoding through the original view.
        const input = source.view;
        let mipPipeline = pipelines!.get(level);
        if (!mipPipeline) {
          const module = device.createShaderModule({
            code: copyCode.replace('textureLoad(source,vec2i(p.xy),0)', `textureLoad(source,vec2i(p.xy),${level})`),
          });
          mipPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
          });
          pipelines!.set(level, mipPipeline);
        }
        const group = device.createBindGroup({
          layout: mipPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: input }],
        });
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: texture.createView({
                dimension: '2d',
                baseArrayLayer: layer,
                arrayLayerCount: 1,
                baseMipLevel: level,
                mipLevelCount: 1,
              }),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 0],
            },
          ],
        });
        pass.setPipeline(mipPipeline);
        pass.setBindGroup(0, group);
        pass.setViewport(0, 0, Math.max(1, source.width >> level), Math.max(1, source.height >> level), 0, 1);
        pass.draw(3);
        pass.end();
      }
    });
    device.queue.submit([encoder.finish()]);
    const record = { texture, view: texture.createView({ dimension: '2d-array' }), params, users: 0 };
    owner.entries.set(key, record);
    return lease(record);
  } catch (error) {
    texture.destroy();
    params?.destroy();
    throw error;
  }
}
