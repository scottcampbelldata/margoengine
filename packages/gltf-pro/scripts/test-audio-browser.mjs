import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

// A generated PCM test signal, not a demo asset: RIFF/WAVE, mono signed 16-bit, 48 kHz, 100 ms.
const wave = new Uint8Array(44 + 4800 * 2),
  header = new DataView(wave.buffer);
for (const [offset, text] of [
  [0, 'RIFF'],
  [8, 'WAVE'],
  [12, 'fmt '],
  [36, 'data'],
])
  wave.set(new TextEncoder().encode(text), offset);
for (const [offset, value] of [
  [4, wave.length - 8],
  [16, 16],
  [24, 48000],
  [28, 96000],
  [40, 9600],
])
  header.setUint32(offset, value, true);
for (const [offset, value] of [
  [20, 1],
  [22, 1],
  [32, 2],
  [34, 16],
])
  header.setUint16(offset, value, true);
for (let i = 0; i < 4800; i++)
  header.setInt16(44 + i * 2, Math.round(Math.sin((i * 2 * Math.PI * 1000) / 48000) * 16384), true);
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const rows = await browser.page.evaluate(async (bytes) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js');
      const { applyGLTFAudio } = await import('/packages/gltf-pro/dist/audio.js');
      const { AudioListener, PositionalAudio } = await import('/packages/audio/dist/index.js');
      const uri = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes));
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 0], target: [0, 0, -1] },
      });
      engine.stop();
      const validation = [];
      engine.gpu.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
      engine.gpu.pushErrorScope('validation');
      const rows = [];
      try {
        for (const extension of ['KHR_audio_emitter', 'MSFT_audio_emitter']) {
          const context = new OfflineAudioContext(2, 4800, 48000);
          const listener = AudioListener.attach(engine, { context, smoothing: 0, autoResume: false });
          const khr = extension === 'KHR_audio_emitter';
          const doc = {
            asset: { version: '2.0' },
            extensionsRequired: [extension],
            extensions: {
              [extension]: khr
                ? {
                    audio: [{ uri }],
                    sources: [{ audio: 0, autoPlay: true }],
                    emitters: [{ type: 'positional', sources: [0] }],
                  }
                : {
                    clips: [{ bufferView: 0, mimeType: 'audio/wav' }],
                    emitters: [{ clips: [{ clip: 0, weight: 1 }] }],
                  },
            },
            nodes: [{ translation: [3, 0, 0], extensions: { [extension]: khr ? { emitter: 0 } : { emitters: [0] } } }],
            scenes: [{ nodes: [0] }],
          };
          if (!khr) {
            doc.buffers = [
              {
                byteLength: bytes.length,
                uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes)),
              },
            ];
            doc.bufferViews = [{ buffer: 0, byteLength: bytes.length }];
          }
          const model = await parseGLTFAsync(engine, doc);
          try {
            const attached = await applyGLTFAudio(model, listener, { autoplay: true });
            const sound = attached.emitters[0].sources[0];
            // Equal-power has an analytic channel-energy oracle; HRTF intentionally has cross-ear energy.
            sound.panningModel = 'equalpower';
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
            if (!(sound instanceof PositionalAudio)) throw new Error('audio must use the caller package instance');
            const position = Array.from(sound.worldPosition),
              direction = Array.from(sound.worldDirection);
            const rendered = await context.startRendering();
            const energy = [0, 0];
            for (let c = 0; c < 2; c++) for (const v of rendered.getChannelData(c)) energy[c] += v * v;
            model.nodes[0].setPosition([-3, 0, 0]);
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
            rows.push({
              extension,
              position,
              direction,
              afterMove: Array.from(sound.worldPosition),
              energy,
              frames: rendered.length,
            });
            model.dispose();
            if (!sound.disposed) throw new Error('model disposal must release its emitter sources');
          } finally {
            model.dispose();
            engine.removePlugin(listener.name);
          }
        }
        const scoped = await engine.gpu.popErrorScope();
        if (scoped) validation.push(scoped.message);
        return { rows, validation };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    }, Array.from(wave));
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.validation, []);
    for (const row of rows.rows) {
      assert.deepEqual(row.position, [3, 0, 0]);
      assert.deepEqual(row.afterMove, [-3, 0, 0]);
      assert.deepEqual(row.direction, [0, 0, row.extension === 'KHR_audio_emitter' ? -1 : 1]);
      assert.equal(row.frames, 4800);
      assert.ok(row.energy[1] > 1 && row.energy[0] < row.energy[1] * 0.01, JSON.stringify(row));
    }
    writeFileSync(
      'test-results/batch201-audio' + (process.argv.includes('--compat') ? '-compat' : '') + '.json',
      JSON.stringify({ hardware: browser.hardware, ...rows }, null, 2),
    );
    console.log(JSON.stringify(rows));
  },
  () => browser.close(),
);
