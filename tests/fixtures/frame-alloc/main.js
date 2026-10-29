// Scenes for the steady-state frame allocation check (scripts/frame-alloc-browser.mjs). `?scene=` picks one:
//   basic      core + stage: three lit meshes, one turning, CAD camera controls on (createStage's default)
//   instanced  core + stage: 10,000 boxes of one geometry and material (one instanced draw), every box moving
//   shadowed   basic plus @margoengine/shadows (addShadows): cascaded shadows, eight moving casters
//   post       basic plus @margoengine/post PostStack (SSAO, Bloom, FXAA) and @margoengine/tonemap
// The app code here allocates nothing per frame (typed-array and setter writes only), so what a frame allocates is the
// engine's. The heap is sampled once per frame, before the frame renders, from an engine.onFrame callback:
// performance.memory.usedJSHeapSize (exact bytes with --enable-precise-memory-info) into a preallocated Float64Array.
import { createStage, box } from 'margoengine';
import { addShadows } from 'margoengine/stage/shadows';
import { PostStack } from 'margoengine/post/stack';
import { SSAO } from 'margoengine/post/ssao';
import { Bloom } from 'margoengine/post/bloom';
import { FXAA } from 'margoengine/post/fxaa';
import { Tonemap } from 'margoengine/tonemap';

const params = new URLSearchParams(location.search),
  scene = params.get('scene') ?? 'basic',
  warmup = Number(params.get('warmup') ?? 600),
  frames = Number(params.get('frames') ?? 600);

/** Ground, a turning box and a sphere; returns the meshes that move. */
function room(app) {
  app.box({ size: [12, 0.2, 12], position: [0, -0.1, 0], color: [0.6, 0.6, 0.6] });
  const spinner = app.box({ size: [1, 1, 1], position: [-1.2, 0.6, 0], color: [0.9, 0.3, 0.2] });
  app.sphere({ radius: 0.6, position: [1.2, 0.6, 0], color: [0.2, 0.5, 0.9], metalness: 0.5, roughness: 0.3 });
  return [spinner];
}

async function build() {
  const app = await createStage('#scene'),
    engine = app.engine;
  let movers = [];
  if (scene === 'instanced') {
    const geometry = box(0.4, 0.4, 0.4);
    for (let i = 0; i < 10_000; i++) {
      const mesh = engine.createMesh();
      mesh.setGeometry(geometry);
      mesh.position.set((i % 100) - 49.5, 0, Math.floor(i / 100) - 49.5);
      movers.push(mesh);
    }
    // One shared material: setGeometry gives every mesh the default PbrMaterial, so they batch into one draw.
  } else movers = room(app);
  if (scene === 'shadowed') {
    for (let i = 0; i < 8; i++)
      movers.push(app.box({ size: [0.5, 0.5, 0.5], position: [Math.cos(i) * 3, 1.5, Math.sin(i) * 3] }));
    await addShadows(app, { resolution: 1024 });
  }
  if (scene === 'post') PostStack.attach(engine, [new SSAO(), new Bloom({ strength: 0.6 }), new Tonemap(), new FXAA()]);
  if (!['basic', 'instanced', 'shadowed', 'post'].includes(scene)) throw new TypeError(`Unknown scene ${scene}`);
  app.fit();

  // Motion: every mover's height and turn change each frame (the setter path, a changed matrix and an instance patch).
  // The clock lives in a typed array: a closure variable holding a fraction would box a new number every frame.
  const clock = new Float64Array(1);
  const count = movers.length;
  engine.onFrame((_, delta) => {
    const time = (clock[0] += delta);
    for (let i = 0; i < count; i++) {
      const mesh = movers[i];
      mesh.rotation.y = time + i * 0.001;
      mesh.position.y = 0.6 + 0.2 * Math.sin(time * 2 + i * 0.01);
    }
  });

  // Sampling: heap[k] before frame k of the recorded run. `read` is the cost of one sample, measured as the difference
  // between back-to-back reads (the MemoryInfo object each read creates; the first read ever also builds its wrapper
  // template, so it is left out), and subtracted per frame.
  const heap = new Float64Array(frames + 1),
    reads = new Float64Array(4);
  let frame = 0;
  await new Promise((done) => {
    const stop = engine.onFrame(() => {
      frame++;
      if (frame === warmup) {
        // Tells a --profile run to start its sampling heap profile (before the recorded frames).
        if (params.has('profile')) console.info('frame-alloc:record');
        reads[0] = performance.memory.usedJSHeapSize;
        reads[1] = performance.memory.usedJSHeapSize;
        reads[2] = performance.memory.usedJSHeapSize;
        reads[3] = performance.memory.usedJSHeapSize;
      } else if (frame > warmup) {
        heap[frame - warmup - 1] = performance.memory.usedJSHeapSize;
        if (frame - warmup - 1 === frames) {
          stop();
          done();
        }
      }
    });
  });
  engine.stop();
  return {
    heap: Array.from(heap),
    read: [reads[2] - reads[1], reads[3] - reads[2]],
    drawCalls: engine.stats.drawCalls,
  };
}

// Awaited once by the check (page.evaluate), so nothing polls the page while frames are recorded.
window.frameAlloc = build().then(
  (result) => ({ scene, warmup, frames, ...result }),
  (error) => ({ scene, error: String(error?.stack ?? error) }),
);
