export function instrumentMeadow() {
  window.meadowAudit = {
    live: new Set(),
    textures: [],
    samples: [],
    boundSamples: new Set(),
    created: 0,
    frames: 0,
    grass: [],
  };
  const patched = new WeakSet();
  const patch = () => {
    const prototype = GPUDevice.prototype;
    if (patched.has(prototype)) return;
    patched.add(prototype);
    const pipelines = new WeakMap();
    for (const name of ['createBuffer', 'createTexture', 'createRenderPipeline', 'createBindGroup']) {
      const original = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function (desc) {
        const audit = window.meadowAudit,
          result = original.call(this, desc);
        audit.created++;
        if (name === 'createRenderPipeline') {
          const samples = desc.multisample?.count ?? 1;
          pipelines.set(result, samples);
          audit.samples.push(samples);
        }
        if (name === 'createTexture') audit.textures.push(desc.sampleCount ?? 1);
        if (name === 'createBuffer' || name === 'createTexture') {
          audit.live.add(result);
          const destroy = result.destroy.bind(result);
          result.destroy = () => {
            audit.live.delete(result);
            destroy();
          };
        }
        return result;
      };
    }
    const set = GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline = function (pipeline) {
      window.meadowAudit.boundSamples.add(pipelines.get(pipeline));
      return set.call(this, pipeline);
    };
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buffer, offset, data, ...rest) {
      if (buffer.label === 'grass:frame') {
        window.meadowAudit.grass = Array.from(data);
        window.meadowAudit.frames++;
      }
      return write.call(this, buffer, offset, data, ...rest);
    };
  };
  const gpu = navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (...args) => {
    const adapter = await requestAdapter(...args);
    patch();
    return adapter;
  };
}
