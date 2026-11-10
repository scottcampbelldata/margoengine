import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDemuxedVideo } from '../dist/demux.js';
import { mocks } from './codecs-mocks.js';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
import { fragmentFixture } from './demux-fixtures.js';

test('all 300 real fragmented AVC and WebM samples agree with independent FFprobe bytes and times', () =>
  mocks(async ({ decoders }) => {
    let checked = 0;
    for (const format of ['mp4', 'webm']) {
      const ref = JSON.parse(
          readFileSync(
            new URL(format === 'mp4' ? './flower-ffprobe.json' : './webm-ffprobe.json', import.meta.url),
            'utf8',
          ),
        ),
        bytes = readFileSync(requireExternalAssets('video/flower.' + format)),
        [num, den] = ref.timeBase,
        shift = format === 'mp4' ? -Math.min(...ref.packets.map((p) => p.dts)) : 0,
        us = (t) => Math.round((t * num * 1000000) / den),
        packets = ref.packets.map((p) => ({
          ...p,
          pts: p.pts + shift,
          data: bytes.subarray(p.offset, p.offset + p.size),
        })),
        input =
          format === 'mp4'
            ? fragmentFixture({
                samples: packets.map((p) => ({ ...p, dts: p.dts + shift })),
                description: ref.config.description,
                scale: den / num,
                edit: true,
              })
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
      using video = await openDemuxedVideo(input);
      assert.equal(video.frameCount, 150);
      const sorted = packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts);
      assert.deepEqual(
        sorted.map((i) => us(packets[i].pts) / 1000000),
        Array.from({ length: 150 }, (_, i) => video.timestamp(i)),
      );
      for (let i = 0; i < packets.length; i++) {
        if (!packets[i].key) continue;
        const f = await video.frame(sorted.indexOf(i));
        f.close();
        const chunks = decoders.at(-1).chunks;
        for (let j = 0; j < chunks.length; j++) {
          const got = chunks[j],
            want = packets[i + j];
          assert.equal(got.timestamp, us(want.pts));
          assert.equal(got.type, want.key ? 'key' : 'delta');
          assert.deepEqual(got.data, new Uint8Array(want.data));
          if (want.sha256) assert.equal(createHash('sha256').update(got.data).digest('hex'), want.sha256);
          checked++;
        }
      }
    }
    assert.equal(checked, 300);
  }));
