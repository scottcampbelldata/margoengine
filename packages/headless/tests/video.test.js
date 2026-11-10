import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createHeadlessCanvas } from '../dist/index.js';
import { encodeVideo, imageSequence, renderFrames } from '../dist/video.js';
import { encodeWithFFmpeg, ffmpegArguments } from '../dist/ffmpeg.js';

/** Lets the event loop turn until `ready` holds. */
const until = async (ready) => {
  while (!ready()) await new Promise((done) => setImmediate(done));
};
const frame = (width = 4, height = 2, value = 9) => ({
  width,
  height,
  data: new Uint8Array(width * height * 4).fill(value),
});
const frames = (count, width, height) => Array.from({ length: count }, (_, i) => frame(width, height, i));

/** WebCodecs stand-in. Each encoded frame becomes a chunk holding its first byte. */
function fakeCodecs({ supported = () => true, description, colorSpace, reorder, failAt, holdOutput, queue = 0 } = {}) {
  const log = { configs: [], encoded: [], closedFrames: 0, closed: false, asked: [], maxQueue: 0 };
  class VideoFrame {
    constructor(data, init) {
      Object.assign(this, init, { first: data[0] });
    }
    close() {
      log.closedFrames++;
    }
  }
  class VideoEncoder {
    state = 'configured';
    encodeQueueSize = queue;
    #pending = [];
    static async isConfigSupported(config) {
      log.asked.push(config.codec);
      return { supported: supported(config), config };
    }
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.listeners = [];
      log.created = this;
    }
    addEventListener(_type, listener) {
      this.listeners.push(listener);
    }
    configure(config) {
      log.configs.push(config);
    }
    encode(picture, options) {
      log.encoded.push({ timestamp: picture.timestamp, duration: picture.duration, keyFrame: options.keyFrame });
      if (log.encoded.length - 1 === failAt) {
        queueMicrotask(() => this.error(new Error('encoder broke')));
        return;
      }
      this.#pending.push({ picture, key: options.keyFrame });
      if (reorder && this.#pending.length < 2) return;
      if (holdOutput) return;
      this.#drain();
    }
    #drain() {
      const ready = this.#pending.splice(0);
      if (reorder) ready.reverse();
      ready.forEach(({ picture, key }, i) => {
        const metadata = log.sent ? undefined : { decoderConfig: { description, colorSpace } };
        log.sent = true;
        this.output(
          {
            byteLength: 3,
            timestamp: picture.timestamp,
            duration: picture.duration,
            type: key ? 'key' : 'delta',
            copyTo: (target) => target.set([picture.first, 0xaa, 0xbb]),
          },
          i === 0 ? metadata : undefined,
        );
      });
    }
    async flush() {
      log.flushing = true;
      if (holdOutput === 'forever') await new Promise(() => {});
      this.#drain();
    }
    close() {
      this.state = 'closed';
      log.closed = true;
    }
  }
  return { webCodecs: { VideoEncoder, VideoFrame }, log };
}

// Readers written from the formats, so a test sees the file the way a player would.
function readBoxes(bytes, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    boxes = [];
  for (let at = from; at < to; ) {
    let size = view.getUint32(at),
      head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      head = 16;
    }
    assert.ok(size >= head && at + size <= to, 'a box fits in its parent');
    boxes.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at + head, end: at + size });
    at += size;
  }
  return boxes;
}
const child = (bytes, parent, type, skip = 0) =>
  readBoxes(bytes, parent.start + skip, parent.end).find((box) => box.type === type);
const path = (bytes, ...types) => {
  let box = { start: 0, end: bytes.length };
  for (const type of types) box = child(bytes, box, type);
  return box;
};
const u32At = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

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
const number = (bytes, { start, end }) => bytes.subarray(start, end).reduce((value, byte) => value * 256 + byte, 0);
const inside = (bytes, parent, id) => readElements(bytes, parent.start, parent.end).filter((e) => e.id === id);
const webmSegment = (bytes) => readElements(bytes).find((e) => e.id === 0x18538067);

