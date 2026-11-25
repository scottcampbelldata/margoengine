// Pinned behaviour (checked with KB-COMPAT-FRAMEALLOC1, 2026-11-16): reading back a stencil aspect draws the stencil
// bits into a scratch colour target with gl.enable(BLEND) and gl.blendFunc(ONE, ONE), which set the blend state of
// every draw buffer. With OES_draw_buffers_indexed the state cache also keeps one blend entry per draw buffer; if any
// of them survived the readback, the next draw of a pipeline whose targets blend differently would skip disableiOES
// and blendFuncSeparateiOES and draw target 0 blended ONE, ONE. The suspected stale entry does not reproduce: the
// helper draw state (Replayer.helperState) already forgot every draw buffer's entry before the readback, and the
// readback forgets every slot itself too (src/device/readback.ts, stencilInto). This test passes on the code before
// and after KB-COMPAT-FRAMEALLOC1 part 2, and fails when neither forgets the draw buffers' entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompatGPU } from '../dist/device.js';
import { loggingContext } from './support/logging-gl.js';

// Usage flags by value (GPUBufferUsage and GPUTextureUsage are browser globals).
const B = { MAP_READ: 0x1, COPY_DST: 0x8 };
const T = { COPY_SRC: 0x1, RENDER_ATTACHMENT: 0x10 };

/** A logging stand-in that also has OES_draw_buffers_indexed, whose calls log under their own names. */
function indexedContext() {
  const gl = loggingContext();
  const base = gl.getExtension;
  const indexed = new Proxy(
    {},
    {
      get: (_, key) =>
        typeof key === 'string' && key.endsWith('iOES') ? (...args) => void gl.calls.push([key, ...args]) : undefined,
    },
  );
  gl.getExtension = (name) => (name === 'OES_draw_buffers_indexed' ? indexed : base(name));
  return gl;
}

test('a stencil readback leaves no stale per-draw-buffer blend state behind (OES_draw_buffers_indexed)', async () => {
  const gl = indexedContext();
  const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
  const code = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
struct O { @location(0) a: vec4f, @location(1) b: vec4f };
@fragment fn fs() -> O { return O(vec4f(1.0), vec4f(1.0)); }`;
  const module = device.createShaderModule({ code });
  // Two targets that blend differently, so the replay sets each draw buffer's blend state on its own.
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        { format: 'rgba8unorm' },
        {
          format: 'rgba8unorm',
          blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} },
        },
      ],
    },
  });
  const colors = [0, 1].map(() =>
    device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT }),
  );
  const stencil = device.createTexture({ size: [4, 4], format: 'stencil8', usage: T.COPY_SRC | T.RENDER_ATTACHMENT });
  const out = device.createBuffer({ size: 256 * 4, usage: B.COPY_DST | B.MAP_READ });
  const errors = [];
  device.addEventListener('uncapturederror', (e) => (e.preventDefault(), errors.push(e.error.message)));

  const draw = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: colors.map((t) => ({ view: t.createView(), loadOp: 'load', storeOp: 'store' })),
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const blendCalls = (from) =>
    gl.calls
      .slice(from)
      .filter((c) => /^(enable|disable)iOES$|^blend(Func|Equation)SeparateiOES$/.test(c[0]))
      .map((c) => `${c[0]}(${c.slice(c[0].endsWith('ableiOES') ? 2 : 1, c[0].endsWith('ableiOES') ? 3 : 2)})`);

  let from = gl.calls.length;
  draw();
  const first = blendCalls(from);
  // The first draw sets both draw buffers: 0 off, 1 on with its equation and factors.
  assert.deepEqual(first, [
    'disableiOES(0)',
    'enableiOES(1)',
    'blendEquationSeparateiOES(1)',
    'blendFuncSeparateiOES(1)',
  ]);

  // A second draw with nothing in between changes nothing: the cache holds.
  from = gl.calls.length;
  draw();
  assert.deepEqual(blendCalls(from), []);

  // The stencil readback, which blends its bit planes ONE, ONE on every draw buffer.
  from = gl.calls.length;
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: stencil, aspect: 'stencil-only' }, { buffer: out, bytesPerRow: 256 }, [4, 4]);
  device.queue.submit([encoder.finish()]);
  // The first readback loads its module (src/device/readback.ts) before it runs, after this submit returns.
  await device.queue.onSubmittedWorkDone();
  const readback = gl.calls.slice(from);
  assert.equal(readback.filter((c) => c[0] === 'stencilFunc').length, 8, 'the readback drew its eight bit planes');
  assert.ok(
    readback.some((c) => c[0] === 'enable' && c[1] === gl.BLEND),
    'the readback enabled blending GL-wide',
  );

  // The next draw sets both draw buffers again, as after any change it cannot see.
  from = gl.calls.length;
  draw();
  assert.deepEqual(blendCalls(from), first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, []);
});
