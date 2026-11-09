import test from 'node:test';
import assert from 'node:assert/strict';
import { openVideo } from '../dist/codecs.js';
import { mp4Fixture } from './mp4-fixture.js';

function mocks(run) {
  const before = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk };
  const outputs = [],
    decoders = [];
  globalThis.EncodedVideoChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  globalThis.VideoDecoder = class {
    static supported = true;
    static hold = false;
    static isConfigSupported = async (config) => ({ config, supported: this.supported });
    state = 'unconfigured';
    chunks = [];
    constructor(init) {
      this.init = init;
      decoders.push(this);
    }
    configure(c) {
      this.config = c;
      this.state = 'configured';
    }
    decode(c) {
      this.chunks.push(c);
    }
    flush() {
      if (this.constructor.hold)
        return new Promise((resolve, reject) => {
          this.reject = reject;
        });
      for (const c of [...this.chunks].sort((a, b) => a.timestamp - b.timestamp)) {
        const f = {
          timestamp: c.timestamp,
          id: c.data[0],
          closed: false,
          close() {
            this.closed = true;
          },
        };
        outputs.push(f);
        this.init.output(f);
      }
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      this.reject?.(new Error('closed'));
    }
  };
  return Promise.resolve()
    .then(() => run({ outputs, decoders }))
    .finally(() => Object.assign(globalThis, before));
}

test('presentation frame access decodes from sync, drains reordered GOP, closes only unselected frames', () =>
  mocks(async ({ outputs, decoders }) => {
    using video = await openVideo(mp4Fixture({ co64: true, chunked: true }));
    assert.equal(video.frameCount, 5);
    assert.equal(video.duration, 0.5);
    assert.equal(video.currentFrame, -1);
    assert.deepEqual(
      Array.from({ length: 5 }, (_, i) => video.timestamp(i)),
      [0, 0.1, 0.2, 0.3, 0.4],
    );
    const f = await video.frame(2);
    assert.equal(f.id, 3);
    assert.equal(f.timestamp, 200000);
    assert.deepEqual(
      decoders[0].chunks.map((c) => c.data[0]),
      [0, 1, 2, 3],
    );
    assert.match(decoders[0].config.codec, /^avc1\.42001e$/);
    assert.equal(outputs.filter((f) => !f.closed).length, 1);
    f.close();
    const seek = await video.seek(0.3999);
    assert.equal(seek.id, 1);
    seek.close();
    const next = await video.step();
    assert.equal(next.id, 4);
    next.close();
    assert.deepEqual(
      decoders.at(-1).chunks.map((c) => c.data[0]),
      [4],
    );
    const previous = await video.step(-2);
    assert.equal(previous.id, 3);
    previous.close();
    assert.equal(video.currentFrame, 2);
  }));

test('unsigned composition offsets, constant sizes, edited timeline and clamp semantics', () =>
  mocks(async () => {
    using video = await openVideo(new Blob([mp4Fixture({ signed: false, constant: true })]));
    assert.equal(video.frameCount, 5);
    assert.equal(video.duration, 0.6);
    const first = await video.step();
    assert.equal(first.id, 0);
    first.close();
    const last = await video.seek(100);
    assert.equal(last.id, 4);
    last.close();
    const clamped = await video.seek(-1);
    assert.equal(clamped.id, 0);
    clamped.close();
    using edited = await openVideo(mp4Fixture({ edit: true }));
    assert.deepEqual(
      Array.from({ length: edited.frameCount }, (_, i) => edited.timestamp(i)),
      [0.05, 0.15, 0.25],
    );
    assert.equal(edited.duration, 0.3);
    const boundary = await edited.seek(0.15);
    assert.equal(edited.currentFrame, 1);
    boundary.close();
    const f = await edited.frame(2);
    assert.equal(f.id, 1);
    f.close();
  }));

test('concurrent access rejects, request abort releases decoder, lifetime dispose preserves returned frames', () =>
  mocks(async ({ decoders }) => {
    const lifetime = new AbortController(),
      video = await openVideo(mp4Fixture(), { signal: lifetime.signal });
    const owned = await video.frame(0);
    VideoDecoder.hold = true;
    const request = new AbortController(),
      pending = video.frame(2, { signal: request.signal });
    await assert.rejects(video.step(), (e) => e.code === 'state');
    request.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(decoders.at(-1).state, 'closed');
    assert.equal(video.currentFrame, 0);
    const disposed = video.frame(3);
    lifetime.abort();
    await assert.rejects(disposed, { name: 'AbortError' });
    assert.equal(owned.closed, false);
    owned.close();
    video.dispose();
    await assert.rejects(video.frame(0), { name: 'AbortError' });
    const other = await openVideo(mp4Fixture());
    other[Symbol.dispose]();
    await assert.rejects(other.seek(0), (e) => e.code === 'disposed');
  }));

test('invalid input fails with code and help link before decoding, missing codec is explicit', () =>
  mocks(async ({ decoders }) => {
    const bytes = mp4Fixture();
    for (const n of [0, 1, 7, bytes.byteLength - 1])
      await assert.rejects(openVideo(bytes.slice(0, n)), (e) => e.code === 'failed' && /https:/.test(e.message));
    const bad = new Uint8Array(bytes.slice(0));
    const at = new TextDecoder().decode(bad).indexOf('stsz');
    new DataView(bad.buffer).setUint32(at + 12, 0xffffffff);
    await assert.rejects(openVideo(bad.buffer), (e) => e.code === 'failed');
    const offset = new Uint8Array(bytes.slice(0)),
      pos = new TextDecoder().decode(offset).indexOf('stco');
    new DataView(offset.buffer).setUint32(pos + 12, 0);
    await assert.rejects(openVideo(offset.buffer), (e) => e.code === 'failed');
    assert.equal(decoders.length, 0);
    using v = await openVideo(bytes);
    for (const n of [-1, 5, 0.5, NaN]) await assert.rejects(v.frame(n), RangeError);
    await assert.rejects(v.seek(Infinity), RangeError);
    await assert.rejects(v.step(0.5), RangeError);
    VideoDecoder.supported = false;
    await assert.rejects(openVideo(bytes), (e) => e.code === 'unsupported' && /https:/.test(e.message));
    globalThis.VideoDecoder = undefined;
    await assert.rejects(openVideo(bytes), (e) => e.code === 'unsupported');
  }));
