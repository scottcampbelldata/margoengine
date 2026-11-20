// Alpha video: a second encoder codes the alpha plane, and WebM carries its frames beside the colour as BlockAdditions
// with BlockAddID 1, AlphaMode 1 on the track (RFC 9559 5.1.3.5 to 5.1.3.5.5, 5.1.4.1.16 and 5.1.4.1.28.4; the
// Matroska codec mappings V_VP8 and V_VP9). Containers and codecs with no binding for alpha refuse it with a code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVideo, streamVideo } from '../dist/video.js';
import { encodeWithFFmpeg, ffmpegArguments } from '../dist/ffmpeg.js';

const WIDTH = 4,
  HEIGHT = 2;
/** Frame `n`: colour n, alpha 10 * n + pixel index, so each alpha plane is told apart from the colour and its frame. */
const frame = (n) => {
  const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(n);
  for (let i = 0; i < WIDTH * HEIGHT; i++) data[i * 4 + 3] = 10 * n + i;
  return { width: WIDTH, height: HEIGHT, data };
};
const frames = (count) => Array.from({ length: count }, (_, n) => frame(n));

/**
 * WebCodecs stand-in. Encoder `e` (0 the first made) outputs `[e, its frame count]` per frame. `late` holds the second
 * encoder's output back until the next encode or flush, so colour comes before its alpha. `delta(e, n)` makes encoder
 * e give frame n as a delta frame though a key frame was asked for; `drop(e, n)` makes it give nothing for frame n.
 */
function codecs({ late = false, delta = () => false, drop = () => false } = {}) {
  const log = { encoders: [], pictures: [] };
  class VideoFrame {
    constructor(data, init) {
      Object.assign(this, init, { data: Uint8Array.from(data) });
    }
    close() {}
  }
  class VideoEncoder {
    state = 'configured';
    encodeQueueSize = 0;
    count = 0;
    held = [];
    static isConfigSupported = async (config) => ({ supported: true, config });
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.index = log.encoders.length;
      log.encoders.push(this);
    }
    addEventListener() {}
    configure(config) {
      this.config = config;
    }
    encode(picture, { keyFrame }) {
      log.pictures.push({ encoder: this.index, data: picture.data, timestamp: picture.timestamp, keyFrame });
      const n = this.count++;
      this.release();
      if (drop(this.index, n)) return;
      const data = Uint8Array.of(this.index, n),
        chunk = {
          byteLength: data.length,
          timestamp: picture.timestamp,
          duration: picture.duration,
          type: keyFrame && !delta(this.index, n) ? 'key' : 'delta',
          copyTo: (out) => out.set(data),
        };
      if (late && this.index === 1) this.held.push(chunk);
      else this.output(chunk, undefined);
    }
    release() {
      for (const chunk of this.held.splice(0)) this.output(chunk, undefined);
    }
    async flush() {
      this.release();
    }
    close() {
      this.state = 'closed';
    }
  }
  return { webCodecs: { VideoEncoder, VideoFrame }, log };
}

function readElements(bytes, from = 0, to = bytes.length) {
  const out = [];
  let at = from;
  const vint = (keepMarker) => {
    const first = bytes[at];
    let length = 1;
    while (!(first & (0x80 >> (length - 1)))) length++;
    let value = keepMarker ? first : first & (0xff >> length);
    for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
    at += length;
    return value;
  };
  while (at < to) {
    const id = vint(true),
      size = vint(false);
    assert.ok(at + size <= to, 'an element fits in its parent');
    out.push({ id, start: at, end: at + size });
    at += size;
  }
  return out;
}
const inside = (bytes, parent, id) => readElements(bytes, parent.start, parent.end).filter((e) => e.id === id);
const number = (bytes, { start, end }) => bytes.subarray(start, end).reduce((value, byte) => value * 256 + byte, 0);
const signed = (bytes, element) => {
  const value = number(bytes, element),
    width = element.end - element.start;
  return value >= 2 ** (8 * width - 1) ? value - 2 ** (8 * width) : value;
};
const segmentOf = (bytes) => readElements(bytes).find((e) => e.id === 0x18538067);

