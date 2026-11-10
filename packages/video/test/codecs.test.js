import test from 'node:test';
import assert from 'node:assert/strict';
import { openVideo } from '../dist/codecs.js';
import { mp4Fixture } from './mp4-fixture.js';
import { mocks } from './codecs-mocks.js';

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

test('fractional-microsecond edit offsets round once, and edit boundaries compare native ticks', () =>
  mocks(async () => {
    using video = await openVideo(
      mp4Fixture({ signed: false, edit: true, timeScale: 30000, sampleDelta: 1001, editStart: 1001 }),
    );
    assert.deepEqual(
      Array.from({ length: video.frameCount }, (_, i) => video.timestamp(i)),
      [0.05, 0.083367, 0.116733, 0.1501, 0.183467],
    );
    const boundary = await video.seek(0.083366);
    assert.equal(video.currentFrame, 0);
    boundary.close();
    using start = await openVideo(
      mp4Fixture({ signed: false, edit: true, timeScale: 3000000, sampleDelta: 10001, editStart: 10002 }),
    );
    // The sample one third of a microsecond before the edit start is the one presented across it, so it is shown
    // from the edit start (QuickTime edit list semantics) instead of being dropped, which left 4 frames.
    assert.equal(start.frameCount, 5, 'the sample covering the edit start is shown from the edit start');
    assert.deepEqual(
      Array.from({ length: start.frameCount }, (_, i) => start.timestamp(i)),
      [0.05, 0.053333, 0.056667, 0.060001, 0.063334],
    );
    using end = await openVideo(
      mp4Fixture({
        signed: false,
        edit: true,
        timeScale: 3000000,
        sampleDelta: 10001,
        movieScale: 3000000,
        editStart: 0,
        editLength: 10002,
      }),
    );
    assert.equal(end.frameCount, 1, 'a sample one third of a microsecond before the edit end stays inside');
  }));

test('decode timestamp collisions outside an edit cannot impersonate its first visible frame', () =>
  mocks(async () => {
    await assert.rejects(
      openVideo(
        mp4Fixture({ signed: false, edit: true, timeScale: 3000000, editStart: 102, composition: [101, 2, 0, 0, 0] }),
      ),
      { code: 'unsupported' },
    );
  }));

test('an edit that starts inside a sample shows that sample from the edit start', () =>
  mocks(async () => {
    // PTS 0, 100, 200, 300, 400 ms; the edit plays media 150..400 ms at movie 50 ms. Sample 100 covers 150 and was dropped,
    // so seek(0.05) returned the 200 ms picture and the first 50 ms of the edit showed the wrong frame.
    using video = await openVideo(mp4Fixture({ edit: true, editStart: 150 }));
    assert.deepEqual(
      Array.from({ length: video.frameCount }, (_, i) => video.timestamp(i)),
      [0.05, 0.1, 0.2],
    );
    const first = await video.seek(0.06);
    assert.equal(first.timestamp, 100000);
    first.close();
    // Every sample before the edit start: the last one still covers it for its decode duration (400..500 ms).
    using tail = await openVideo(mp4Fixture({ edit: true, editStart: 450 }));
    assert.equal(tail.frameCount, 1);
    assert.equal(tail.timestamp(0), 0.05);
    await assert.rejects(openVideo(mp4Fixture({ edit: true, editStart: 500 })), { code: 'failed' });
  }));