test('publication provenance is structured metadata in both containers and the encoded payload budget releases the codec', async () => {
  const record = { source: 'NOAA PSL', hash: 'sha256:123', units: 'm/s', title: 'Wind σ' },
    json = JSON.stringify(record);
  for (const format of ['webm', 'mp4']) {
    const { webCodecs, log } = fakeCodecs({ description: new Uint8Array([1, 66, 0, 30, 255, 225, 0, 0]) });
    const file = await encodeVideo(frames(4), {
      format,
      codec: format === 'webm' ? 'vp8' : 'avc1.42001e',
      webCodecs,
      provenance: record,
    });
    const bytes = file.bytes;
    if (format === 'mp4') {
      const metadata = path(bytes, 'moov', 'udta', 'marg');
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes.subarray(metadata.start, metadata.end))), record);
    } else {
      const [tags] = inside(bytes, webmSegment(bytes), 0x1254c367),
        [tag] = inside(bytes, tags, 0x7373),
        [simple] = inside(bytes, tag, 0x67c8);
      const [value] = inside(bytes, simple, 0x4487);
      assert.equal(new TextDecoder().decode(bytes.subarray(value.start, value.end)), json);
    }
    assert.equal(log.closed, true);
    const limited = fakeCodecs();
    await assert.rejects(encodeVideo(frames(4), { webCodecs: limited.webCodecs, maxBytes: 2 }), /exceeds maxBytes/);
    assert.equal(limited.log.closed, true);
  }
});

test('renderFrames steps its own clock and reads each frame', async () => {
  const canvas = createHeadlessCanvas({ width: 2, height: 2 }),
    renders = [],
    updates = [],
    camera = {};
  let texture;
  const device = {
    createTexture: (d) => (texture = { width: d.size[0], height: d.size[1], format: d.format, destroy() {} }),
    createBuffer: (d) => ({
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(d.size),
      destroy() {},
    }),
    createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish: () => 'commands' }),
    queue: { submit() {} },
  };
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm' });
  const engine = {
    canvas,
    gpu: device,
    render(options) {
      renders.push(options);
      canvas.getContext('webgpu').getCurrentTexture();
    },
  };
  const seen = [];
  for await (const item of renderFrames(engine, {
    frames: 4,
    fps: 2,
    camera,
    update: async (timing) => void updates.push(timing.progress),
  }))
    seen.push(item);
  assert.ok(texture);
  assert.deepEqual(updates, [0, 0.25, 0.5, 0.75], 'never reaches 1, so a turn loops');
  assert.deepEqual(
    seen.map(({ index, time, delta }) => [index, time, delta]),
    [
      [0, 0, 0],
      [1, 0.5, 0.5],
      [2, 1, 0.5],
      [3, 1.5, 0.5],
    ],
  );
  assert.deepEqual(
    renders.map((options) => options.delta),
    [0, 0.5, 0.5, 0.5],
  );
  assert.equal(renders[0].camera, camera);
  assert.equal(seen[0].data.length, 16);
});

test('renderFrames draws nothing ahead of its consumer, and stops on abort', async () => {
  let drawn = 0;
  const controller = new AbortController(),
    canvas = createHeadlessCanvas({ width: 1, height: 1 }),
    device = {
      createTexture: (d) => ({ width: 1, height: 1, format: d.format, destroy() {} }),
      createBuffer: (d) => ({ mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(d.size), destroy() {} }),
      createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish: () => 'commands' }),
      queue: { submit() {} },
    };
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm' });
  const engine = {
      canvas,
      gpu: device,
      render() {
        drawn++;
        canvas.getContext('webgpu').getCurrentTexture();
      },
    },
    iterator = renderFrames(engine, { frames: 5, signal: controller.signal });
  await iterator.next();
  assert.equal(drawn, 1);
  controller.abort(new Error('enough'));
  await assert.rejects(iterator.next(), /enough/);
  assert.equal(drawn, 1);
});

test('renderFrames refuses a bad count or fps', async () => {
  for (const options of [{ frames: 0 }, { frames: 1.5 }, { frames: 2, fps: 0 }, { frames: 2, fps: Infinity }])
    await assert.rejects(renderFrames({}, options).next(), RangeError);
});

