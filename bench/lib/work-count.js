// Native API call counts only. Never inspect another engine's shaders or implementation.
export function workCounter(scope = globalThis) {
  let counts = {};
  const restores = [];
  const wrap = (type, methods) => {
    const proto = scope[type]?.prototype;
    if (!proto) return;
    for (const name of methods) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      const key = `${type}.${name}`;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      proto[name] = function (...args) {
        counts[key] = (counts[key] ?? 0) + 1;
        if (name === 'writeBuffer') {
          const element = args[2].BYTES_PER_ELEMENT ?? 1;
          const bytes = args[4] === undefined ? args[2].byteLength - (args[3] ?? 0) * element : args[4] * element;
          counts.writeBufferBytes = (counts.writeBufferBytes ?? 0) + bytes;
        }
        return original.apply(this, args);
      };
      restores.push(() => (descriptor ? Object.defineProperty(proto, name, descriptor) : delete proto[name]));
    }
  };
  wrap('GPUDevice', [
    'createBuffer',
    'createTexture',
    'createBindGroup',
    'createShaderModule',
    'createRenderPipeline',
    'createRenderPipelineAsync',
  ]);
  wrap('GPUQueue', ['writeBuffer', 'writeTexture', 'copyExternalImageToTexture', 'submit']);
  wrap('GPUCommandEncoder', ['beginRenderPass', 'beginComputePass', 'copyBufferToBuffer', 'copyTextureToBuffer']);
  wrap('GPURenderPassEncoder', [
    'setBindGroup',
    'setVertexBuffer',
    'setIndexBuffer',
    'draw',
    'drawIndexed',
    'drawIndirect',
    'drawIndexedIndirect',
  ]);
  wrap('GPUComputePassEncoder', ['setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
  wrap('GPUBuffer', ['mapAsync']);
  wrap('WebGL2RenderingContext', [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'bufferData',
    'bufferSubData',
    'readPixels',
  ]);
  return {
    snapshot: () => ({ ...counts }),
    reset: () => {
      counts = {};
    },
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}
