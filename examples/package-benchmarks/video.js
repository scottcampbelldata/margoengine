import {Video} from '../../packages/video/dist/index.js';
import {controls} from './ui-scene.js';

export function createWorkload(count = 4, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Video surface count must be 1..9');
  options.signal?.throwIfAborted(); const points = new Float32Array(count * 4), side = Math.ceil(Math.sqrt(count)), extent = side * 0.6, surfaces = [], life = new AbortController();
  let context, canvas, drawing, stream, track, video, ui, readyFrame = () => {}, callback = 0, time = 0, frames = 0, requestedFrames = 0, receivedFrames = 0, sourceEnabled = true, disposed = false, sourceError = null, initializationElapsedMilliseconds = 0;
  const stop = () => {if (video) {video.pause(); sourceEnabled = false;}};
  const dispose = () => {if (disposed) return; disposed = true; options.signal?.removeEventListener('abort', dispose); life.abort(); if (callback) video?.cancelVideoFrameCallback(callback); callback = 0; surfaces.forEach(surface => surface.dispose()); stop(); stream?.getTracks().forEach(track => track.stop()); if (video) video.srcObject = null; ui?.dispose(); context = null;};
  options.signal?.addEventListener('abort', dispose, {once: true});
  const draw = () => {
    if (!drawing) return; drawing.fillStyle = '#182334'; drawing.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 8; i++) {drawing.fillStyle = ['#82d9ba', '#e6bb79', '#a8a3e6'][i % 3]; drawing.fillRect(i * 32 + 2, 55 + Math.sin(time * 2 + i * 0.6) * 30, 28, 32);}
    drawing.fillStyle = '#edf2f7'; drawing.font = '13px monospace'; drawing.fillText('Generated MediaStream', 12, 19); track?.requestFrame(); requestedFrames++;
  };
  const receive = () => {if (disposed) return; callback = video.requestVideoFrameCallback(() => {if (disposed) return; receivedFrames++; readyFrame(); receive();});};
  const step = delta => {
    if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid video frame delta'); time += delta; frames++;
    for (let i = 0; i < count; i++) {points[i * 4] = (i % side - (side - 1) / 2) * 1.2; points[i * 4 + 1] = 0.4 + Math.sin(time + i) * 0.15; points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 1.2; points[i * 4 + 3] = i % 3;}
    if (video && sourceEnabled) {if (video.paused) void video.play().catch(error => {if (!disposed) sourceError = String(error.message).slice(0, 160);}); draw();}
  };
  step(0);
  return {points, get source() {return video;}, surfaces, bounds: {min: [-extent, 0, -extent], max: [extent, 1.2, extent]},
    description: 'Actual HTMLVideoElement MediaStream frames are imported by the Video package as WebGPU external textures into 1/4/9 screen rectangles over moving depth anchors. The source is a generated 256×128 canvas stream. File decoding/codecs are outside this workload. Per-frame source drawing/requestFrame is counted in workload CPU; media delivery and external-texture execution are separate.', step,
    async mount(value) {
      if (disposed) throw new Error('Video workload is disposed'); if (context) throw new Error('Video workload is already mounted'); context = value;
      if (value.engine.backend !== 'webgpu') {dispose(); throw new Error('Video benchmark requires WebGPU external-texture draws');}
      const start = performance.now(), document = value.parent.ownerDocument;
      try {
        canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128; drawing = canvas.getContext('2d');
        if (!drawing || !canvas.captureStream) throw new Error('Canvas MediaStream capture is unavailable');
        stream = canvas.captureStream(0); track = stream.getVideoTracks()[0]; if (!track?.requestFrame) throw new Error('Explicit video frame capture is unavailable');
        video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
        if (!video.requestVideoFrameCallback) throw new Error('Video frame delivery observation is unavailable'); receive();
        await new Promise((resolve, reject) => {
          const cleanup = () => {readyFrame = () => {}; clearTimeout(timeout); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed); life.signal.removeEventListener('abort', aborted);};
          const ready = () => {if (video.readyState >= 2 && video.videoWidth && receivedFrames > 0) {cleanup(); resolve();}};
          const failed = () => {cleanup(); reject(new Error('Generated video source failed to load'));};
          const aborted = () => {cleanup(); reject(new DOMException('Video workload disposed', 'AbortError'));};
          const timeout = setTimeout(() => {cleanup(); reject(new Error('Video source frame was not ready within 5 seconds'));}, 5000);
          video.addEventListener('loadeddata', ready); video.addEventListener('error', failed); life.signal.addEventListener('abort', aborted, {once: true});
          readyFrame = ready; void video.play().catch(error => {cleanup(); reject(error);}); draw(); ready();
        });
        if (disposed) throw new DOMException('Video workload disposed', 'AbortError'); options.signal?.throwIfAborted();
        for (let i = 0; i < count; i++) surfaces.push(Video.attach(value.engine, video, {rect: [(i % side) / side + 0.06 / side, Math.floor(i / side) / side + 0.06 / side, 0.88 / side, 0.88 / side]}));
        ui = controls(value.parent, count, () => {}); ui.actor.parentElement.remove();
        ui.button('Toggle source frame generation', () => {sourceEnabled = !sourceEnabled; if (!sourceEnabled) video.pause(); else void video.play().then(() => {if (!disposed) {draw(); value.render();}}, error => {if (!disposed) sourceError = String(error.message).slice(0, 160);});}).dataset.uiVideo = '';
        initializationElapsedMilliseconds = performance.now() - start;
      } catch (error) {dispose(); throw error;}
    },
    details: () => ({surfaces: surfaces.length, generatedSourcePixels: [256, 128], frames, requestedFrames, receivedFrames, sourceEnabled, sourceReady: !!video && video.readyState >= 2 && video.videoWidth > 0, sourcePaused: video?.paused ?? true, sourceAttached: !!video?.srcObject, sourceTrackState: track?.readyState ?? null, sourceError, initializationElapsedMilliseconds}), dispose
  };
}