test('imageSequence names frames in order and gives real PNG files', async () => {
  const files = [];
  for await (const file of imageSequence(frames(3), { prefix: 'turn-', digits: 2 })) files.push(file);
  assert.deepEqual(
    files.map((file) => file.name),
    ['turn-00.png', 'turn-01.png', 'turn-02.png'],
  );
  const png = files[1].bytes;
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const idat = Buffer.from(png).indexOf('IDAT'),
    rows = inflateSync(Buffer.from(png.subarray(idat + 4, idat + 4 + u32At(png, idat - 4))));
  assert.equal(rows[1], 1, "the frame's value");
  const defaults = await imageSequence(frames(1)).next();
  assert.equal(defaults.value.name, 'frame_0000.png');
});

test('encodeVideo writes a WebM a parser can walk: times, key frames, cues and seek head', async () => {
  const { webCodecs, log } = fakeCodecs({ colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' } }),
    video = await encodeVideo(frames(5), { fps: 10, keyFrameInterval: 0.2, webCodecs }),
    { bytes } = video;
  assert.equal(log.configs[0].codec, 'vp09.00.51.08');
  assert.equal(log.configs[0].bitrate, Math.round(4 * 2 * 10 * 0.1));
  assert.deepEqual(
    log.encoded.map((e) => e.keyFrame),
    [true, false, true, false, true],
  );
  assert.equal(log.closedFrames, 5, 'every VideoFrame is closed');
  assert.equal(log.closed, true);
  assert.deepEqual(
    { ...video, bytes: undefined },
    {
      bytes: undefined,
      mimeType: 'video/webm; codecs="vp09.00.51.08"',
      codec: 'vp09.00.51.08',
      width: 4,
      height: 2,
      frames: 5,
      duration: 0.5,
    },
  );

  const [ebml] = readElements(bytes);
  assert.equal(ebml.id, 0x1a45dfa3);
  assert.equal(
    new TextDecoder().decode(bytes.subarray(inside(bytes, ebml, 0x4282)[0].start, inside(bytes, ebml, 0x4282)[0].end)),
    'webm',
  );
  const segment = webmSegment(bytes),
    [info] = inside(bytes, segment, 0x1549a966),
    [tracks] = inside(bytes, segment, 0x1654ae6b),
    [entry] = inside(bytes, tracks, 0xae),
    [videoBox] = inside(bytes, entry, 0xe0),
    [colour] = inside(bytes, videoBox, 0x55b0),
    clusters = inside(bytes, segment, 0x1f43b675),
    [cues] = inside(bytes, segment, 0x1c53bb6b),
    [seekHead] = inside(bytes, segment, 0x114d9b74);
  assert.equal(number(bytes, inside(bytes, info, 0x2ad7b1)[0]), 1_000_000);
  const duration = inside(bytes, info, 0x4489)[0];
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset + duration.start).getFloat64(0), 500);
  assert.equal(
    new TextDecoder().decode(bytes.subarray(inside(bytes, entry, 0x86)[0].start, inside(bytes, entry, 0x86)[0].end)),
    'V_VP9',
  );
  assert.equal(number(bytes, inside(bytes, entry, 0x23e383)[0]), 100_000_000);
  assert.equal(number(bytes, inside(bytes, videoBox, 0xb0)[0]), 4);
  assert.equal(number(bytes, inside(bytes, videoBox, 0xba)[0]), 2);
  assert.equal(number(bytes, inside(bytes, colour, 0x55b1)[0]), 1, 'BT.709 matrix');

  // Three key frames, three clusters; blocks at the frame times, the key flag on the first of each.
  assert.equal(clusters.length, 3);
  const times = [];
  for (const cluster of clusters) {
    const base = number(bytes, inside(bytes, cluster, 0xe7)[0]);
    inside(bytes, cluster, 0xa3).forEach((block, i) => {
      assert.equal(bytes[block.start], 0x81);
      const offset = new DataView(bytes.buffer, bytes.byteOffset + block.start + 1).getInt16(0);
      times.push(base + offset);
      assert.equal(bytes[block.start + 3], i === 0 ? 0x80 : 0);
      assert.equal(bytes[block.start + 4], times.length - 1, "the frame's payload, in order");
    });
  }
  assert.deepEqual(times, [0, 100, 200, 300, 400]);

  // Each cue lands on its cluster, and each seek entry on its element.
  const points = inside(bytes, cues, 0xbb);
  assert.equal(points.length, 3);
  points.forEach((point, i) => {
    const [where] = inside(bytes, point, 0xb7),
      position = number(bytes, inside(bytes, where, 0xf1)[0]),
      at = segment.start + position;
    assert.deepEqual([...bytes.subarray(at, at + 4)], [0x1f, 0x43, 0xb6, 0x75]);
    assert.equal(number(bytes, inside(bytes, point, 0xb3)[0]), i * 200);
  });
  const seeks = inside(bytes, seekHead, 0x4dbb);
  assert.equal(seeks.length, 3);
  for (const seek of seeks) {
    const [id] = inside(bytes, seek, 0x53ab),
      at = segment.start + number(bytes, inside(bytes, seek, 0x53ac)[0]);
    assert.deepEqual([...bytes.subarray(at, at + id.end - id.start)], [...bytes.subarray(id.start, id.end)]);
  }
});

