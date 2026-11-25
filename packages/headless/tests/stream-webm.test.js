// streamVideo format 'webm': a WebM written as a live stream (RFC 9559 6.2): an unknown-size Segment, a header with no
// duration and no SeekHead, a Cluster per key frame interval as it completes, and the Cues last. Joined, its clusters
// are encodeVideo's byte for byte, with alpha and with sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVideo, streamVideo } from '../dist/video.js';

const WIDTH = 4,
  HEIGHT = 2;
/** Frame `n`: colour n, alpha 10 * n + pixel index. */
const frame = (n) => {
  const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(n);
  for (let i = 0; i < WIDTH * HEIGHT; i++) data[i * 4 + 3] = 10 * n + i;
  return { width: WIDTH, height: HEIGHT, data };
};
const frames = (count) => Array.from({ length: count }, (_, n) => frame(n));

/** WebCodecs stand-in: video encoder `e` outputs `[e, frame count]` per frame; a sound chunk is three bytes. */
function codecs() {
  const log = { encoders: [] };
  class VideoFrame {
    constructor(data, init) {
      Object.assign(this, init);
    }
    close() {}
  }
  class VideoEncoder {
    state = 'configured';
    encodeQueueSize = 0;
    count = 0;
    static isConfigSupported = async (config) => ({ supported: true, config });
    constructor({ output }) {
      this.output = output;
      this.index = log.encoders.length;
      log.encoders.push(this);
    }
    addEventListener() {}
    configure() {}
    encode(picture, { keyFrame }) {
      const data = Uint8Array.of(this.index, this.count++);
      this.output(
        {
          byteLength: 2,
          timestamp: picture.timestamp,
          duration: picture.duration,
          type: keyFrame ? 'key' : 'delta',
          copyTo: (out) => out.set(data),
        },
        undefined,
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  class AudioData {
    constructor(init) {
      Object.assign(this, init);
    }
    close() {}
  }
  class AudioEncoder {
    state = 'configured';
    static isConfigSupported = async () => ({ supported: true });
    constructor({ output }) {
      this.output = output;
    }
    configure() {}
    encode(data) {
      this.output({
        byteLength: 3,
        timestamp: data.timestamp,
        duration: Math.round((data.numberOfFrames * 1e6) / data.sampleRate),
        copyTo: (out) => out.set([0xaa, 0xbb, 0xcc]),
      });
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  return { webCodecs: { VideoEncoder, VideoFrame, AudioEncoder, AudioData }, log };
}

/** Top-level EBML elements of `bytes[from, to)`; an unknown size (all ones) runs to `to`. */
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
    return { value, unknown: !keepMarker && value === 2 ** (7 * length) - 1, length };
  };
  while (at < to) {
    const begin = at,
      id = vint(true).value,
      size = vint(false),
      end = size.unknown ? to : at + size.value;
    assert.ok(end <= to, 'an element fits in its parent');
    out.push({ id, begin, start: at, end, unknown: size.unknown, sizeLength: size.length });
    at = end;
  }
  return out;
}
const inside = (bytes, parent, id) => readElements(bytes, parent.start, parent.end).filter((e) => e.id === id);
const number = (bytes, { start, end }) => bytes.subarray(start, end).reduce((value, byte) => value * 256 + byte, 0);
const segmentOf = (bytes) => readElements(bytes).find((e) => e.id === 0x18538067);
const join = (pieces) => {
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  pieces.reduce((at, piece) => (bytes.set(piece, at), at + piece.length), 0);
  return bytes;
};
const clustersOf = (bytes) =>
  inside(bytes, segmentOf(bytes), 0x1f43b675).map(({ start, end }) => [...bytes.subarray(start, end)]);

async function drain(stream, pulled) {
  const pieces = [],
    at = [];
  let step;
  while (!(step = await stream.next()).done) {
    pieces.push(step.value);
    at.push(pulled());
  }
  return { pieces, at, bytes: join(pieces), result: step.value };
}

test('streamVideo webm: an unknown-size Segment, a cluster per key frame interval as it completes, then the Cues', async () => {
  const { webCodecs, log } = codecs();
  let pulled = 0;
  function* source() {
    for (let i = 0; i < 7; i++) {
      pulled++;
      yield frame(i);
    }
  }
  const { pieces, at, bytes, result } = await drain(
    streamVideo(source(), { format: 'webm', fps: 2, keyFrameInterval: 1.5, codec: 'vp09.00.10.08', webCodecs }),
    () => pulled,
  );
  // The header after the first frame, each cluster once the next key frame shows where it ends, the Cues last.
  assert.deepEqual(at, [1, 4, 7, 7, 7]);
  assert.equal(pieces.length, 5);
  assert.deepEqual(result, {
    mimeType: 'video/webm; codecs="vp09.00.10.08"',
    codec: 'vp09.00.10.08',
    width: 4,
    height: 2,
    frames: 7,
    duration: 3.5,
  });
  for (const one of log.encoders) assert.equal(one.state, 'closed');
  const top = readElements(bytes),
    segment = top[1];
  assert.deepEqual(
    top.map((e) => e.id),
    [0x1a45dfa3, 0x18538067],
  );
  assert.ok(segment.unknown, 'the Segment size is unknown');
  assert.equal(segment.sizeLength, 8);
  const children = readElements(bytes, segment.start, segment.end);
  assert.deepEqual(
    children.map((e) => e.id),
    [0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1f43b675, 0x1f43b675, 0x1c53bb6b],
    'Info, Tracks, the clusters, Cues; no SeekHead, as nothing after the header is known when it is written',
  );
  assert.ok(
    children.slice(2, 5).every((cluster) => !cluster.unknown),
    'each cluster is whole, so its size is known',
  );
  assert.equal(inside(bytes, children[0], 0x4489).length, 0, 'no Duration: the end is not known at the start');
  assert.equal(number(bytes, inside(bytes, children[0], 0x2ad7b1)[0]), 1_000_000);
  // The pieces are the header, then whole elements.
  assert.equal(pieces[0].length, children[2].begin);
  assert.deepEqual(
    pieces.slice(1).map((piece) => piece.length),
    children.slice(2).map((e) => e.end - e.begin),
  );
  const [cues] = inside(bytes, segment, 0x1c53bb6b),
    points = inside(bytes, cues, 0xbb).map((point) => {
      const [positions] = inside(bytes, point, 0xb7);
      return [number(bytes, inside(bytes, point, 0xb3)[0]), number(bytes, inside(bytes, positions, 0xf1)[0])];
    });
  // A cue's position counts from the Segment's data to its cluster's ID.
  assert.deepEqual(
    points,
    children.slice(2, 5).map((cluster, n) => [n * 1500, cluster.begin - segment.start]),
  );
  assert.equal(bytes[segment.start + points[1][1]], 0x1f, 'the second cue lands on a Cluster ID');
});

test("streamVideo webm: joined, its clusters are encodeVideo's byte for byte, with alpha, sound and timed frames", async () => {
  const sound = { channels: [new Float32Array(48_000 * 2)], sampleRate: 48_000 };
  for (const options of [
    { fps: 10, keyFrameInterval: 0.2 },
    { fps: 10, keyFrameInterval: 0.2, alpha: true },
    { fps: 10, keyFrameInterval: 0.2, alpha: true, codec: 'vp8', audio: sound },
    { fps: 4, keyFrameInterval: 0.5, audio: sound },
  ]) {
    const whole = await encodeVideo(frames(5), { ...options, webCodecs: codecs().webCodecs }),
      { bytes, result } = await drain(
        streamVideo(frames(5), { ...options, format: 'webm', webCodecs: codecs().webCodecs }),
        () => 0,
      );
    assert.deepEqual(clustersOf(bytes), clustersOf(whole.bytes), JSON.stringify(options));
    const { bytes: _, ...described } = whole;
    assert.deepEqual(result, described);
    // The tracks match too, AlphaMode and MaxBlockAdditionID with them.
    const tracks = (file) => {
      const [element] = inside(file, segmentOf(file), 0x1654ae6b);
      return [...file.subarray(element.start, element.end)];
    };
    assert.deepEqual(tracks(bytes), tracks(whole.bytes));
  }
  // Timed frames: no DefaultDuration, as encodeVideo writes them.
  const timed = frames(3).map((one, n) => ({ ...one, timestamp: [0, 0.05, 0.2][n] })),
    { bytes } = await drain(
      streamVideo(timed, { format: 'webm', alpha: true, webCodecs: codecs().webCodecs }),
      () => 0,
    ),
    [tracks] = inside(bytes, segmentOf(bytes), 0x1654ae6b),
    [entry] = inside(bytes, tracks, 0xae);
  assert.equal(inside(bytes, entry, 0x23e383).length, 0);
  assert.equal(number(bytes, inside(bytes, inside(bytes, entry, 0xe0)[0], 0x53c0)[0]), 1, 'AlphaMode 1');
});

test('streamVideo webm: provenance in the header; stopping early or by signal closes both encoders; refusals', async () => {
  const { webCodecs, log } = codecs();
  for await (const piece of streamVideo(frames(9), {
    format: 'webm',
    alpha: true,
    provenance: { scene: 'a' },
    webCodecs,
  })) {
    const segment = segmentOf(piece),
      [tags] = inside(piece, segment, 0x1254c367);
    assert.ok(new TextDecoder().decode(piece.subarray(tags.start, tags.end)).includes('{"scene":"a"}'));
    break;
  }
  assert.equal(log.encoders.length, 2);
  for (const one of log.encoders) assert.equal(one.state, 'closed');

  const stop = new AbortController(),
    { webCodecs: second, log: secondLog } = codecs();
  async function* slow() {
    yield frame(0);
    stop.abort(new Error('stop'));
    yield frame(1);
  }
  await assert.rejects(
    (async () => {
      for await (const piece of streamVideo(slow(), {
        format: 'webm',
        alpha: true,
        signal: stop.signal,
        webCodecs: second,
      }))
        assert.ok(piece.length);
    })(),
    /stop/,
  );
  for (const one of secondLog.encoders) assert.equal(one.state, 'closed');

  const { webCodecs: third } = codecs();
  await assert.rejects(streamVideo(frames(1), { format: 'avi', webCodecs: third }).next(), { name: 'TypeError' });
  await assert.rejects(
    streamVideo(frames(1), { format: 'webm', alpha: true, codec: 'av01.0.13M.08', webCodecs: third }).next(),
    {
      code: 'unsupported',
    },
  );
  await assert.rejects(streamVideo(frames(1), { alpha: true, webCodecs: third }).next(), { code: 'unsupported' });
  await assert.rejects(streamVideo([], { format: 'webm', webCodecs: third }).next(), /No frames/);
});