/** Every video block of a WebM: its time, key state, colour payload and alpha payload. */
function blocks(bytes) {
  const out = [];
  for (const cluster of inside(bytes, segmentOf(bytes), 0x1f43b675)) {
    const base = number(bytes, inside(bytes, cluster, 0xe7)[0]),
      starts = new Set();
    for (const group of inside(bytes, cluster, 0xa0)) {
      const [block] = inside(bytes, group, 0xa1),
        [additions] = inside(bytes, group, 0x75a1),
        more = additions ? inside(bytes, additions, 0xa6) : [],
        reference = inside(bytes, group, 0xfb);
      assert.equal(bytes[block.start], 0x81, 'track 1');
      assert.equal(bytes[block.start + 3], 0, 'a Block has no key flag; its flags stay clear');
      assert.equal(more.length, 1);
      assert.equal(number(bytes, inside(bytes, more[0], 0xee)[0]), 1, 'BlockAddID 1');
      const [alpha] = inside(bytes, more[0], 0xa5),
        time = base + new DataView(bytes.buffer, bytes.byteOffset + block.start + 1).getInt16(0);
      starts.add(time);
      out.push({
        time,
        key: reference.length === 0,
        reference: reference.length ? signed(bytes, reference[0]) : undefined,
        first: out.length === 0 || time === base,
        colour: [...bytes.subarray(block.start + 4, block.end)],
        alpha: [...bytes.subarray(alpha.start, alpha.end)],
      });
    }
    assert.equal(inside(bytes, cluster, 0xa3).length, 0, 'no SimpleBlock beside the groups');
  }
  return out;
}

test('alpha: a second encoder codes the alpha as luma, and WebM carries it as BlockAddID 1 with AlphaMode 1', async () => {
  const { webCodecs, log } = codecs(),
    video = await encodeVideo(frames(5), { alpha: true, fps: 10, keyFrameInterval: 0.2, webCodecs });
  assert.equal(video.alpha, true);
  assert.equal(video.frames, 5);
  assert.equal(video.codec, 'vp09.00.51.08');
  assert.equal(log.encoders.length, 2);
  assert.deepEqual(log.encoders[1].config, log.encoders[0].config, 'the alpha encoder runs the colour settings');
  for (const one of log.encoders) assert.equal(one.state, 'closed');
  // The alpha pictures: alpha values as they are in the luma plane, 128 in both chroma planes.
  const alphas = log.pictures.filter((p) => p.encoder === 1);
  assert.equal(alphas.length, 5);
  alphas.forEach((picture, n) => {
    assert.deepEqual([...picture.data.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 10 * n + i));
    assert.deepEqual([...picture.data.subarray(8)], [128, 128, 128, 128]);
    assert.equal(picture.keyFrame, log.pictures.filter((p) => p.encoder === 0)[n].keyFrame, 'key frames asked together');
  });

  const { bytes } = video,
    [tracks] = inside(bytes, segmentOf(bytes), 0x1654ae6b),
    [entry] = inside(bytes, tracks, 0xae),
    [videoBox] = inside(bytes, entry, 0xe0);
  assert.equal(number(bytes, inside(bytes, entry, 0x55ee)[0]), 1, 'MaxBlockAdditionID 1');
  assert.equal(number(bytes, inside(bytes, videoBox, 0x53c0)[0]), 1, 'AlphaMode 1');
  const all = blocks(bytes);
  assert.deepEqual(
    all.map(({ time, key, reference, colour, alpha }) => ({ time, key, reference, colour, alpha })),
    [
      { time: 0, key: true, reference: undefined, colour: [0, 0], alpha: [1, 0] },
      { time: 100, key: false, reference: -100, colour: [0, 1], alpha: [1, 1] },
      { time: 200, key: true, reference: undefined, colour: [0, 2], alpha: [1, 2] },
      { time: 300, key: false, reference: -100, colour: [0, 3], alpha: [1, 3] },
      { time: 400, key: true, reference: undefined, colour: [0, 4], alpha: [1, 4] },
    ],
  );
  // Clusters and cues start at the key frames.
  assert.deepEqual(
    all.filter((block) => block.first).map((block) => block.time),
    [0, 200, 400],
  );
  const [cues] = inside(bytes, segmentOf(bytes), 0x1c53bb6b);
  assert.deepEqual(
    inside(bytes, cues, 0xbb).map((point) => number(bytes, inside(bytes, point, 0xb3)[0])),
    [0, 200, 400],
  );
});

