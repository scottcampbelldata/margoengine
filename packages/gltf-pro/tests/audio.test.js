import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGLTFAudio } from '../dist/audio.js';
import { parseGLTFAsync } from '../dist/index.js';
import { AudioListener, Audio, PositionalAudio } from '../../audio/dist/index.js';
import { FakeAudioContext } from '../../audio/tests/fake-web-audio.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const uri = (n) => 'data:audio/wav;base64,' + Buffer.alloc(n, n).toString('base64');
function context() {
  const ctx = new FakeAudioContext();
  ctx.decodeAudioData = (bytes) => {
    ctx.calls.push('decode');
    return Promise.resolve({ duration: 10, length: 480000, numberOfChannels: 1, bytes });
  };
  return ctx;
}
async function fixture(doc, run) {
  return headlessModels(async () => {
    const engine = await headless(),
      ctx = context(),
      listener = new AudioListener({ context: ctx, autoResume: false, smoothing: 0 });
    const model = await parseGLTFAsync(engine, { asset: { version: '2.0' }, ...doc });
    try {
      await run({ model, engine, listener, ctx });
    } finally {
      model.dispose();
      listener.dispose();
      engine.dispose();
    }
  });
}
const khr = () => ({
  extensionsRequired: ['KHR_audio_emitter'],
  extensions: {
    KHR_audio_emitter: {
      audio: [{ uri: uri(8) }],
      sources: [
        { audio: 0, gain: 0.25, loop: true, autoPlay: true },
        { audio: 0, gain: 0.3 },
      ],
      emitters: [
        {
          type: 'positional',
          gain: 0.5,
          sources: [0],
          positional: {
            shapeType: 'cone',
            coneInnerAngle: Math.PI / 2,
            coneOuterAngle: Math.PI,
            coneOuterGain: 0.2,
            distanceModel: 'linear',
            refDistance: 2,
            maxDistance: 30,
            rolloffFactor: 0.6,
          },
        },
        { type: 'global', gain: 2, sources: [1] },
      ],
    },
  },
  nodes: [{ extensions: { KHR_audio_emitter: { emitter: 0 } } }, { extensions: { KHR_audio_emitter: { emitter: 0 } } }],
  scenes: [{ nodes: [0], extensions: { KHR_audio_emitter: { emitters: [1] } } }, { nodes: [1] }],
});
const msft = () => ({
  extensionsRequired: ['MSFT_audio_emitter'],
  extensions: {
    MSFT_audio_emitter: {
      clips: [{ uri: uri(8) }, { uri: uri(16) }],
      emitters: [
        {
          clips: [
            { clip: 0, weight: 0 },
            { clip: 1, weight: 2 },
          ],
          innerAngle: Math.PI / 4,
          outerAngle: Math.PI / 2,
          loop: true,
          volume: 0.4,
        },
      ],
    },
  },
  nodes: [{ extensions: { MSFT_audio_emitter: { emitters: [0] } } }],
  animations: [
    {
      extensions: {
        MSFT_audio_emitter: {
          events: [
            { time: 0.5, action: 'play', emitter: 0, startOffset: 2 },
            { time: 1, action: 'pause', emitter: 0 },
            { time: 1.5, action: 'play', emitter: 0, startOffset: 99 },
            { time: 2, action: 'stop', emitter: 0 },
            { time: 2.2, action: 'play', emitter: 0, startOffset: 1 },
          ],
        },
      },
    },
  ],
});

test('explicit MSFT autoplay obeys clip weights before starting the source', async () =>
  fixture(msft(), async ({ model, listener }) => {
    const attached = await applyGLTFAudio(model, listener, { autoplay: true, random: () => 0 });
    const sound = attached.emitters[0].sources[0];
    assert.equal(sound.isPlaying, true);
    assert.equal(sound.buffer.bytes.byteLength, 16);
    attached.dispose();
  }));

test('KHR audio-only scene creates independent positional/global sources with shared decoded data and exact defaults', async () =>
  fixture(khr(), async ({ model, engine, listener, ctx }) => {
    assert.equal(model.primitives.length, 0);
    const result = await applyGLTFAudio(model, listener);
    assert.equal(result.emitters.length, 2, 'unselected scene node is not instantiated');
    const positional = result.emitters[0].sources[0],
      global = result.emitters[1].sources[0];
    assert.ok(positional instanceof PositionalAudio);
    assert.ok(global instanceof Audio);
    assert.ok(!(global instanceof PositionalAudio));
    assert.equal(positional.volume, 0.125);
    assert.equal(global.volume, 0.6);
    assert.equal(positional.loop, true);
    assert.equal(positional.isPlaying, true);
    assert.equal(global.isPlaying, false);
    assert.equal(positional.buffer, global.buffer);
    assert.equal(ctx.calls.filter((c) => c === 'decode').length, 1);
    assert.deepEqual(
      [positional.panner.coneInnerAngle, positional.panner.coneOuterAngle, positional.panner.coneOuterGain],
      [90, 180, 0.2],
    );
    assert.equal(positional.panner.distanceModel, 'linear');
    assert.equal(positional.panner.refDistance, 2);
    assert.equal(positional.panner.maxDistance, 30);
    model.nodes[0].setPosition([2, 3, 4]);
    engine.store.tick(false);
    positional.update(engine);
    assert.deepEqual([...positional.worldPosition], [2, 3, 4]);
    assert.deepEqual([...positional.worldDirection], [0, 0, -1]);
    result.dispose();
    result.dispose();
    assert.equal(positional.disposed, true);
    assert.equal(global.disposed, true);
    const callerOwned = new Audio(listener);
    callerOwned.dispose();
    assert.throws(() => result.emitters[0].play(), { code: 'disposed' });
  }));

