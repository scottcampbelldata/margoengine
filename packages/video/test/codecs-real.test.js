import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openVideo } from '../dist/codecs.js';
import { mocks } from './codecs-mocks.js';
import { externalAssets, requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';

test('every real AVC sample and edited timestamp agrees with the independent FFprobe oracle', () =>
  mocks(async ({ decoders }) => {
    const oracle = JSON.parse(readFileSync(new URL('./flower-ffprobe.json', import.meta.url), 'utf8'));
    const source = externalAssets.find(({ file }) => file === 'video/flower.mp4');
    assert.equal(source.sha256, oracle.source.sha256);
    assert.equal(source.size, oracle.source.bytes);
    assert.equal(source.url, oracle.source.url);
    const bytes = readFileSync(requireExternalAssets('video/flower.mp4'));
    using video = await openVideo(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const [num, den] = oracle.timeBase;
    const us = (ticks) => Math.round((ticks * num * 1000000) / den);
    assert.equal(video.frameCount, 150);
    assert.equal(video.duration, oracle.duration);
    assert.deepEqual(
      Array.from({ length: video.frameCount }, (_, i) => video.timestamp(i)),
      oracle.times.map((value) => value / 1000000),
    );
    const order = oracle.packets.map((_, i) => i).sort((a, b) => oracle.packets[a].pts - oracle.packets[b].pts);
    const sync = oracle.packets.flatMap((packet, i) => (packet.key ? [i] : []));
    let checked = 0;
    for (const [gop, start] of sync.entries()) {
      const frame = await video.frame(order.indexOf(start));
      frame.close();
      const decoder = decoders.at(-1);
      assert.equal(decoder.config.codec, oracle.config.codec);
      assert.deepEqual([...decoder.config.description], oracle.config.description);
      const packets = oracle.packets.slice(start, sync[gop + 1] ?? oracle.packets.length);
      assert.equal(decoder.chunks.length, packets.length);
      for (const [i, packet] of packets.entries()) {
        const chunk = decoder.chunks[i];
        assert.equal(chunk.timestamp, us(packet.pts), `packet ${start + i} PTS`);
        assert.equal(chunk.duration, us(packet.duration), `packet ${start + i} duration`);
        assert.equal(chunk.type, packet.key ? 'key' : 'delta', `packet ${start + i} sync`);
        assert.deepEqual(
          chunk.data,
          new Uint8Array(bytes.subarray(packet.offset, packet.offset + packet.size)),
          `packet ${start + i} bytes`,
        );
        checked++;
      }
    }
    assert.equal(checked, 150);
  }));
