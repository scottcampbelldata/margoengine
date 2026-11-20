// KB-WATER-SURFCOMPILE1 regression: every shader entry point that evaluates the water surface compiles one copy of
// surface(). A shader compiler inlines every function call (HLSL has no real calls, and the WebGL2 layer's D3D11 ANGLE
// backend hands HLSL to FXC), so a vertex stage that called surface() three times, once per triangle corner, compiled
// three copies of the swell, the surf and the coast: Caustics' beams and range, and the surface capture's field and
// probe stages took 3.9 to 4.9 s each on the layer and one PostStack frame with Caustics and Underwater about 22 s,
// past check:owners' 20 s readiness wait. The corners now come from one call in a loop. The count is static, read
// from the WGSL each pipeline was made with, so it holds on any machine. Runs on WebGPU or (MARGO_COMPAT=1) the WebGL2
// compatibility layer.
// Sources: Microsoft, "call (HLSL)", XNA Game Studio docs (the HLSL compiler inlines all user-defined functions),
// https://learn.microsoft.com/previous-versions/windows/xna/bb313973(v=xnagamestudio.10); LLVM, "[HLSL] set
// alwaysinline on HLSL functions" (clang PR 106588, 2024: HLSL inlines every function by default),
// https://lists.llvm.org/pipermail/cfe-commits/Week-of-Mon-20240916/621427.html; ANGLE's HLSL translator, which emits
// [loop] and [unroll] only where a loop needs them (https://chromium.googlesource.com/angle/angle.git/+/main/src/compiler/translator/hlsl/OutputHLSL.h).
// The per-copy cost was measured here (known-bugs KB-WATER-SURFCOMPILE1), not taken from them.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

/** Top-level functions of a WGSL module: name to body text (between its braces). */
export function wgslFunctions(code) {
  const functions = new Map(),
    head = /\bfn\s+(\w+)\s*\(/g;
  for (let match; (match = head.exec(code)); ) {
    let i = code.indexOf('{', match.index),
      depth = 0;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) break;
    }
    functions.set(match[1], code.slice(start + 1, i));
    head.lastIndex = i;
  }
  return functions;
}

/** How many copies of `target` an entry point holds once every call is inlined. */
export function inlinedCopies(code, entry, target) {
  const functions = wgslFunctions(code),
    memo = new Map();
  const copies = (name) => {
    if (name === target) return 1;
    if (memo.has(name)) return memo.get(name);
    let total = 0;
    for (const callee of functions.keys()) {
      if (callee === name) continue;
      const calls = functions.get(name).match(new RegExp(`(?<![\\w.])${callee}\\s*\\(`, 'g'))?.length ?? 0;
      if (calls) total += calls * copies(callee);
    }
    memo.set(name, total);
    return total;
  };
  return functions.has(entry) ? copies(entry) : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The counter itself: three calls through a helper make three copies; one call in a loop makes one.
  const three = 'fn surface(x:f32)->f32{return x;}fn corner(i:u32)->f32{return surface(f32(i));}\n' +
    'fn main(){let a=corner(0u);let b=corner(1u);let c=corner(2u);}';
  const one = 'fn surface(x:f32)->f32{return x;}fn corner(i:u32)->f32{return surface(f32(i));}\n' +
    'fn main(){var s:array<f32,3>;for(var k=0u;k<3u;k++){s[k]=corner(k);}}';
  assert.equal(inlinedCopies(three, 'main', 'surface'), 3);
  assert.equal(inlinedCopies(one, 'main', 'surface'), 1);

  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
    { page } = browser,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    const stages = await page.evaluate(async () => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { Caustics } = await import('/packages/water/dist/caustics.js'),
        { Underwater } = await import('/packages/water/dist/underwater.js'),
        { WaveQuery } = await import('/packages/water/dist/query.js'),
        { PostStack } = await import('/packages/post/dist/stack.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:32px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
      engine.stop();
      // Every pipeline's WGSL and entry points, as the device was asked for them.
      const codes = new Map(),
        stages = [],
        device = engine.gpu,
        module = device.createShaderModule.bind(device),
        render = device.createRenderPipeline.bind(device),
        compute = device.createComputePipeline.bind(device);
      device.createShaderModule = (descriptor) => {
        const made = module(descriptor);
        codes.set(made, descriptor.code);
        return made;
      };
      const note = (stage) => stage && stages.push({ code: codes.get(stage.module), entry: stage.entryPoint });
      device.createRenderPipeline = (descriptor) => {
        note(descriptor.vertex);
        note(descriptor.fragment);
        return render(descriptor);
      };
      device.createComputePipeline = (descriptor) => {
        note(descriptor.compute);
        return compute(descriptor);
      };
      const water = new Water({ size: [16, 16], segments: 16 });
      engine.scene.use(water);
      const stack = PostStack.attach(engine, [new Caustics({ surface: water, size: 16 }), new Underwater({ surface: water })]);
      engine.render({ delta: 0.125 });
      await device.queue.onSubmittedWorkDone();
      // A capture is taken by the next render (the engine's own loop is stopped here).
      const capture = WaveQuery.capture(water);
      engine.render({ delta: 0.125 });
      await device.queue.onSubmittedWorkDone();
      await capture;
      stack.dispose();
      water.dispose();
      engine.destroy?.();
      return stages.filter((s) => s.code?.includes('fn surface(xz:vec2f'));
    });
    const counted = stages.map((s) => ({ entry: s.entry, copies: inlinedCopies(s.code, s.entry, 'surface') }));
    console.log(counted.map((s) => `${s.entry} ${s.copies}`).join(', '));
    // The water's own vertex stage, Caustics' beams and range, and the capture's mask, field and probe stages.
    for (const entry of ['vertex', 'beamVertex', 'measure', 'maskVertex', 'fieldVertex', 'probeVertex'])
      assert.ok(counted.some((s) => s.entry === entry && s.copies > 0), `${entry} evaluates the surface`);
    for (const s of counted) assert.ok(s.copies <= 1, `${s.entry} compiles ${s.copies} copies of surface()`);
    assert.deepEqual(errors, []);
    console.log('water surface copies PASS: one compiled surface() per entry point');
  } finally {
    await browser.close();
  }
}
