// Browser diagnostic only: API/queue wall times, with unchanged commands/shaders.
// Install before the app/audit. Hold the deferred details request, then stop at
// afterlightStartup.phase === 'principal'. No new queue waits or GPU timestamps.
export function installStartupApiTrace() {
  const state = {
    started: performance.now(),
    events: [],
    modules: [],
    pipelines: [],
    passes: [],
    commands: [],
    submissions: [],
    waits: [],
    droppedEvents: 0,
  };
  const shaders = new WeakMap(),
    pipelines = new WeakMap(),
    passes = new WeakMap(),
    encoders = new WeakMap(),
    commands = new WeakMap();
  const restores = [],
    now = () => performance.now();
  let active = true;
  const event = (row) => {
    if (!active) return;
    if (state.events.length < 500) state.events.push(row);
    else state.droppedEvents++;
  };
  const hook = (prototype, name, replacement) => {
    if (!prototype || typeof prototype[name] !== 'function') return;
    const original = prototype[name],
      traced = replacement(original);
    const value = function (...args) {
      return (active ? traced : original).apply(this, args);
    };
    prototype[name] = value;
    restores.push(() => {
      if (prototype[name] === value) prototype[name] = original;
    });
  };
  const caller = () => String(new Error().stack).split('\n').slice(3, 8).join('\n');
  for (const method of ['requestAdapter', 'requestDevice']) {
    const prototype = method === 'requestAdapter' ? globalThis.GPU?.prototype : globalThis.GPUAdapter?.prototype;
    hook(
      prototype,
      method,
      (original) =>
        function (...args) {
          const start = now(),
            promise = original.apply(this, args);
          event({ method, start, returned: now() });
          return promise.then(
            (value) => {
              event({
                method: method + ':ready',
                start,
                ready: now(),
                ...(method === 'requestAdapter' && value
                  ? {
                      adapter: {
                        vendor: value.info?.vendor,
                        architecture: value.info?.architecture,
                        device: value.info?.device,
                        fallback: value.info?.isFallbackAdapter,
                      },
                    }
                  : {}),
              });
              return value;
            },
            (error) => {
              event({ method: method + ':failed', start, end: now(), error: String(error) });
              throw error;
            },
          );
        },
    );
  }
  hook(
    GPUDevice.prototype,
    'createShaderModule',
    (original) =>
      function (descriptor) {
        const start = now(),
          value = original.call(this, descriptor),
          end = now(),
          id = state.modules.length;
        shaders.set(value, id);
        state.modules.push({ id, code: descriptor.code, label: descriptor.label ?? '', caller: caller() });
        event({ method: 'createShaderModule', id, start, end });
        return value;
      },
  );
  for (const method of [
    'createRenderPipeline',
    'createRenderPipelineAsync',
    'createComputePipeline',
    'createComputePipelineAsync',
  ]) {
    hook(
      GPUDevice.prototype,
      method,
      (original) =>
        function (descriptor) {
          const id = state.pipelines.length,
            start = now(),
            value = original.call(this, descriptor),
            end = now();
          state.pipelines.push({
            id,
            method,
            label: descriptor.label ?? '',
            caller: caller(),
            samples: descriptor.multisample?.count ?? 1,
            formats: descriptor.fragment?.targets?.map((target) => target?.format) ?? [],
            depth: descriptor.depthStencil?.format ?? null,
            vertex: descriptor.vertex
              ? { module: shaders.get(descriptor.vertex.module), entry: descriptor.vertex.entryPoint }
              : null,
            fragment: descriptor.fragment
              ? { module: shaders.get(descriptor.fragment.module), entry: descriptor.fragment.entryPoint }
              : null,
            compute: descriptor.compute
              ? { module: shaders.get(descriptor.compute.module), entry: descriptor.compute.entryPoint }
              : null,
          });
          event({ method, id, start, end });
          if (method.endsWith('Async'))
            return value.then(
              (pipeline) => {
                pipelines.set(pipeline, id);
                event({ method: method + ':ready', id, start, ready: now() });
                return pipeline;
              },
              (error) => {
                event({ method: method + ':failed', id, start, end: now(), error: String(error) });
                throw error;
              },
            );
          pipelines.set(value, id);
          return value;
        },
    );
  }
  for (const prototype of [globalThis.GPURenderPipeline?.prototype, globalThis.GPUComputePipeline?.prototype])
    hook(
      prototype,
      'getBindGroupLayout',
      (original) =>
        function (...args) {
          const start = now(),
            value = original.apply(this, args),
            end = now();
          event({ method: 'getBindGroupLayout', pipeline: pipelines.get(this), start, end });
          return value;
        },
    );
  for (const method of ['createBindGroup', 'createTexture', 'createBuffer'])
    hook(
      GPUDevice.prototype,
      method,
      (original) =>
        function (descriptor) {
          const start = now(),
            value = original.call(this, descriptor),
            end = now();
          event({
            method,
            start,
            end,
            ...(method === 'createTexture'
              ? { format: descriptor.format, samples: descriptor.sampleCount ?? 1, size: descriptor.size }
              : method === 'createBuffer'
                ? { bytes: descriptor.size }
                : {}),
          });
          return value;
        },
    );
  for (const method of ['beginRenderPass', 'beginComputePass'])
    hook(
      GPUCommandEncoder.prototype,
      method,
      (original) =>
        function (...args) {
          const start = now(),
            value = original.apply(this, args),
            end = now(),
            id = state.passes.length;
          const info = {
            id,
            method,
            start,
            end,
            label: args[0]?.label ?? '',
            pipelineIds: [],
            draws: 0,
            dispatches: [],
            ended: null,
          };
          state.passes.push(info);
          passes.set(value, info);
          let children = encoders.get(this);
          if (!children) encoders.set(this, (children = []));
          children.push(id);
          return value;
        },
    );
  for (const prototype of [GPURenderPassEncoder.prototype, GPUComputePassEncoder.prototype]) {
    hook(
      prototype,
      'setPipeline',
      (original) =>
        function (pipeline) {
          const value = original.call(this, pipeline),
            pass = passes.get(this);
          if (pass) pass.pipelineIds.push(pipelines.get(pipeline));
          return value;
        },
    );
    hook(
      prototype,
      'end',
      (original) =>
        function () {
          const start = now(),
            value = original.call(this),
            end = now(),
            pass = passes.get(this);
          if (pass) {
            pass.ended = end;
            event({ method: 'pass.end', id: pass.id, start, end });
          }
          return value;
        },
    );
  }
  for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
    hook(
      GPURenderPassEncoder.prototype,
      method,
      (original) =>
        function (...args) {
          const value = original.apply(this, args),
            pass = passes.get(this);
          if (pass) pass.draws++;
          return value;
        },
    );
  hook(
    GPUComputePassEncoder.prototype,
    'dispatchWorkgroups',
    (original) =>
      function (...args) {
        const value = original.apply(this, args),
          pass = passes.get(this);
        if (pass) pass.dispatches.push(args);
        return value;
      },
  );
  hook(
    GPUCommandEncoder.prototype,
    'finish',
    (original) =>
      function (...args) {
        const start = now(),
          value = original.apply(this, args),
          end = now(),
          id = state.commands.length;
        commands.set(value, id);
        state.commands.push({ id, passIds: encoders.get(this) ?? [], start, end });
        event({ method: 'encoder.finish', id, start, end });
        return value;
      },
  );
  hook(
    GPUQueue.prototype,
    'submit',
    (original) =>
      function (submitted) {
        const start = now(),
          value = original.call(this, submitted),
          end = now();
        state.submissions.push({
          id: state.submissions.length,
          start,
          end,
          commandIds: Array.from(submitted, (command) => commands.get(command)),
        });
        event({ method: 'queue.submit', start, end });
        return value;
      },
  );
  hook(
    GPUQueue.prototype,
    'onSubmittedWorkDone',
    (original) =>
      function (...args) {
        const row = {
          id: state.waits.length,
          start: now(),
          submittedThrough: state.submissions.length - 1,
          complete: null,
          failed: null,
        };
        state.waits.push(row);
        return original.apply(this, args).then(
          (value) => {
            row.complete = now();
            return value;
          },
          (error) => {
            row.failed = String(error);
            row.complete = now();
            throw error;
          },
        );
      },
  );
  window.startupApiTrace = {
    stop() {
      active = false;
      for (const restore of restores.reverse()) restore();
      return state;
    },
    get state() {
      return state;
    },
  };
}