test('alpha: frames pair by time when the alpha comes late, and a frame is key only when its alpha is too', async () => {
  const { webCodecs } = codecs({ late: true, delta: (encoder, n) => encoder === 1 && n === 2 }),
    { bytes } = await encodeVideo(frames(5), { alpha: true, fps: 10, keyFrameInterval: 0.2, webCodecs }),
    all = blocks(bytes);
  assert.deepEqual(
    all.map(({ key, colour, alpha }) => [key, colour[1], alpha[1]]),
    [
      [true, 0, 0],
      [false, 1, 1],
      // Colour key, alpha delta: a seek here would show the alpha broken, so it is no key frame and no cue.
      [false, 2, 2],
      [false, 3, 3],
      [true, 4, 4],
    ],
  );
  assert.deepEqual(
    all.filter((block) => block.first).map((block) => block.time),
    [0, 400],
  );
});

test('alpha: VP8 carries it too, and a timed frame keeps its alpha', async () => {
  const { webCodecs, log } = codecs(),
    timed = frames(3).map((one, n) => ({ ...one, timestamp: [0, 0.05, 0.2][n] })),
    video = await encodeVideo(timed, { alpha: true, codec: 'vp8', webCodecs });
  assert.equal(video.mimeType, 'video/webm; codecs="vp8"');
  assert.deepEqual(
    blocks(video.bytes).map(({ time, alpha }) => [time, alpha[1]]),
    [
      [0, 0],
      [50, 1],
      [200, 2],
    ],
  );
  assert.equal(log.pictures.filter((p) => p.encoder === 1).at(-1).data[0], 20, 'the last held frame keeps its alpha');
});

test('alpha: the default codec skips those that cannot carry it', async () => {
  const asked = [],
    { webCodecs } = codecs();
  webCodecs.VideoEncoder.isConfigSupported = async (config) => {
    asked.push(config.codec);
    return { supported: config.codec === 'vp8' };
  };
  const video = await encodeVideo(frames(1), { alpha: true, webCodecs });
  assert.equal(video.codec, 'vp8');
  assert.deepEqual(asked, ['vp09.00.51.08', 'vp8'], 'AV1 is never asked: its WebM mapping carries no alpha');
});

test('alpha: refused with a code where no binding carries it, and an encoder out of step is an error', async () => {
  const { webCodecs } = codecs(),
    refused = { code: 'unsupported', message: /Alpha video needs WebM with VP9 or VP8/ };
  await assert.rejects(encodeVideo(frames(1), { alpha: true, format: 'mp4', webCodecs }), refused);
  await assert.rejects(encodeVideo(frames(1), { alpha: true, codec: 'av01.0.13M.08', webCodecs }), refused);
  await assert.rejects(encodeVideo(frames(1), { alpha: true, format: 'mp4', codec: 'avc1.640033', webCodecs }), refused);
  await assert.rejects(streamVideo(frames(1), { alpha: true, webCodecs }).next(), refused);
  // Without alpha, nothing changes: one encoder, SimpleBlocks, no AlphaMode.
  const { webCodecs: plain, log } = codecs(),
    video = await encodeVideo(frames(2), { webCodecs: plain });
  assert.equal(log.encoders.length, 1);
  assert.equal(video.alpha, undefined);
  const [cluster] = inside(video.bytes, segmentOf(video.bytes), 0x1f43b675);
  assert.equal(inside(video.bytes, cluster, 0xa0).length, 0);
  assert.equal(inside(video.bytes, cluster, 0xa3).length, 2);

  const { webCodecs: dropping, log: dropped } = codecs({ drop: (encoder, n) => encoder === 1 && n === 1 });
  await assert.rejects(encodeVideo(frames(3), { alpha: true, webCodecs: dropping }), { code: 'failed' });
  for (const one of dropped.encoders) assert.equal(one.state, 'closed');
});

test('encodeWithFFmpeg alpha: VP9 with an alpha plane for .webm; refused elsewhere and with custom args', async () => {
  const args = ffmpegArguments(4, 2, { output: 'a.webm', alpha: true }),
    filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, /format=yuva420p/);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libvpx-vp9');
  assert.match(ffmpegArguments(4, 2, { output: 'a.webm' })[args.indexOf('-vf') + 1], /format=yuv420p,/);
  const refused = { code: 'unsupported', message: /Alpha video needs a .webm file and the default arguments/ };
  assert.throws(() => ffmpegArguments(4, 2, { output: 'a.mp4', alpha: true }), refused);
  assert.throws(() => ffmpegArguments(4, 2, { output: 'a.webm', alpha: true, args: ['-c:v', 'libvpx-vp9'] }), refused);
  // Refused before ffmpeg starts: the program named does not exist, so a start would fail another way.
  await assert.rejects(
    encodeWithFFmpeg(frames(1), { output: 'a.mov', alpha: true, ffmpeg: 'margo-no-such-ffmpeg' }),
    refused,
  );
});