test('a WebM stream longer than a block offset reaches splits its cluster', async () => {
  // 40 s with one key frame: a block's 16-bit offset would wrap at 32.767 s.
  const { webCodecs } = fakeCodecs(),
    { bytes } = await encodeVideo(frames(41), { fps: 1, keyFrameInterval: 100, webCodecs }),
    clusters = inside(bytes, webmSegment(bytes), 0x1f43b675);
  assert.equal(clusters.length, 2);
  assert.equal(number(bytes, inside(bytes, clusters[1], 0xe7)[0]), 31_000);
  assert.equal(
    inside(bytes, inside(bytes, webmSegment(bytes), 0x1c53bb6b)[0], 0xbb).length,
    1,
    'cues name key frames only',
  );
});

test('encodeVideo writes an MP4 with moov first, whose tables find every sample', async () => {
  const description = Uint8Array.of(1, 0x64, 0, 0x33, 0xff),
    { webCodecs, log } = fakeCodecs({
      description,
      colorSpace: { primaries: 'bt709', matrix: 'bt709', fullRange: true },
    }),
    video = await encodeVideo(frames(5), { format: 'mp4', fps: 10, keyFrameInterval: 0.2, webCodecs }),
    { bytes } = video;
  assert.equal(log.configs[0].codec, 'avc1.640033');
  assert.deepEqual(log.configs[0].avc, { format: 'avc' });
  assert.equal(video.mimeType, 'video/mp4; codecs="avc1.640033"');
  assert.deepEqual(
    readBoxes(bytes).map((box) => box.type),
    ['ftyp', 'moov', 'mdat'],
  );
  const stbl = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl'),
    mdhd = path(bytes, 'moov', 'trak', 'mdia', 'mdhd'),
    mvhd = path(bytes, 'moov', 'mvhd'),
    tkhd = path(bytes, 'moov', 'trak', 'tkhd'),
    stsd = child(bytes, stbl, 'stsd'),
    entry = readBoxes(bytes, stsd.start + 8, stsd.end)[0],
    config = readBoxes(bytes, entry.start + 78, entry.end);
  assert.equal(u32At(bytes, mdhd.start + 12), 10_000, 'timescale');
  assert.equal(u32At(bytes, mdhd.start + 16), 5_000, 'duration in ticks');
  assert.equal(u32At(bytes, mvhd.start + 16), 500, 'movie duration in ms');
  assert.equal(u32At(bytes, tkhd.start + 76) / 0x10000, 4);
  assert.equal(u32At(bytes, tkhd.start + 80) / 0x10000, 2);
  assert.equal(entry.type, 'avc1');
  assert.deepEqual(
    config.map((box) => box.type),
    ['avcC', 'colr'],
  );
  assert.deepEqual([...bytes.subarray(config[0].start, config[0].end)], [...description]);
  assert.deepEqual([...bytes.subarray(config[1].start + 4, config[1].end)], [0, 1, 0, 2, 0, 1, 0x80]);

  const stts = child(bytes, stbl, 'stts'),
    stss = child(bytes, stbl, 'stss'),
    stsz = child(bytes, stbl, 'stsz'),
    co64 = child(bytes, stbl, 'co64');
  assert.equal(child(bytes, stbl, 'ctts'), undefined, 'frames in order need no offsets');
  assert.deepEqual(
    [u32At(bytes, stts.start + 4), u32At(bytes, stts.start + 8), u32At(bytes, stts.start + 12)],
    [1, 5, 1000],
  );
  assert.deepEqual(
    [1, 2, 3].map((i) => u32At(bytes, stss.start + 4 + i * 4)),
    [1, 3, 5],
  );
  assert.equal(u32At(bytes, stsz.start + 8), 5);
  let at = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(co64.start + 8));
  const mdat = readBoxes(bytes).at(-1);
  assert.equal(at, mdat.start);
  for (let i = 0; i < 5; i++) {
    const size = u32At(bytes, stsz.start + 12 + i * 4);
    assert.deepEqual([...bytes.subarray(at, at + size)], [i, 0xaa, 0xbb]);
    at += size;
  }
  assert.equal(at, bytes.length, 'the tables account for every byte');
});

