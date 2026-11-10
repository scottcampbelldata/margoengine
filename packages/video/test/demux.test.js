import test from 'node:test';
import assert from 'node:assert/strict';
import { openDemuxedVideo } from '../dist/demux.js';
import { openVideo } from '../dist/codecs.js';
import { mocks } from './codecs-mocks.js';
import { fragmentFixture, webmFixture } from './demux-fixtures.js';
import { mp4Fixture } from './mp4-fixture.js';

test('fragmented MP4 preserves B-frame ordering, trex defaults, zero-duration edits and GOP boundaries', () =>
  mocks(async ({ decoders }) => {
    for (const defaults of [true, false])
      for (const edit of [true, false]) {
        using video = await openDemuxedVideo(fragmentFixture({ defaults, edit }));
        assert.equal(video.frameCount, 5);
        assert.equal(video.duration, 0.5);
        assert.deepEqual(
          Array.from({ length: 5 }, (_, i) => video.timestamp(i)),
          [0, 0.1, 0.2, 0.3, 0.4],
        );
        const f = await video.seek(0.299);
        assert.equal(f.id, 3);
        f.close();
        assert.deepEqual(
          decoders.at(-1).chunks.map((c) => c.data[0]),
          [0, 1, 2, 3],
        );
        const last = await video.frame(4);
        assert.equal(last.id, 4);
        last.close();
        assert.deepEqual(
          decoders.at(-1).chunks.map((c) => c.data[0]),
          [4],
        );
      }
    await assert.rejects(openVideo(fragmentFixture()), (e) => e.code === 'unsupported');
    using plain = await openDemuxedVideo(mp4Fixture());
    assert.equal(plain.frameCount, 5);
  }));
test('a zero-length fragmented edit with a media time shifts the duration as well as the frame times', () =>
  mocks(async () => {
    // ffmpeg-style fragmented MP4: elst segment_duration 0, media_time 100 ticks (a B-frame shift). Frames at media
    // 100..400 play at 0..0.3 and the last lasts 0.1 s, so the movie is 0.4 s; the edit was ignored and gave 0.5.
    using video = await openDemuxedVideo(fragmentFixture({ edit: 100 }));
    assert.deepEqual(
      Array.from({ length: video.frameCount }, (_, i) => video.timestamp(i)),
      [0, 0.1, 0.2, 0.3],
    );
    assert.equal(video.duration, 0.4);
  }));
test('a WebM BlockDuration overrides the track DefaultDuration (RFC 9559)', () =>
  mocks(async () => {
    // DefaultDuration is 100 ms; the last BlockGroup says 40 ms, so the clip ends at 0.24 s, not 0.3 s.
    using video = await openDemuxedVideo(webmFixture({ blockGroup: true, lastDuration: 40 }));
    assert.equal(video.frameCount, 3);
    assert.equal(video.duration, 0.24);
  }));
test('WebM reads empty unsigned and float elements as their default or zero (RFC 8794 sections 7.2, 7.3)', () =>
  mocks(async () => {
    // Batch 132 audit: a zero-length Cluster Timestamp (0) and TrackTimestampScale (default 1.0) were refused.
    using video = await openDemuxedVideo(webmFixture({ empty: true }));
    assert.equal(video.frameCount, 3);
    assert.deepEqual(
      [0, 1, 2].map((i) => video.timestamp(i)),
      [0, 0.1, 0.2],
    );
  }));
test('WebM parses every lace mode, block groups and unknown-length cluster/segment boundaries', () =>
  mocks(async () => {
    for (const lacing of [0, 1, 2, 3])
      for (const unknown of [true, false])
        for (const blockGroup of [true, false]) {
          using video = await openDemuxedVideo(webmFixture({ lacing, unknown, blockGroup }));
          assert.equal(video.frameCount, 3);
          assert.equal(video.duration, 0.3);
          assert.deepEqual(
            [0, 1, 2].map((i) => video.timestamp(i)),
            [0, 0.1, 0.2],
          );
          for (let i = 2; i >= 0; i--) {
            const f = await video.frame(i);
            assert.equal(f.id, 10 + i);
            f.close();
          }
        }
  }));
test('malformed fragments and WebM fail before decoder allocation, and cancellation remains shared', () =>
  mocks(async ({ decoders }) => {
    for (const input of [
      fragmentFixture().slice(0, -1),
      webmFixture().slice(0, -1),
      webmFixture({ lacing: 1, malformed: true }),
      webmFixture({ codec: 'bad' }),
    ])
      await assert.rejects(openDemuxedVideo(input), (e) => ['failed', 'unsupported'].includes(e.code));
    assert.equal(decoders.length, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      openDemuxedVideo(webmFixture(), { signal: controller.signal }),
      (e) => e.name === 'AbortError',
    );
    using video = await openDemuxedVideo(webmFixture());
    const pending = video.frame(1);
    await assert.rejects(video.step(), (e) => e.code === 'state');
    (await pending).close();
    video.dispose();
    await assert.rejects(video.seek(0), (e) => e.code === 'disposed');
  }));
