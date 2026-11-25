import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createHeadlessCanvas } from '../dist/index.js';
import { encodeVideo, imageSequence, renderFrames, streamVideo } from '../dist/video.js';
import { encodeWithFFmpeg, ffmpegArguments } from '../dist/ffmpeg.js';
import { spsWithRange } from '../src/avc-range.ts';

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

/** WebCodecs stand-in. Each encoded frame becomes a chunk holding its place in encode order. */
function fakeCodecs({ supported = () => true, description, colorSpace, reorder, failAt, holdOutput, queue = 0 } = {}) {
  const log = { configs: [], encoded: [], frames: [], closedFrames: 0, closed: false, asked: [], maxQueue: 0 };
  class VideoFrame {
    constructor(data, init) {
      Object.assign(this, init, { data: Uint8Array.from(data) });
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
      picture.first = log.encoded.length;
      log.frames.push({ format: picture.format, colorSpace: picture.colorSpace, data: picture.data });
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
      unmap() {},
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
      createBuffer: (d) => ({
        mapAsync: async () => {},
        unmap() {},
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
  // Matroska ChromaSitingHorz 1 (left collocated) and ChromaSitingVert 2 (half), as the planes are made.
  assert.equal(number(bytes, inside(bytes, colour, 0x55b7)[0]), 1, 'chroma on the left column');
  assert.equal(number(bytes, inside(bytes, colour, 0x55b8)[0]), 2, 'chroma between rows');

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
  assert.deepEqual([...bytes.subarray(config[1].start + 4, config[1].end)], [0, 1, 0, 13, 0, 1, 0]);

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

// The SPS of the avcC Chromium's H.264 encoder gave on the Radeon 680M (docs/work-lists/amd-gpu-hunt.md row 11): VUI
// with video_full_range_flag 0, while its decoderConfig.colorSpace said fullRange true and its samples were full range.
const RADEON_AVCC = [
  1, 100, 4, 21, 255, 225, 0, 32, 103, 100, 4, 21, 172, 209, 65, 1, 155, 255, 0, 1, 0, 1, 66, 2, 2, 2, 128, 0, 0, 3, 0,
  128, 0, 0, 30, 71, 132, 66, 50, 192, 1, 0, 4, 104, 238, 60, 128, 253, 248, 248, 0,
];

/** The fields of a High profile SPS NAL unit (H.264 7.3.2.1.1, E.1.1), read independently of the muxer. */
function readSps(nal) {
  const rbsp = [];
  for (let i = 1, zeros = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      zeros = 0;
      continue;
    }
    rbsp.push(nal[i]);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  let at = 0;
  const bit = () => (rbsp[at >> 3] >> (7 - (at++ & 7))) & 1,
    bits = (n) => Array.from({ length: n }, bit).reduce((v, b) => v * 2 + b, 0),
    ue = () => {
      let zeros = 0;
      while (!bit()) zeros++;
      return 2 ** zeros - 1 + bits(zeros);
    };
  const head = { profile: bits(8), constraints: bits(8), level: bits(8), id: ue() };
  Object.assign(head, { chroma: ue(), luma: ue(), chromaDepth: ue(), bypass: bit(), scaling: bit() });
  Object.assign(head, { frameNum: ue(), order: ue(), orderLsb: ue(), refs: ue(), gaps: bit() });
  Object.assign(head, { width: ue(), height: ue(), frames: bit(), direct: bit(), crop: bit(), vui: bit() });
  if (!head.vui) return { head, stop: bit(), rest: rbsp.length * 8 - at };
  const vui = { aspect: bit() ? [bits(8), bits(16), bits(16)] : null, overscan: bit() };
  vui.signal = bit() ? { format: bits(3), full: bit(), colour: bit() ? [bits(8), bits(8), bits(8)] : null } : null;
  vui.chroma = bit();
  vui.timing = bit() ? [bits(32), bits(32), bit()] : null;
  vui.hrd = [bit(), bit()];
  vui.picStruct = bit();
  vui.restriction = bit() ? [bit(), ue(), ue(), ue(), ue(), ue(), ue()] : null;
  return { head, vui, stop: bit(), rest: rbsp.length * 8 - at };
}

/** Each SPS of the avcC in an MP4. */
function muxedSps(bytes) {
  const stsd = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'),
    entry = readBoxes(bytes, stsd.start + 8, stsd.end)[0],
    avcC = readBoxes(bytes, entry.start + 78, entry.end)[0],
    record = bytes.subarray(avcC.start, avcC.end),
    out = [];
  for (let i = 0, at = 6; i < (record[5] & 31); i++) {
    const size = (record[at] << 8) | record[at + 1];
    out.push(record.subarray(at + 2, at + 2 + size));
    at += 2 + size;
  }
  return out;
}

// WebKit 27.2 on macOS, given RGBA frames, wrote limited-range BT.709 samples (#336699 as Y 97, Cb 156, Cr 104) and
// reported { fullRange: true, matrix: null }; Chromium for macOS reported full range too. The file then said full range
// and players drew it contrast-reduced (docs/known-bugs.md, "WebKit headless MP4 drawn contrast-reduced").
const WEBKIT_REPORT = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: null, fullRange: true };

test('encodeVideo gives the encoder limited-range BT.709 I420 planes it converted itself', async () => {
  const { webCodecs, log } = fakeCodecs({ description: Uint8Array.from(RADEON_AVCC), colorSpace: WEBKIT_REPORT }),
    // 3 x 3 (odd: the last chroma column and row cover half blocks): #336699 except one white and one black pixel.
    data = new Uint8Array(36);
  for (let i = 0; i < 9; i++) data.set([51, 102, 153, 255], i * 4);
  data.set([255, 255, 255, 255], 0);
  data.set([0, 0, 0, 255], 8 * 4);
  // WebM (VP9) keeps the odd size; H.264 and H.265 would pad it.
  await encodeVideo([{ width: 3, height: 3, data }], { format: 'webm', fps: 10, webCodecs });
  const [frame] = log.frames;
  assert.equal(frame.format, 'I420');
  assert.deepEqual(frame.colorSpace, {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'bt709',
    fullRange: false,
  });
  // Y: 16 + 219 E'Y; white 235, black 16, #336699 97.45 (BT.709-6 items 3.2 to 3.5).
  assert.deepEqual([...frame.data.subarray(0, 9)], [235, 97, 97, 97, 97, 97, 97, 97, 16]);
  // Chroma sits where H.264 and H.265 place it when the stream does not say (H.273 chroma_sample_loc_type 0): on the
  // even luma columns, between the two rows. Each sample weighs columns 2x - 1, 2x, 2x + 1 by 1, 2, 1 and rows 2y and
  // 2y + 1 equally, edges repeated. Top left: white weighs 3 of 8, #336699 5: R'G'B' (127.5, 159.375, 191.25). Top
  // right and bottom left: #336699 alone (Cb 155.5, Cr 103.5). Bottom right: #336699 1 of 4, black 3 of 4.
  assert.deepEqual([...frame.data.subarray(9, 13)], [145, 156, 156, 135]);
  assert.deepEqual([...frame.data.subarray(13, 17)], [113, 104, 104, 122]);
});

test('H.264 and H.265 take an odd size by repeating the last column and row; VP9 and AV1 keep it', async () => {
  // H.264 and H.265 4:2:0 crop in units of two luma samples (H.264 7.4.2.1.1 CropUnitX and CropUnitY; H.265 7.4.3.2.1
  // SubWidthC and SubHeightC), so an odd picture cannot be stated, and their encoders refuse one.
  const data = new Uint8Array(3 * 3 * 4);
  for (let i = 0; i < 9; i++) data.set([(i % 3) * 100, Math.floor(i / 3) * 100, 0, 255], i * 4);
  for (const codec of ['avc1.42001f', 'hvc1.1.6.L93.B0']) {
    const { webCodecs, log } = fakeCodecs({ description: Uint8Array.from(RADEON_AVCC) }),
      video = await encodeVideo(
        [
          { width: 3, height: 3, data },
          { width: 3, height: 3, data },
        ],
        {
          format: 'mp4',
          fps: 10,
          codec,
          webCodecs,
        },
      );
    assert.deepEqual([log.configs[0].width, log.configs[0].height], [4, 4], codec);
    assert.deepEqual([video.width, video.height], [4, 4], `${codec}: the file states the size it holds`);
    const y = [...log.frames[0].data.subarray(0, 16)],
      luma = (r, g) => Math.round(16 + (219 / 255) * (0.2126 * r + 0.7152 * g));
    assert.deepEqual(
      y,
      [0, 1, 2, 2].flatMap((row) => [0, 1, 2, 2].map((col) => luma(Math.min(col, 2) * 100, Math.min(row, 2) * 100))),
      `${codec}: column 3 and row 3 repeat column 2 and row 2`,
    );
    assert.equal(log.frames[0].data.length, 16 + 2 * 4, `${codec}: 2 x 2 chroma`);
  }
  for (const [format, codec] of [
    ['webm', 'vp09.00.10.08'],
    ['mp4', 'av01.0.04M.08'],
  ]) {
    const { webCodecs, log } = fakeCodecs(),
      video = await encodeVideo([{ width: 3, height: 3, data }], { format, fps: 10, codec, webCodecs });
    assert.deepEqual([log.configs[0].width, log.configs[0].height, video.width, video.height], [3, 3, 3, 3], codec);
  }
  const { webCodecs } = fakeCodecs({ description: Uint8Array.from(RADEON_AVCC) });
  await assert.rejects(
    encodeVideo(
      [
        { width: 3, height: 3, data },
        { width: 4, height: 4, data: new Uint8Array(64) },
      ],
      { format: 'mp4', codec: 'avc1.42001f', webCodecs },
    ),
    RangeError,
    'a padded size is not a new frame size',
  );
});

test('encodeVideo places chroma on the even luma columns, as H.264, H.265, VP9 and AV1 players assume', async () => {
  const { webCodecs, log } = fakeCodecs({ description: Uint8Array.from(RADEON_AVCC) }),
    // 4 x 2: red in columns 0 and 1, blue in 2 and 3. A centred 2 x 2 mean would give pure red then pure blue, which
    // a player then draws half a pixel to the right of where it was rendered.
    data = new Uint8Array(32);
  for (let i = 0; i < 8; i++) data.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  await encodeVideo([{ width: 4, height: 2, data }], { format: 'mp4', fps: 10, webCodecs });
  const chroma = [...log.frames[0].data.subarray(8)],
    red = [
      Math.round(128 + (224 / 255) * ((0 - 54.213) / 1.8556)),
      Math.round(128 + (224 / 255) * ((255 - 54.213) / 1.5748)),
    ],
    // Column 2 weighs red 1 of 4 and blue 3 of 4.
    mix = [0.25 * 255, 0, 0.75 * 255],
    e = 0.2126 * mix[0] + 0.0722 * mix[2];
  assert.deepEqual(chroma, [
    red[0],
    Math.round(128 + (224 / 255) * ((mix[2] - e) / 1.8556)),
    red[1],
    Math.round(128 + (224 / 255) * ((mix[0] - e) / 1.5748)),
  ]);
});

test('an H.264 MP4 states limited range in its SPS and colr box, whatever range the encoder reports', async () => {
  const source = readSps(Uint8Array.from(RADEON_AVCC.slice(8, 40))),
    // The recorded SPS with its video_full_range_flag set, as an encoder that reports full range may write it.
    full = spsWithRange(Uint8Array.from(RADEON_AVCC.slice(8, 40)), true),
    fullRecord = [...RADEON_AVCC.slice(0, 6), 0, full.length, ...full, ...RADEON_AVCC.slice(40)];
  assert.equal(source.vui.signal.full, 0, 'the recorded SPS says limited');
  assert.equal(readSps(full).vui.signal.full, 1);
  for (const record of [RADEON_AVCC, fullRecord])
    for (const colorSpace of [WEBKIT_REPORT, { ...WEBKIT_REPORT, matrix: 'bt709', fullRange: false }, undefined]) {
      const { webCodecs } = fakeCodecs({ description: Uint8Array.from(record), colorSpace }),
        { bytes } = await encodeVideo(frames(3), { format: 'mp4', fps: 10, webCodecs }),
        list = muxedSps(bytes),
        stsd = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'),
        entry = readBoxes(bytes, stsd.start + 8, stsd.end)[0],
        colr = readBoxes(bytes, entry.start + 78, entry.end)[1];
      assert.equal(list.length, 1);
      assert.deepEqual([...list[0]], RADEON_AVCC.slice(8, 40), 'limited: the recorded bytes, every field the same');
      assert.deepEqual([...bytes.subarray(colr.start + 4, colr.end)], [0, 1, 0, 13, 0, 1, 0], 'BT.709, sRGB, limited');
    }
});

test('an SPS without VUI stays as given: limited is its default', async () => {
  // The recorded SPS cut at its vui_parameters_present_flag (bit 62 of the RBSP), which is then 0, and its stop bit.
  const rbsp = RADEON_AVCC.slice(9, 40),
    kept = Array.from({ length: 62 }, (_, i) => (rbsp[i >> 3] >> (7 - (i & 7))) & 1),
    all = [...kept, 0, 1, 0],
    plain = [
      103,
      ...Array.from({ length: all.length / 8 }, (_, i) => all.slice(i * 8, i * 8 + 8).reduce((v, b) => v * 2 + b, 0)),
    ],
    record = [...RADEON_AVCC.slice(0, 6), 0, plain.length, ...plain, ...RADEON_AVCC.slice(40)];
  assert.equal(readSps(Uint8Array.from(plain)).head.vui, 0);
  for (const fullRange of [true, false]) {
    const { webCodecs } = fakeCodecs({ description: Uint8Array.from(record), colorSpace: { fullRange } }),
      { bytes } = await encodeVideo(frames(2), { format: 'mp4', fps: 10, webCodecs }),
      [sps] = muxedSps(bytes);
    assert.deepEqual([...sps], plain, `reported fullRange ${fullRange}: the bytes as given`);
  }
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
  // Chroma 0: 4:2:0 sited vertically between rows, on the left column, as the planes are made (VP codec ISOBMFF binding).
  assert.deepEqual([...bytes.subarray(vpcC.start + 4, vpcC.start + 7)], [2, 41, 10 << 4]);

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
  // The frames carry all four BT.709 tags (setparams): ffmpeg 9 writes the frames' own primaries and transfer over the
  // -color_primaries and -color_trc options, and the scaler alone leaves both unset (known-bugs, 2026-11-14).
  // The transfer is sRGB (H.273 code 13), as encodeVideo states it: the frames are sRGB-encoded renders. Chroma is
  // made and tagged on the left column between rows (H.273 chroma_sample_loc_type 0), as encodeVideo makes it.
  const filter =
    'scale=out_color_matrix=bt709:out_range=tv:out_chroma_loc=left,format=yuv420p,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv:chroma_location=left';
  for (const args of [mp4, webm]) {
    assert.equal(args[args.indexOf('-vf') + 1], filter);
    for (const [option, value] of [
      ['-colorspace', 'bt709'],
      ['-color_primaries', 'bt709'],
      ['-color_trc', 'iec61966-2-1'],
      ['-color_range', 'tv'],
      ['-chroma_sample_location', 'left'],
    ])
      assert.equal(args[args.indexOf(option) + 1], value, option);
  }
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
if (process.env.MARGO_STAND_IN === 'fail') { console.error('Unknown encoder'); process.exitCode = 3; }
else {
  if (process.env.MARGO_STAND_IN === 'hang') setInterval(() => {}, 1000);
  process.stdin.pipe(createWriteStream(args.at(-1)));
}
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

test('encodeWithFFmpeg gives H.264 an even size by repeating the last column and row; VP9 and custom args keep it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-ffmpeg-'));
  try {
    const script = join(folder, 'stand-in.mjs'),
      data = Uint8Array.from({ length: 3 * 3 * 4 }, (_, i) => i);
    await writeFile(script, STAND_IN);
    const mp4 = join(folder, 'odd.mp4'),
      result = await encodeWithFFmpeg([{ width: 3, height: 3, data }], {
        output: mp4,
        ffmpeg: [process.execPath, script],
      }),
      written = await readFile(mp4),
      args = JSON.parse(await readFile(mp4 + '.args', 'utf8'));
    assert.deepEqual(result, { output: mp4, width: 4, height: 4, frames: 1 });
    assert.equal(args[args.indexOf('-s') + 1], '4x4');
    const pixel = (x, y) => [...data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
    assert.deepEqual(
      [...written],
      [0, 1, 2, 2].flatMap((y) => [0, 1, 2, 2].flatMap((x) => pixel(Math.min(x, 2), Math.min(y, 2)))),
    );
    for (const [output, args] of [
      [join(folder, 'odd.webm'), undefined],
      [join(folder, 'odd.mkv'), ['-c:v', 'ffv1']],
    ]) {
      const kept = await encodeWithFFmpeg([{ width: 3, height: 3, data }], {
        output,
        args,
        ffmpeg: [process.execPath, script],
      });
      assert.deepEqual([kept.width, kept.height], [3, 3], output);
      assert.deepEqual([...(await readFile(output))], [...data], output);
    }
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

// A stand-in that also copies the sound pipe (fd 3) to the output's `.sound` file.
const SOUND_STAND_IN = `
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(args.at(-1) + '.args', JSON.stringify(args));
createReadStream(null, { fd: 3 }).pipe(createWriteStream(args.at(-1) + '.sound'));
process.stdin.pipe(createWriteStream(args.at(-1)));
`;

test('encodeWithFFmpeg pipes sound as interleaved f32le on pipe 3 beside the frames, and maps it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-ffmpeg-'));
  try {
    const script = join(folder, 'stand-in.mjs'),
      output = join(folder, 'out.mp4');
    await writeFile(script, SOUND_STAND_IN);
    // Longer than one write block and than a pipe's buffer, so the sound waits for room while frames are written.
    const length = 100_000,
      left = Float32Array.from({ length }, (_, i) => Math.sin(i / 7)),
      right = Float32Array.from({ length }, (_, i) => -i / length),
      audio = { channels: [left, right], sampleRate: 48_000, bitrate: 96_000 },
      source = [0, 1].map((value) => ({ width: 512, height: 512, data: new Uint8Array(1 << 20).fill(value) })),
      result = await encodeWithFFmpeg(source, { output, ffmpeg: [process.execPath, script], audio });
    assert.deepEqual(result, { output, width: 512, height: 512, frames: 2, audioDuration: length / 48_000 });
    const sound = await readFile(output + '.sound'),
      samples = new Float32Array(sound.buffer, sound.byteOffset, sound.length / 4);
    assert.equal(samples.length, length * 2);
    for (const i of [0, 1, 16383, 16384, 99_999])
      assert.deepEqual([samples[2 * i], samples[2 * i + 1]], [left[i], right[i]]);
    const args = JSON.parse(await readFile(output + '.args', 'utf8'));
    assert.deepEqual(args, ffmpegArguments(512, 512, { output, audio }));
    const at = args.indexOf('pipe:3');
    assert.deepEqual(args.slice(at - 7, at + 5), [
      '-f',
      'f32le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-i',
      'pipe:3',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
    ]);
    assert.ok(!args.includes('-an'));
    assert.deepEqual(args.slice(-5, -1), ['-c:a', 'aac', '-b:a', '96000']);
    assert.deepEqual(ffmpegArguments(2, 2, { output: 'a.webm', audio }).slice(-5, -1), [
      '-c:a',
      'libopus',
      '-b:a',
      '96000',
    ]);
    // Custom args: the sound is still input 1 and mapped; its codec is the caller's.
    assert.deepEqual(ffmpegArguments(2, 2, { output: 'a.mkv', args: ['-c:v', 'ffv1'], audio }).slice(-3), [
      '-c:v',
      'ffv1',
      'a.mkv',
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('encodeWithFFmpeg checks its sound before starting ffmpeg', async () => {
  const frame = { width: 2, height: 2, data: new Uint8Array(16) },
    bad = [
      { channels: [], sampleRate: 48_000 },
      { channels: [new Float32Array(4), new Float32Array(5)], sampleRate: 48_000 },
      { channels: [new Float32Array(0)], sampleRate: 48_000 },
      { channels: [[0, 1]], sampleRate: 48_000 },
      { channels: [new Float32Array(4)], sampleRate: 0 },
      { channels: [new Float32Array(4)], sampleRate: 44_100.5 },
      { channels: [new Float32Array(4)], sampleRate: 48_000, bitrate: -1 },
    ];
  for (const audio of bad)
    await assert.rejects(encodeWithFFmpeg([frame], { output: 'x.mp4', ffmpeg: 'margo-no-such-program', audio }), {
      name: 'RangeError',
    });
});

// Every piece of a stream, the frames pulled when each came out, and the iteration's return value.
async function drain(stream, pulled) {
  const pieces = [],
    at = [];
  let step;
  while (!(step = await stream.next()).done) {
    pieces.push(step.value);
    at.push(pulled());
  }
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  pieces.reduce((offset, piece) => (bytes.set(piece, offset), offset + piece.length), 0);
  return { pieces, at, bytes, result: step.value };
}

test('streamVideo writes a fragmented MP4 piece by piece: header, a moof and mdat per key frame interval, then mfra', async () => {
  const { webCodecs, log } = fakeCodecs({ description: Uint8Array.of(1, 0x64, 0, 0x33, 0xff, 0xe0, 0) });
  let pulled = 0;
  function* source() {
    for (let i = 0; i < 7; i++) {
      pulled++;
      yield frame(4, 2, i);
    }
  }
  const { pieces, at, bytes, result } = await drain(
    streamVideo(source(), { fps: 2, keyFrameInterval: 1.5, codec: 'vp09.00.10.08', webCodecs }),
    () => pulled,
  );
  // The header comes out after the first frame, and each fragment once the next key frame shows where it ends: frames
  // are not all held until the end.
  assert.equal(pieces.length, 5);
  assert.deepEqual(at, [1, 4, 7, 7, 7]);
  assert.deepEqual(result, {
    mimeType: 'video/mp4; codecs="vp09.00.10.08"',
    codec: 'vp09.00.10.08',
    width: 4,
    height: 2,
    frames: 7,
    duration: 3.5,
  });
  assert.equal(log.closed, true);
  const top = readBoxes(bytes);
  assert.deepEqual(
    top.map((box) => box.type),
    ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'mfra'],
  );
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'iso6');
  const trex = path(bytes, 'moov', 'mvex', 'trex');
  assert.deepEqual([u32At(bytes, trex.start + 4), u32At(bytes, trex.start + 8)], [1, 1]);
  const stbl = path(bytes, 'moov', 'trak', 'mdia', 'minf', 'stbl');
  assert.equal(u32At(bytes, child(bytes, stbl, 'stsz').start + 8), 0, 'no samples in the header tables');
  assert.equal(u32At(bytes, path(bytes, 'moov', 'trak', 'mdia', 'mdhd').start + 12), 2000);
  const moofs = top.filter((box) => box.type === 'moof');
  moofs.forEach((moof, n) => {
    const mfhd = child(bytes, moof, 'mfhd'),
      traf = child(bytes, moof, 'traf'),
      tfhd = child(bytes, traf, 'tfhd'),
      tfdt = child(bytes, traf, 'tfdt'),
      trun = child(bytes, traf, 'trun'),
      view = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(u32At(bytes, mfhd.start + 4), n + 1, 'sequence numbers count from 1');
    assert.equal(u32At(bytes, tfhd.start) & 0xffffff, 0x020000, 'default-base-is-moof');
    assert.equal(Number(view.getBigUint64(tfdt.start + 4)), n * 3000, 'absolute decode time');
    const count = u32At(bytes, trun.start + 4),
      offset = u32At(bytes, trun.start + 8);
    assert.equal(count, n < 2 ? 3 : 1);
    for (let i = 0, data = moof.start - 8 + offset; i < count; i++) {
      const row = trun.start + 12 + i * 12;
      assert.deepEqual([u32At(bytes, row), u32At(bytes, row + 4)], [1000, 3], 'duration and size');
      assert.equal(u32At(bytes, row + 8), i === 0 ? 0x02000000 : 0x01010000, 'sync flags');
      assert.deepEqual(
        [...bytes.subarray(data, data + 3)],
        [n * 3 + i, 0xaa, 0xbb],
        'the data offset finds the sample',
      );
      data += 3;
    }
  });
  // mfra: one entry per fragment, at its moof, and mfro gives the mfra size so a reader finds it from the end.
  const mfra = top.at(-1),
    tfra = child(bytes, mfra, 'tfra'),
    view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(u32At(bytes, tfra.start + 12), 3);
  for (let n = 0; n < 3; n++) {
    const row = tfra.start + 16 + n * 19;
    assert.equal(Number(view.getBigUint64(row)), n * 3000);
    assert.equal(Number(view.getBigUint64(row + 8)), moofs[n].start - 8);
  }
  assert.equal(u32At(bytes, bytes.length - 4), mfra.end - mfra.start + 8);
});

test('streamVideo: stopping early closes the encoder; an H.264 stream carries its avcC; bad options throw', async () => {
  const { webCodecs, log } = fakeCodecs({ description: Uint8Array.of(1, 0x64, 0, 0x33, 0xff, 0xe0, 0) });
  for await (const piece of streamVideo(frames(9), { webCodecs, codec: 'avc1.640033' })) {
    assert.ok(path(piece, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'));
    break;
  }
  assert.equal(log.closed, true);
  const stopped = new AbortController(),
    { webCodecs: second, log: secondLog } = fakeCodecs();
  stopped.abort(new Error('stop'));
  await assert.rejects(streamVideo(frames(2), { webCodecs: second, signal: stopped.signal }).next(), /stop/);
  assert.equal(secondLog.created, undefined);
  await assert.rejects(streamVideo(frames(2), { webCodecs: second, fps: 0 }).next(), { name: 'RangeError' });
  await assert.rejects(streamVideo([], { webCodecs: second }).next(), /No frames/);
});