test('MP4 records offsets for frames that arrive out of order, and decode times stay in order', async () => {
  const { webCodecs } = fakeCodecs({ description: Uint8Array.of(1), reorder: true }),
    { bytes } = await encodeVideo(frames(4), { format: 'mp4', fps: 10, webCodecs }),
    stbl = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl'),
    ctts = child(bytes, stbl, 'ctts');
  assert.equal(bytes[ctts.start], 1, 'version 1: signed');
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    rows = view.getUint32(ctts.start + 4),
    offsets = [];
  for (let i = 0; i < rows; i++)
    for (let n = 0; n < view.getUint32(ctts.start + 8 + i * 8); n++)
      offsets.push(view.getInt32(ctts.start + 12 + i * 8));
  assert.deepEqual(offsets, [1000, -1000, 1000, -1000]);
});

test('VP9 and AV1 in MP4 carry their configuration records; AV1 in WebM its codec private', async () => {
  const vp9 = fakeCodecs({ colorSpace: { fullRange: true } }),
    { bytes } = await encodeVideo(frames(2), { format: 'mp4', codec: 'vp09.02.41.10', webCodecs: vp9.webCodecs }),
    stsd = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'),
    entry = readBoxes(bytes, stsd.start + 8, stsd.end)[0],
    vpcC = readBoxes(bytes, entry.start + 78, entry.end)[0];
  assert.equal(entry.type, 'vp09');
  assert.equal(vpcC.type, 'vpcC');
  assert.equal(bytes[vpcC.start], 1, 'version 1');
  assert.deepEqual([...bytes.subarray(vpcC.start + 4, vpcC.start + 7)], [2, 41, (10 << 4) | 3]);

  const av1 = fakeCodecs(),
    mp4 = await encodeVideo(frames(2), { format: 'mp4', codec: 'av01.0.13H.10', webCodecs: av1.webCodecs }),
    stsd1 = path(mp4.bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'),
    entry1 = readBoxes(mp4.bytes, stsd1.start + 8, stsd1.end)[0],
    av1C = readBoxes(mp4.bytes, entry1.start + 78, entry1.end)[0];
  assert.equal(av1C.type, 'av1C');
  assert.deepEqual([...mp4.bytes.subarray(av1C.start, av1C.end)], [0x81, 13, 0x80 | 0x40 | 0x0c, 0]);

  const webm = await encodeVideo(frames(2), { codec: 'av01.0.13M.08', webCodecs: fakeCodecs().webCodecs }),
    tracks = inside(webm.bytes, webmSegment(webm.bytes), 0x1654ae6b)[0],
    [entry2] = inside(webm.bytes, tracks, 0xae),
    [priv] = inside(webm.bytes, entry2, 0x63a2);
  assert.deepEqual([...webm.bytes.subarray(priv.start, priv.end)], [0x81, 13, 0x0c, 0]);
});

test('encodeVideo takes the first supported codec, and says so when none is', async () => {
  const fallback = fakeCodecs({ supported: (config) => config.codec === 'vp8' });
  assert.equal((await encodeVideo(frames(1), { webCodecs: fallback.webCodecs })).codec, 'vp8');
  assert.deepEqual(fallback.log.asked, ['vp09.00.51.08', 'vp8']);
  const none = fakeCodecs({ supported: () => false });
  await assert.rejects(encodeVideo(frames(1), { webCodecs: none.webCodecs }), { code: 'unsupported' });
  await assert.rejects(encodeVideo(frames(1), { codec: 'vp8', format: 'mp4', webCodecs: none.webCodecs }), RangeError);
  await assert.rejects(encodeVideo(frames(1), { codec: 'avc1.640033', webCodecs: none.webCodecs }), RangeError);
});

test('encodeVideo refuses what it cannot encode', async () => {
  const { webCodecs } = fakeCodecs();
  await assert.rejects(encodeVideo(frames(1), { webCodecs: {} }), { code: 'unsupported' });
  await assert.rejects(encodeVideo(frames(1)), { code: 'unsupported' }, 'Node has no WebCodecs');
  await assert.rejects(encodeVideo([], { webCodecs }), { code: 'state' });
  await assert.rejects(encodeVideo(frames(1), { format: 'avi', webCodecs }), TypeError);
  for (const options of [{ fps: 0 }, { keyFrameInterval: 0 }, { bitrate: -1 }])
    await assert.rejects(encodeVideo(frames(1), { ...options, webCodecs }), RangeError);
  await assert.rejects(encodeVideo([frame(4, 2), frame(2, 2)], { webCodecs }), /one size/);
  await assert.rejects(
    encodeVideo([{ width: 4, height: 2, data: new Uint8Array(3) }], { webCodecs }),
    /match its size/,
  );
  await assert.rejects(encodeVideo(frames(1), { format: 'mp4', webCodecs }), { code: 'failed' }, 'no avcC, no MP4');
});

test('an encoder error rejects and closes the encoder, and stops asking for frames', async () => {
  const { webCodecs, log } = fakeCodecs({ failAt: 1 });
  let asked = 0;
  async function* source() {
    for (;;) {
      asked++;
      yield frame();
      await new Promise((done) => setImmediate(done));
    }
  }
  await assert.rejects(encodeVideo(source(), { webCodecs }), /encoder broke/);
  assert.ok(asked < 5, `asked ${asked}`);
  assert.equal(log.closed, true);
});

test('a full encoder holds the source back until a frame leaves', async () => {
  const { webCodecs, log } = fakeCodecs({ queue: 4 }),
    pending = encodeVideo(frames(2), { webCodecs });
  await until(() => log.created?.listeners.length);
  assert.equal(log.encoded.length, 0);
  log.created.encodeQueueSize = 0;
  log.created.listeners[0]();
  assert.equal((await pending).frames, 2);
});

test('abort rejects with its reason at every stage, and closes the encoder', async () => {
  const early = new AbortController();
  early.abort(new Error('before'));
  await assert.rejects(encodeVideo(frames(1), { signal: early.signal, webCodecs: fakeCodecs().webCodecs }), /before/);

  const full = fakeCodecs({ queue: 4 }),
    waiting = new AbortController(),
    pending = encodeVideo(frames(1), { signal: waiting.signal, webCodecs: full.webCodecs });
  await until(() => full.log.created?.listeners.length);
  waiting.abort(new Error('queued'));
  await assert.rejects(pending, /queued/);
  assert.equal(full.log.closed, true);

  const stuck = fakeCodecs({ holdOutput: 'forever' }),
    flushing = new AbortController(),
    flush = encodeVideo(frames(1), { signal: flushing.signal, webCodecs: stuck.webCodecs });
  await until(() => stuck.log.flushing);
  flushing.abort(new Error('flushing'));
  await assert.rejects(flush, /flushing/);
  assert.equal(stuck.log.closed, true);
});

test('ffmpegArguments picks the codec from the file name, and tags BT.709', () => {
  const webm = ffmpegArguments(640, 360, { output: 'a.WEBM', fps: 24 }),
    mp4 = ffmpegArguments(640, 360, { output: 'a.mp4' });
  assert.deepEqual(webm.slice(0, 11), [
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    '640x360',
    '-r',
    '24',
    '-i',
    'pipe:0',
  ]);
  assert.ok(webm.includes('libvpx-vp9') && !webm.includes('libx264'));
  assert.ok(mp4.includes('libx264') && mp4.includes('+faststart'));
  assert.equal(mp4[10 - 2], '30');
  assert.ok(mp4.includes('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'));
  assert.deepEqual(ffmpegArguments(2, 2, { output: 'x.mkv', args: ['-c:v', 'ffv1'] }).slice(-3), [
    '-c:v',
    'ffv1',
    'x.mkv',
  ]);
});

// A program that stands in for ffmpeg: copies standard input to the last argument, or exits as told.
const STAND_IN = `
import { createWriteStream, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(args.at(-1) + '.args', JSON.stringify(args));
if (process.env.MARGO_STAND_IN === 'fail') { console.error('Unknown encoder'); process.exit(3); }
if (process.env.MARGO_STAND_IN === 'hang') setInterval(() => {}, 1000);
process.stdin.pipe(createWriteStream(args.at(-1)));
`;

test('encodeWithFFmpeg pipes every frame, in order, to the program', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-ffmpeg-'));
  try {
    const script = join(folder, 'stand-in.mjs'),
      output = join(folder, 'out.webm');
    await writeFile(script, STAND_IN);
    const big = 1 << 20, // Bigger than a pipe's buffer, so the wait for room runs.
      source = [0, 1, 2].map((value) => ({ width: 512, height: 512, data: new Uint8Array(big).fill(value) })),
      result = await encodeWithFFmpeg(source, { output, ffmpeg: [process.execPath, script], fps: 12 }),
      written = await readFile(output);
    assert.deepEqual(result, { output, width: 512, height: 512, frames: 3 });
    assert.equal(written.length, big * 3);
    assert.deepEqual([written[0], written[big], written[big * 2], written.at(-1)], [0, 1, 2, 2]);
    const args = JSON.parse(await readFile(output + '.args', 'utf8'));
    assert.deepEqual(args, ffmpegArguments(512, 512, { output, fps: 12 }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("encodeWithFFmpeg reports a failed run with ffmpeg's words, a missing program, and empty or mixed input", async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-ffmpeg-'));
  process.env.MARGO_STAND_IN = 'fail';
  try {
    const script = join(folder, 'stand-in.mjs'),
      output = join(folder, 'out.mp4'),
      ffmpeg = [process.execPath, script];
    await writeFile(script, STAND_IN);
    await assert.rejects(encodeWithFFmpeg(frames(2), { output, ffmpeg }), (error) => {
      assert.equal(error.code, 'failed');
      assert.match(error.cause, /Unknown encoder/);
      return true;
    });
    delete process.env.MARGO_STAND_IN;
    await assert.rejects(encodeWithFFmpeg(frames(1), { output, ffmpeg: join(folder, 'no-such-program') }), {
      code: 'unsupported',
    });
    await assert.rejects(encodeWithFFmpeg([], { output, ffmpeg }), { code: 'state' });
    await assert.rejects(encodeWithFFmpeg([frame(4, 2), frame(2, 2)], { output, ffmpeg }), /one size/);
    await assert.rejects(encodeWithFFmpeg(frames(1), {}), TypeError);
    await assert.rejects(encodeWithFFmpeg(frames(1), { output, fps: -1 }), RangeError);
  } finally {
    delete process.env.MARGO_STAND_IN;
    await rm(folder, { recursive: true, force: true });
  }
});

test('abort ends the ffmpeg process and rejects with the reason', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-ffmpeg-'));
  process.env.MARGO_STAND_IN = 'hang';
  try {
    const script = join(folder, 'stand-in.mjs'),
      output = join(folder, 'out.mp4'),
      controller = new AbortController();
    await writeFile(script, STAND_IN);
    async function* source() {
      yield frame();
      controller.abort(new Error('stop now'));
      yield frame();
    }
    await assert.rejects(
      encodeWithFFmpeg(source(), { output, ffmpeg: [process.execPath, script], signal: controller.signal }),
      /stop now/,
    );
  } finally {
    delete process.env.MARGO_STAND_IN;
    await rm(folder, { recursive: true, force: true });
  }
});
