// WebGPU usage-flag globals.
import '../../examples/package-benchmarks/proofs/gpu-recorder.js';

// A strict CPU WebGPU device for frame-ordering tests. Buffers hold real bytes; `queue.writeBuffer` changes them at
// once, as a real queue does before any later submit. Each draw records the bytes of its group-0 uniform binding when
// encoded; `submit` refuses destroyed resources and records the bytes the GPU would read at that point. A test then
// checks that every draw still sees what it was encoded with. A draw whose uniforms upload when its `draw()` call
// returns (gltf-pro's arena) calls `settle()` then, and the rows encoded since take the bytes the queue holds now.
export function strictGPU() {
  let next = 0;
  const calls = [],
    rows = [],
    unsettled = [],
    buffers = [],
    note = (...row) => calls.push(row),
    id = (prefix) => prefix + ++next;
  const read = (binding) =>
    binding &&
    Array.from(
      new Float32Array(
        binding.buffer.data.slice(binding.offset ?? 0, (binding.offset ?? 0) + (binding.size ?? binding.buffer.size))
          .buffer,
      ),
    );
  const live = (resource, what) => {
    if (resource?.destroyed) throw new Error(`${what} references a destroyed resource`);
  };
  class Buffer {
    constructor(d) {
      Object.assign(this, {
        id: id('b'),
        size: d.size,
        usage: d.usage,
        data: new Uint8Array(d.size),
        destroyed: false,
      });
      buffers.push(this);
    }
    destroy() {
      if (this.destroyed) throw new Error('duplicate buffer destroy');
      this.destroyed = true;
      note('destroyBuffer', this.id);
    }
  }
  class Pass {
    constructor(encoder) {
      Object.assign(this, { encoder, groups: new Map(), vertices: new Map(), ended: false });
    }
    check() {
      if (this.ended || this.encoder.active !== this) throw new Error('pass is not active');
    }
    setPipeline(p) {
      this.check();
      this.pipeline = p;
    }
    setBindGroup(i, g) {
      this.check();
      this.groups.set(i, g);
    }
    setVertexBuffer(i, b) {
      this.check();
      live(b, 'setVertexBuffer');
      this.vertices.set(i, b);
    }
    setIndexBuffer(b) {
      this.check();
      live(b, 'setIndexBuffer');
      this.index = b;
    }
    setViewport(...v) {
      this.check();
      note('viewport', ...v);
    }
    setScissorRect(...v) {
      this.check();
      note('scissor', ...v);
    }
    setStencilReference() {}
    setBlendConstant() {}
    draw(...v) {
      this.check();
      note('draw', ...v);
    }
    drawIndexed(count, instances = 1) {
      this.check();
      // Group 0: the draw's own uniform (binding 0) and, for gltf-pro, the view block it shares (binding 3).
      const frame = this.groups.get(0)?.entries,
        uniform = frame?.find((e) => e.binding === 0)?.resource,
        view = frame?.find((e) => e.binding === 3)?.resource,
        row = {
          count,
          instances,
          uniform,
          view,
          groups: new Map(this.groups),
          encoded: read(uniform),
          encodedView: view && read(view),
        };
      for (const g of this.groups.values()) for (const e of g.entries) live(e.resource?.buffer, 'drawIndexed');
      rows.push(row);
      unsettled.push(row);
      this.encoder.draws.push(row);
      note('drawIndexed', count, instances);
    }
    end() {
      this.check();
      this.ended = true;
      this.encoder.active = undefined;
    }
  }
  class Encoder {
    constructor() {
      Object.assign(this, { id: id('e'), draws: [], finished: false });
    }
    beginRenderPass() {
      if (this.finished || this.active) throw new Error('encoder is finished or has an active pass');
      return (this.active = new Pass(this));
    }
    beginComputePass() {
      return this.beginRenderPass();
    }
    finish() {
      if (this.active) throw new Error('finish with an active pass');
      this.finished = true;
      return { encoder: this, draws: this.draws };
    }
    copyTextureToTexture() {}
    copyBufferToBuffer() {}
    copyTextureToBuffer() {}
  }
  const limits = {
    maxBufferSize: 1 << 28,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 1 << 27,
    maxTextureDimension2D: 8192,
    maxTextureArrayLayers: 256,
    maxBindGroups: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxColorAttachments: 8,
    minUniformBufferOffsetAlignment: 256,
  };
  const device = {
    limits,
    features: new Set(),
    lost: new Promise(() => {}),
    addEventListener() {},
    pushErrorScope() {},
    async popErrorScope() {
      return null;
    },
    createBuffer: (d) => new Buffer(d),
    createTexture(d) {
      const t = {
        id: id('t'),
        ...d,
        destroyed: false,
        createView: () => ({ id: id('v'), texture: t }),
        destroy() {
          if (t.destroyed) throw new Error('duplicate texture destroy');
          t.destroyed = true;
        },
      };
      return t;
    },
    createSampler: () => ({ id: id('s') }),
    createShaderModule: (d) => ({
      id: id('m'),
      code: d.code,
      async getCompilationInfo() {
        return { messages: [] };
      },
    }),
    createBindGroupLayout: (d) => ({ id: id('layout'), descriptor: d }),
    createPipelineLayout: (d) => ({ id: id('pl'), descriptor: d }),
    createBindGroup: (d) => ({
      id: id('g'),
      entries: d.entries.map((e) => ({ ...e, resource: e.resource?.buffer ? { ...e.resource } : e.resource })),
    }),
    createRenderPipeline(d) {
      const p = { id: id('rp'), descriptor: d, getBindGroupLayout: (index) => ({ pipeline: p, index }) };
      return p;
    },
    createComputePipeline: (d) => ({ id: id('cp'), descriptor: d, getBindGroupLayout: (index) => ({ index }) }),
    createCommandEncoder: () => new Encoder(),
    queue: {
      writeBuffer(b, offset, data, start = 0, size) {
        live(b, 'writeBuffer');
        const unit = data.BYTES_PER_ELEMENT ?? 1,
          bytes = new Uint8Array(
            data.buffer,
            data.byteOffset + start * unit,
            size === undefined ? data.byteLength - start * unit : size * unit,
          );
        b.data.set(bytes, offset);
      },
      writeTexture() {},
      copyExternalImageToTexture() {},
      submit(commands) {
        for (const c of commands) {
          for (const row of c.draws) {
            for (const g of row.groups.values()) for (const e of g.entries) live(e.resource?.buffer, 'submit');
            row.submitted = read(row.uniform);
            if (row.view) row.submittedView = read(row.view);
          }
        }
        note('submit');
      },
      async onSubmittedWorkDone() {},
    },
  };
  /** Re-reads the uniform bytes of every row encoded since the last call (see the header). */
  const settle = () => {
    for (const row of unsettled.splice(0)) {
      row.encoded = read(row.uniform);
      if (row.view) row.encodedView = read(row.view);
    }
  };
  return { device, calls, rows, buffers, settle };
}
