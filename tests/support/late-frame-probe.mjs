// Runs in its own process (node --allow-natives-syntax): whether one late frame deoptimizes core's frame loop. The
// loop (engine.start's requestAnimationFrame callback, stubbed) runs frames 16 ms apart until V8 optimizes it,
// then one frame comes `--late=<ms>` after the last (default 250, past the default maxDelta of 0.1 s), then 20 more.
// Prints JSON { before, after }: V8's optimization status of the loop before the late frame and after the frames that
// follow it (bit 16: optimized code). A deoptimized once-per-frame function runs thousands of frames in a lower tier,
// which boxes fractional numbers, so every frame then allocates more (the browser frame-allocation check saw it).
import { Engine, TransformStore, box } from '../../packages/core/dist/extension.js';
import { frameDriver, stillRenderer } from './still-gpu.mjs';

const late = Number(process.argv.find((a) => a.startsWith('--late='))?.slice(7) ?? 250);
const run = frameDriver(),
  { canvas, renderer } = stillRenderer(),
  engine = new Engine(canvas, await TransformStore.create(16), renderer, undefined, null),
  mesh = engine.createMesh().setGeometry(box()),
  clock = new Float64Array(1);
engine.onFrame((_, delta) => {
  mesh.position.y = Math.sin((clock[0] += delta));
});
engine.start();
const loop = run.loop(),
  status = new Function('f', 'return %GetOptimizationStatus(f)');
// V8 compiles on a background thread, so on a loaded machine optimized code arrives later: run until it has (bit 16),
// at most 200,000 frames.
run(20_000);
for (let i = 0; i < 180 && !(status(loop) & 16); i++) run(1000);
const before = status(loop);
run(1, late);
run(20);
const after = status(loop);
engine.dispose();
console.log(JSON.stringify({ before, after }));