test('MSFT weighted clips, cone half angles and event timeline handle missed frames, pause/resume and backward seeks', async () =>
  fixture(msft(), async ({ model, engine, listener }) => {
    let draws = 0;
    const result = await applyGLTFAudio(model, listener, {
      random: () => {
        draws++;
        return 0;
      },
    });
    const emitter = result.emitters[0],
      sound = emitter.sources[0];
    assert.equal(draws, 0, 'weights are sampled on a play trigger');
    assert.equal(sound.isPlaying, false);
    assert.equal(sound.volume, 0.4);
    assert.deepEqual([sound.panner.coneInnerAngle, sound.panner.coneOuterAngle], [90, 180]);
    assert.equal(sound.panner.distanceModel, 'exponential');
    assert.equal(sound.panner.maxDistance, 256);
    engine.store.tick(false);
    sound.update(engine);
    assert.deepEqual([...sound.worldDirection], [0, 0, 1]);
    result.sync(0.75, true);
    assert.equal(sound.isPlaying, true);
    assert.equal(sound.currentTime, 2.25);
    assert.equal(sound.buffer.bytes.byteLength, 16, 'zero-weight first clip is never selected');
    result.sync(1.25, true);
    assert.equal(sound.isPlaying, false);
    assert.equal(sound.currentTime, 2.5);
    result.sync(1.75, true);
    assert.equal(sound.currentTime, 2.75, 'resume ignores new startOffset');
    assert.equal(draws, 1);
    result.sync(2.05, true);
    assert.equal(sound.isPlaying, false);
    result.sync(2.5, true);
    assert.ok(Math.abs(sound.currentTime - 1.3) < 1e-12);
    assert.equal(draws, 2);
    result.sync(0.75, false);
    assert.equal(sound.currentTime, 2.25);
    assert.equal(sound.isPlaying, false);
    assert.equal(draws, 2, 'seek reuses that event choice');
    emitter.play(3);
    assert.equal(sound.currentTime, 3);
    assert.equal(draws, 3);
    emitter.pause();
    assert.equal(sound.isPlaying, false);
    emitter.stop();
    model.dispose();
    assert.equal(sound.disposed, true);
    result.dispose();
  }));

test('embedded bufferView and relative audio use the model URL, fetch once per clip and reject malformed references', async () => {
  const doc = khr();
  doc.extensions.KHR_audio_emitter.audio[0] = { uri: 'sound.wav' };
  await fixture(doc, async ({ model, listener }) => {
    model.asset.baseURL = 'https://example.test/models/item.gltf';
    const urls = [];
    const result = await applyGLTFAudio(model, listener, {
      autoplay: false,
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(new Uint8Array(8));
      },
    });
    assert.deepEqual(urls, ['https://example.test/models/sound.wav']);
    assert.ok(result.emitters.every((e) => e.sources.every((s) => !s.isPlaying)));
    result.dispose();
  });
  const embedded = khr();
  embedded.buffers = [
    { byteLength: 8, uri: 'data:application/octet-stream;base64,' + Buffer.alloc(8).toString('base64') },
  ];
  embedded.bufferViews = [{ buffer: 0, byteLength: 8 }];
  embedded.extensions.KHR_audio_emitter.audio[0] = { bufferView: 0, mimeType: 'audio/wav' };
  await fixture(embedded, async ({ model, listener }) => {
    const result = await applyGLTFAudio(model, listener, { autoplay: false });
    assert.equal(result.emitters[0].sources[0].buffer.bytes.byteLength, 8);
    result.dispose();
  });
  const invalid = khr();
  invalid.extensions.KHR_audio_emitter.emitters[1].sources = [99];
  await fixture(invalid, async ({ model, listener }) => {
    await assert.rejects(applyGLTFAudio(model, listener), /Invalid glTF audio source/);
    assert.equal(listener['sources'].size, 0, 'failed attachment releases earlier sounds');
  });
});

test('cancellation rejects promptly during decoding and budgets reject without leaving sources', async () =>
  fixture(khr(), async ({ model, listener, ctx }) => {
    await assert.rejects(applyGLTFAudio(model, listener, { maxDownloadBytes: 4 }), /budget|limit/i);
    await assert.rejects(applyGLTFAudio(model, listener, { maxSources: 1 }), /source budget/);
    assert.equal(listener['sources'].size, 0);
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    ctx.decodeAudioData = () => {
      began();
      return new Promise(() => {});
    };
    const controller = new AbortController(),
      pending = applyGLTFAudio(model, listener, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(listener['sources'].size, 0);
  }));
