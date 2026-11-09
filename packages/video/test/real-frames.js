import { openVideo } from '/packages/video/dist/codecs.js';
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};
export async function checkRealFrames() {
  const [buffer, ref] = await Promise.all([
    fetch('/__margo-flower.mp4').then((r) => r.arrayBuffer()),
    fetch('./flower-ffprobe.json').then((r) => r.json()),
  ]);
  const bytes = new Uint8Array(buffer);
  const [num, den] = ref.timeBase;
  const us = (t) => Math.round((Number(t) * num * 1000000) / den);
  const digest = async (frame) => {
    try {
      const data = new Uint8Array(frame.allocationSize());
      await frame.copyTo(data);
      const sha = await crypto.subtle.digest('SHA-256', data);
      return {
        timestamp: frame.timestamp,
        format: frame.format,
        width: frame.displayWidth,
        height: frame.displayHeight,
        sha256: [...new Uint8Array(sha)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    } finally {
      frame.close();
    }
  };
  const pending = [],
    expected = new Map();
  let decoderError;
  const decoder = new VideoDecoder({
    output(frame) {
      const timestamp = frame.timestamp;
      pending.push(digest(frame).then((value) => expected.set(timestamp, value)));
    },
    error(e) {
      decoderError = e;
    },
  });
  try {
    decoder.configure({ ...ref.config, description: new Uint8Array(ref.config.description) });
    for (const p of ref.packets)
      decoder.decode(
        new EncodedVideoChunk({
          type: p.key ? 'key' : 'delta',
          timestamp: us(p.pts),
          duration: us(p.duration),
          data: bytes.subarray(Number(p.offset), Number(p.offset) + Number(p.size)),
        }),
      );
    await decoder.flush();
    await Promise.all(pending);
    if (decoderError) throw decoderError;
  } finally {
    try {
      await Promise.all(pending);
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
  }
  assert(expected.size === 150, 'independent FFprobe decode count');
  assert(
    ref.packets.some((p, i, a) => i && Number(p.pts) < Number(a[i - 1].pts)),
    'outside file must reorder presentation frames',
  );
  const video = await openVideo(buffer);
  let checked = 0;
  try {
    assert(video.frameCount === 150, 'Margo frame count');
    assert(video.duration === 5.005, 'Margo edited duration');
    const times = ref.times;
    const rawTimes = [...expected.keys()].sort((a, b) => a - b);
    for (let i = 0; i < 150; i++) {
      assert(video.timestamp(i) === times[i] / 1000000, 'edited timeline ' + i);
      const frame = await video.frame(i),
        got = await digest(frame),
        want = expected.get(rawTimes[i]);
      assert(
        JSON.stringify(got) === JSON.stringify(want),
        'frame differs from independent sample demux at ' + i + ': ' + JSON.stringify({ got, want }),
      );
      checked++;
    }
  } finally {
    video.dispose();
  }
  return {
    frames: checked,
    independentFrames: expected.size,
    bFrames: true,
    editedDuration: 5.005,
    width: 960,
    height: 540,
    comparison: 'every copied decoded byte SHA-256 exact; all edited timestamps exact',
    errors: [],
  };
}
