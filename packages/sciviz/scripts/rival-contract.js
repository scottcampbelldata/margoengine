// Clean-room comparison controls. Timing is opt-in; a one-run smoke never reads a clock.
export function rivalOptions(args) {
  let runs = 7;
  let scene = 'legacy-64';
  let output = 'test-results/bp-182';
  for (const arg of args) {
    if (/^--runs=/.test(arg)) {
      const value = arg.slice(7);
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new RangeError('runs must be 1..100');
      runs = Number(value);
    } else if (arg.startsWith('--scene=')) scene = arg.slice(8);
    else if (arg.startsWith('--output=')) output = arg.slice(9);
    else throw new TypeError(`Unknown option: ${arg}`);
  }
  if (!['legacy-64', 'isotropic-64', 'isotropic-128'].includes(scene)) throw new RangeError('Unknown scene');
  if (!output) throw new TypeError('output must not be empty');
  return { runs, scene, output, smoke: runs === 1 };
}

export function samePixels(a, b) {
  if (a.length !== b.length) throw new Error('Repeated frame changed size');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`Repeated frame changed byte ${i}`);
  return true;
}

// Instrument only public API boundaries. Never inspect a rival's implementation.
export function installWorkCounters() {
  const counts = {};
  const restore = [];
  const wrappers = new WeakSet();
  const wrap = (prototype, methods, prefix) => {
    if (!prototype) return;
    for (const name of methods) {
      const original = prototype[name];
      if (typeof original !== 'function' || wrappers.has(original)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      restore.push(() => {
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
        else delete prototype[name];
      });
      prototype[name] = function (...args) {
        const api = prefix.startsWith('webgl')
          ? globalThis.WebGL2RenderingContext && this instanceof globalThis.WebGL2RenderingContext
            ? 'webgl2'
            : 'webgl1'
          : prefix;
        const key = `${api}.${name}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return Reflect.apply(original, this, args);
      };
      wrappers.add(prototype[name]);
    }
  };
  wrap(globalThis.GPUDevice?.prototype, ['createBuffer', 'createTexture', 'createBindGroup'], 'webgpu');
  wrap(globalThis.GPUQueue?.prototype, ['writeBuffer', 'writeTexture', 'submit'], 'webgpu');
  wrap(globalThis.GPUCommandEncoder?.prototype, ['beginRenderPass', 'copyTextureToTexture'], 'webgpu');
  wrap(globalThis.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed', 'setBindGroup'], 'webgpu');
  const glMethods = [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'bufferData',
    'bufferSubData',
    'texImage2D',
    'texImage3D',
    'texSubImage2D',
    'texSubImage3D',
    'useProgram',
  ];
  // A method inherited from an already wrapped prototype is counted once.
  wrap(globalThis.WebGLRenderingContext?.prototype, glMethods, 'webgl1');
  wrap(globalThis.WebGL2RenderingContext?.prototype, glMethods, 'webgl2');
  globalThis.__rivalCounts = counts;
  globalThis.__stopRivalCounters = () => {
    for (const undo of restore) undo();
  };
}

export function countDelta(before, after) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));
}

export async function sampleFrame(smoke, frame, counts, now = () => performance.now()) {
  const before = { ...counts };
  const start = smoke ? undefined : now();
  const pixels = await frame();
  const ms = smoke ? undefined : now() - start;
  return { pixels, work: countDelta(before, counts), ...(smoke ? {} : { ms }) };
}
