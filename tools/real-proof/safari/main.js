// Real browser check: the same page runs in Safari on the Mac and in Edge on the PC, and posts what it sees.
import { createStage } from '@margoengine/stage';
import { loadGLTF } from '@margoengine/gltf-pro';
import { JXLDecoder } from '@margoengine/decoders/jxl';
const report = { ua: navigator.userAgent, gpu: !!navigator.gpu, models: {}, jxl: {}, errors: [] };
window.addEventListener('error', (e) => report.errors.push('error ' + e.message));
window.addEventListener('unhandledrejection', (e) => report.errors.push('rejection ' + (e.reason?.message ?? e.reason)));
const log = (s) => { document.getElementById('log').textContent += s + '\n'; };
const post = (done) => fetch('/report', { method: 'POST', body: JSON.stringify({ ...report, done }) });
const sha = async (u) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map((b) => b.toString(16).padStart(2, '0')).join('');
const models = ['Fox', 'Lantern', 'ToyCar', 'robot-expressive', 'MetalRoughSpheres'];
try {
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    report.adapter = adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description } : null;
  }
  for (const name of models) {
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
  for (const [name, record] of Object.entries(records)) {
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
} catch (e) { report.errors.push(String(e?.stack ?? e).slice(0, 600)); }
await post(true);
log('done');
