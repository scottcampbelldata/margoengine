import { ComposedVoxelPathTracer } from '@margoengine/voxel-pathtracer/compose';
import { triangleMeshes } from '@margoengine/voxel-pathtracer/mesh';
import { spectralTransport } from '@margoengine/voxel-pathtracer/spectral';
import { glasshouse } from './glasshouse.js';

const canvas = document.querySelector('#glasshouse');
const exhibit = document.querySelector('#exhibit');
const notice = document.querySelector('#status');
const capture = new URLSearchParams(location.search).get('capture');
const film = capture !== null && capture !== 'opening';
const fixedCapture = capture === 'opening' && new URLSearchParams(location.search).get('glass') === 'fixed';
const webSettings = {
  aperture: .025, lensBlades: 9, exposure: -.14, clamp: 3.25, denoise: 'auto', maxBounces: 11,
};

function camera(engine, time) {
  const t = Math.min(1, Math.max(0, time / 10));
  const move = t * t * (3 - 2 * t);
  engine.camera.position = [2.13 - .54 * move, 1.23 - .16 * move, 3.90 - .67 * move];
  engine.camera.target = [.31 + .39 * move, .45 - .12 * move, .13 + .22 * move];
}

function resize() {
  const width = Math.max(1, Math.min(1280, Math.round(canvas.parentElement.clientWidth * devicePixelRatio)));
  const height = Math.max(1, Math.round(width * 9 / 16));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

export async function open(engine, { signal, ready, sampleCount, onError, capturePrepared,selected,active,attach }) {
  let tracer, frame, observer, rendered = false, queueing = false, disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    tracer?.dispose();
    engine.dispose();
  }
  function fail(reason) {
    if (signal.aborted || disposed) return;
    onError(reason);
    queueMicrotask(dispose);
  }
  signal.addEventListener('abort', dispose, { once: true });
  signal.throwIfAborted();
  engine.onError = fail;

  const features = [triangleMeshes(), spectralTransport()];
  if (film) {
    const { causticGuiding } = await import('@margoengine/voxel-pathtracer/guiding');
    features.push(causticGuiding({ guideStrength: .67 }));
  }
  const settings = film ? { aperture: .025, exposure: -.2, denoise: 'auto', maxBounces: 11 } : webSettings;
  let glass=capture!==null?(fixedCapture?'fixed':'flint'):selected();
  const authored=glasshouse({analyticSlits:!film});
  const opticalScene=choice=>choice==='flint'?authored:{...authored,materials:authored.materials.map(material=>
    material.id===4?{...material,abbe:0}:material)};
  tracer = await ComposedVoxelPathTracer.create(engine, {
    scene: opticalScene(glass), features, ...settings,
    samplesPerFrame: 3, maxSamples: 144, signal,
  });
  performance.mark('glasshouse-mesh-ready');
  await tracer.ready;
  signal.throwIfAborted();
  performance.mark('glasshouse-pipelines-ready');
  exhibit.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'compatibility' : 'webgpu';
  exhibit.dataset.triangles = String(tracer.stats.meshTriangles);
  camera(engine, 0);

  if (capture !== null) {
    window.captureGlasshouseFrame = async ({time=0, width=1440, height=810, sampleCount=96, denoise=true, timeout=48000}={}) => {
      camera(engine, time);
      engine.render({ delta: 0 });
      const png = await tracer.capture({ width, height, samples: sampleCount, denoise,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
      return Array.from(new Uint8Array(await png.arrayBuffer()));
    };
    window.drawGlasshouseFrame = async ({ time, width, height, passes }) => {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      camera(engine, time);
      for (let pass = 0; pass < passes; pass++) {
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      }
      return tracer.stats.samples;
    };
    exhibit.dataset.captureReady = 'true';
    notice.hidden = true;
    capturePrepared();
    return;
  }

  function schedule() {
    if (frame === undefined && !queueing && !disposed && !signal.aborted && active()) frame = requestAnimationFrame(tick);
  }
  function snapshot() {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      engine.render({ delta: 0 });
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('The rendered frame could not be saved.'));
      }, 'image/png');
    });
  }
  async function tick() {
    frame = undefined;
    if (signal.aborted || disposed || !active()) return;
    queueing = true;
    try {
      const next=selected();
      if(next!==glass){
        await tracer.setScene(opticalScene(next),{signal});
        signal.throwIfAborted();
        glass=next;
        rendered=false;
        exhibit.dataset.samples='0';
      }
      if(!active()||selected()!==glass)return;
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      if (signal.aborted || disposed) return;
      const samples = tracer.stats.samples;
      if (samples >= 39 && !rendered && selected()===glass && active()) {
        rendered = true;
        ready({ snapshot, samples, glass });
      } else if (rendered) sampleCount(samples,glass);
      exhibit.dataset.samples = String(samples);
    } catch (reason) {
      fail(reason);
    } finally {
      queueing = false;
      if (!disposed && (!tracer.stats.converged||selected()!==glass)) schedule();
    }
  }
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas.parentElement);
  attach({refresh(){rendered=false;schedule();}});
  schedule();
}
