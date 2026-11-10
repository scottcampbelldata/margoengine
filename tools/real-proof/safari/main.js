// Real browser check: the same page runs in Safari on the Mac and in Edge on the PC, and posts what it sees.
import { createStage } from '@margoengine/stage';
import { loadGLTF } from '@margoengine/gltf-pro';
import { JXLDecoder } from '@margoengine/decoders/jxl';
import { recordCanvas } from '@margoengine/video/record';
const report = { ua: navigator.userAgent, gpu: !!navigator.gpu, models: {}, jxl: {}, errors: [] };
window.addEventListener('error', (e) => report.errors.push('error ' + e.message));
window.addEventListener('unhandledrejection', (e) => report.errors.push('rejection ' + (e.reason?.message ?? e.reason)));
const log = (s) => { (report.log ??= []).push(Math.round(performance.now()) + ' ' + s.slice(0, 300)); document.getElementById('log').textContent += s + '\n'; };
const only = new URLSearchParams(location.search).get('only'); // 'record' skips models and JPEG XL
report.visibility = document.visibilityState;
const post = (done) => fetch('/report', { method: 'POST', body: JSON.stringify({ ...report, done }) });
const sha = async (u) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map((b) => b.toString(16).padStart(2, '0')).join('');
const models = ['Fox', 'Lantern', 'ToyCar', 'robot-expressive', 'MetalRoughSpheres'];
try {
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    report.adapter = adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description } : null;
  }
  for (const name of only === 'record' ? [] : models) {
    const host = document.createElement('div'); host.style.cssText = 'width:512px;height:512px';
    document.getElementById('scene').replaceChildren(host);
    const row = (report.models[name] = {});
    try {
      const app = await createStage(host, { autoStart: false, controls: false });
      const cam = app.engine.camera, fit = cam.fitToBoundingBox; cam.fitToBoundingBox = (a, b, o) => fit.call(cam, a, b, { ...o, duration: 0 });
      row.backend = app.engine.backend ?? app.engine.gpu?.constructor?.name;
      const gpu = app.engine.gpu; gpu?.pushErrorScope?.('validation');
      await loadGLTF(app.engine, `./m/${name}.glb`); app.fit();
      for (let i = 0; i < 4; i++) { app.engine.render(); await new Promise((ok) => setTimeout(ok, 30)); }
      const canvas = host.querySelector('canvas');
      app.engine.render();
      row.png = canvas.toDataURL('image/png');
      row.size = [canvas.width, canvas.height];
      row.drawCalls = app.engine.stats?.drawCalls;
      const scope = await gpu?.popErrorScope?.(); if (scope) row.validation = scope.message;
      app.dispose();
    } catch (e) { row.error = String(e?.message ?? e).slice(0, 300) + ' @ ' + String(e?.stack ?? '').slice(0, 200); }
    log(name + ' ' + (row.error ?? 'ok')); await post(false);
  }
  const records = await (await fetch('./jxl/records.json')).json();
  const native = new JXLDecoder({ workerLimit: 1 }), wasm = new JXLDecoder({ browser: false, workerLimit: 1 });
  for (const [name, record] of only === 'record' ? [] : Object.entries(records)) {
    const bytes = new Uint8Array(await (await fetch(`./jxl/${name}.jxl`)).arrayBuffer()), row = (report.jxl[name] = { record: record.sha256 });
    try {
      const a = await wasm.decode(bytes.slice());
      row.wasm = { decoder: a.decoder, size: [a.width, a.height], sha: await sha(a.data) };
      row.wasmEqualsRecord = row.wasm.sha === record.sha256;
      const b = await native.decode(bytes.slice());
      row.native = { decoder: b.decoder, size: [b.width, b.height] };
      if (b.data.length === a.data.length) {
        let worst = 0, over = 0, sum = 0, solidWorst = 0, solidSum = 0, solidN = 0, alphaWorst = 0;
        for (let i = 0; i < a.data.length; i += 4) { const alpha = a.data[i + 3], solid = alpha > 8; alphaWorst = Math.max(alphaWorst, Math.abs(alpha - b.data[i + 3])); for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i + c] - b.data[i + c]); sum += d; if (d > worst) worst = d; if (d > 2) over++; if (solid) { solidSum += d; solidN++; if (d > solidWorst) solidWorst = d; } } }
        Object.assign(row.native, { worst, over2: over, mean: +(sum / (a.data.length * 0.75)).toFixed(4), solidWorst, solidMean: +(solidSum / Math.max(1, solidN)).toFixed(4), alphaWorst });
        if (name === 'bench_oriented_brg' || name === 'grayscale') { const shot = (d) => { const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(d), a.width, a.height), 0, 0); return c.toDataURL('image/png'); }; row.shots = { wasm: shot(a.data), native: shot(b.data) }; }
      }
    } catch (e) { row.error = String(e?.message ?? e).slice(0, 300); }
    log(name + ' ' + JSON.stringify(row).slice(0, 200)); await post(false);
  }
  native.dispose(); wasm.dispose();
  // Recording (LIM-571): a WebGPU canvas drawing Fox while the camera turns, posted to the server so QuickTime can open it.
  report.recordings = {}; log('recording'); await post(false);
  for (const format of ['mp4', 'webm']) {
    const row = (report.recordings[format] = { supported: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/' + format) });
    if (!row.supported) continue;
    // A hidden page (a locked screen, a covered window) presents no canvas frames, so there is nothing to record.
    if (document.visibilityState === 'hidden') { row.skipped = 'page hidden: unlock the screen and keep the window in front'; continue; }
    const host = document.createElement('div'); host.style.cssText = 'width:512px;height:512px';
    document.getElementById('scene').replaceChildren(host);
    try {
      const app = await createStage(host, { autoStart: false, controls: false });
      log('record ' + format + ' stage ready, ' + document.visibilityState); await post(false);
      const cam = app.engine.camera, fit = cam.fitToBoundingBox; cam.fitToBoundingBox = (a, b, o) => fit.call(cam, a, b, { ...o, duration: 0 });
      await loadGLTF(app.engine, './m/Fox.glb'); app.fit(); app.engine.render();
      log('record ' + format + ' Fox drawn'); await post(false);
      const [tx, , tz] = cam.target, [px, py, pz] = cam.position, r = Math.hypot(px - tx, pz - tz);
      const canvas = host.querySelector('canvas'), rec = recordCanvas(canvas, { format, fps: 30 });
      const t0 = performance.now(); let frames = 0;
      while (performance.now() - t0 < 3000) {
        const a = ((performance.now() - t0) / 3000) * Math.PI;
        cam.position = [tx + r * Math.sin(a), py, tz + r * Math.cos(a)];
        const f0 = performance.now(); app.engine.render(); frames++;
        (row.frameMs ??= []).push(Math.round(performance.now() - f0));
        if (frames === 1) row.firstPng = canvas.toDataURL('image/png');
        await new Promise((ok) => setTimeout(ok, 33));
      }
      log("record " + format + " stopping after " + frames + " frames"); await post(false);
      const blob = await Promise.race([rec.stop(), new Promise((_, no) => setTimeout(() => no(new Error("stop() did not settle in 20 s")), 20000))]);
      Object.assign(row, { type: blob.type, bytes: blob.size, frames, size: [canvas.width, canvas.height] });
      await fetch('/file/record.' + format, { method: 'POST', body: blob });
      app.dispose();
    } catch (e) { row.error = String(e?.message ?? e).slice(0, 300); }
    log('record ' + format + ' ' + JSON.stringify({ ...row, firstPng: undefined })); await post(false);
  }
} catch (e) { report.errors.push(String(e?.stack ?? e).slice(0, 600)); }
await post(true);
log('done');
