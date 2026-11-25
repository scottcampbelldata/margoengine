// Container conformance of encodeVideo's MP4 and WebM files, checked against the bindings they follow: the AV1 ISOBMFF
// binding (brand, stored OBUs), Encapsulation of Opus in ISOBMFF (sample rate, time unit, edit list, roll groups), the
// Matroska codec mappings (A_OPUS SamplingFrequency, V_VP9 CodecPrivate) and RFC 6381 (codecs of every stream).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVideo, streamVideo } from '../dist/video.js';

const frame = (value = 1) => ({ width: 4, height: 2, data: new Uint8Array(32).fill(value) });

/** WebCodecs stand-in: each video chunk is `payload(index)`; each AudioData becomes one sound chunk. */
function codecs({ payload = () => Uint8Array.of(1), audio = ['opus', 'mp4a.40.2'], description } = {}) {
  class VideoFrame {
    constructor(_data, init) {
      Object.assign(this, init);
    }
    close() {}
  }
  class VideoEncoder extends EventTarget {
    state = 'configured';
    encodeQueueSize = 0;
    count = 0;
    static isConfigSupported = async () => ({ supported: true });
    constructor({ output }) {
      super();
      this.output = output;
    }
    configure() {}
    encode(picture, { keyFrame }) {
      const data = payload(this.count++);
      this.output(
        {
          byteLength: data.length,
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
    static isConfigSupported = async (config) => ({ supported: audio.includes(config.codec) });
    constructor({ output }) {
      this.output = output;
    }
    configure() {}
    encode(data) {
      this.output(
        {
          byteLength: 3,
          timestamp: data.timestamp,
          duration: Math.round((data.numberOfFrames * 1e6) / data.sampleRate),
          copyTo: (out) => out.set([0xaa, 0xbb, 0xcc]),
        },
        { decoderConfig: description ? { description } : undefined },
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  return { VideoEncoder, VideoFrame, AudioEncoder, AudioData };
}

const sound = (seconds, rate) => ({ channels: [new Float32Array(seconds * rate).fill(0.25)], sampleRate: rate });

/** An OpusHead (RFC 7845 5.1) with this pre-skip and input sample rate. */
function opusHead(preSkip, inputRate) {
  const head = new Uint8Array(19),
    view = new DataView(head.buffer);
  head.set(Buffer.from('OpusHead'));
  head[8] = 1;
  head[9] = 1;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  return head;
}

function boxes(bytes, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    out = [];
  while (from + 8 <= to) {
    let size = view.getUint32(from),
      head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(from + 8));
      head = 16;
    }
    out.push({
      type: String.fromCharCode(...bytes.subarray(from + 4, from + 8)),
      start: from + head,
      end: from + size,
    });
    from += size;
  }
  return out;
}
const find = (bytes, parent, type, skip = 0) =>
  boxes(bytes, parent ? parent.start + skip : 0, parent ? parent.end : bytes.length).find((one) => one.type === type);
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

/** EBML elements of `bytes` between `from` and `to`. */
function elements(bytes, from = 0, to = bytes.length) {
  const out = [],
    vint = (at, keepMarker) => {
      let length = 1;
      while (!(bytes[at] & (0x80 >> (length - 1)))) length++;
      let value = keepMarker ? bytes[at] : bytes[at] & (0xff >> length);
      for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
      return [value, length];
    };
  while (from < to) {
    const [id, idLength] = vint(from, true),
      [size, sizeLength] = vint(from + idLength, false),
      start = from + idLength + sizeLength;
    out.push({ id, start, end: start + size });
    from = start + size;
  }
  return out;
}
const inside = (bytes, parent, id) => elements(bytes, parent.start, parent.end).filter((one) => one.id === id);

test('Opus in MP4: 48 kHz entry and time unit, the OpusHead input rate, pre-skip cut by an edit list, roll groups', async () => {
  const webCodecs = codecs({ audio: ['opus'], description: opusHead(312, 44_100) }),
    video = await encodeVideo([frame(), frame()], {
      format: 'mp4',
      codec: 'vp09.00.10.08',
      fps: 2,
      audio: sound(2, 44_100),
      webCodecs,
    }),
    { bytes } = video,
    moov = find(bytes, null, 'moov'),
    [, trak] = boxes(bytes, moov.start, moov.end).filter((one) => one.type === 'trak'),
    mdia = find(bytes, trak, 'mdia'),
    stbl = find(bytes, find(bytes, mdia, 'minf'), 'stbl'),
    entry = find(bytes, find(bytes, stbl, 'stsd'), 'Opus', 8),
    dOps = find(bytes, entry, 'dOps', 28),
    elst = find(bytes, find(bytes, trak, 'edts'), 'elst');
  assert.equal(video.mimeType, 'video/mp4; codecs="vp09.00.10.08,opus"');
  assert.equal(u32(bytes, entry.start + 24), 48_000 * 0x10000, 'OpusSampleEntry samplerate is 48000 << 16');
  assert.equal(u32(bytes, dOps.start + 4), 44_100, 'InputSampleRate from the OpusHead');
  assert.equal(u32(bytes, find(bytes, mdia, 'mdhd').start + 12), 48_000, 'media time unit');
  assert.ok(elst, 'the pre-skip is cut by an edit list');
  assert.equal(u32(bytes, elst.start + 12), 312, 'media_time is the pre-skip');
  const sgpd = find(bytes, stbl, 'sgpd');
  assert.ok(sgpd && find(bytes, stbl, 'sbgp'), 'Opus needs roll groups');
  // One packet here is half a second, so 80 ms of pre-roll is the one packet before.
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getInt16(sgpd.start + 16), -1);
  // Track headers: the video plays 1 s, the sound 2 s less the pre-skip; the movie is the longer.
  const [videoTrak] = boxes(bytes, moov.start, moov.end).filter((one) => one.type === 'trak'),
    soundLength = Math.round(((96_000 - 312) / 48_000) * 1000);
  assert.equal(u32(bytes, find(bytes, videoTrak, 'tkhd').start + 20), 1000);
  assert.equal(u32(bytes, find(bytes, trak, 'tkhd').start + 20), soundLength);
  assert.equal(u32(bytes, elst.start + 8), soundLength);
  assert.equal(u32(bytes, find(bytes, moov, 'mvhd').start + 16), soundLength);
});

test('the codecs parameter names the sound too: AAC in MP4, Opus in WebM', async () => {
  const mp4 = await encodeVideo([frame()], {
    format: 'mp4',
    codec: 'vp09.00.10.08',
    fps: 2,
    audio: sound(1, 48_000),
    webCodecs: codecs({ description: Uint8Array.of(0x11, 0x90) }),
  });
  assert.equal(mp4.mimeType, 'video/mp4; codecs="vp09.00.10.08,mp4a.40.2"');
  const webm = await encodeVideo([frame()], { fps: 2, audio: sound(1, 48_000), webCodecs: codecs() });
  assert.match(webm.mimeType, /^video\/webm; codecs="[^",]+,opus"$/);
  const silent = await encodeVideo([frame()], { fps: 2, webCodecs: codecs() });
  assert.doesNotMatch(silent.mimeType, /,/);
});

test('WebM Opus SamplingFrequency is the OpusHead input sample rate', async () => {
  const { bytes } = await encodeVideo([frame()], {
      fps: 2,
      audio: sound(1, 48_000),
      webCodecs: codecs({ description: opusHead(312, 16_000) }),
    }),
    segment = elements(bytes).find((one) => one.id === 0x18538067),
    [tracks] = inside(bytes, segment, 0x1654ae6b),
    [, entry] = inside(bytes, tracks, 0xae),
    [audio] = inside(bytes, entry, 0xe1),
    [rate] = inside(bytes, audio, 0xb5);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getFloat64(rate.start), 16_000);
});

test('VP9 in WebM carries the codec feature list as its CodecPrivate', async () => {
  const { bytes } = await encodeVideo([frame()], { codec: 'vp09.02.41.10', webCodecs: codecs() }),
    segment = elements(bytes).find((one) => one.id === 0x18538067),
    [tracks] = inside(bytes, segment, 0x1654ae6b),
    [entry] = inside(bytes, tracks, 0xae),
    [priv] = inside(bytes, entry, 0x63a2);
  assert.ok(priv, 'CodecPrivate present');
  // Chroma subsampling 0: 4:2:0 vertical, the left column between rows, where encodeVideo makes its chroma.
  assert.deepEqual([...bytes.subarray(priv.start, priv.end)], [1, 1, 2, 2, 1, 41, 3, 1, 10, 4, 1, 0]);
});

// AV1 OBU headers (AV1 5.3.2): type in bits 6 to 3, has_size_field bit 1.
const TEMPORAL_DELIMITER = [0x12, 0x00],
  PADDING = [0x7a, 0x02, 0xee, 0xee],
  SEQUENCE_HEADER = [0x0a, 0x03, 0x00, 0x00, 0x00],
  FRAME = [0x32, 0x02, 0x10, 0x20];

test('AV1 units are stored without temporal delimiters or padding, and an AV1 MP4 has the av01 brand', async () => {
  const unit = (i) => Uint8Array.from([...TEMPORAL_DELIMITER, ...(i ? [] : SEQUENCE_HEADER), ...PADDING, ...FRAME, i]);
  const fixed = codecs({ payload: (i) => unit(i).subarray(0, unit(i).length - 1) });
  const mp4 = (await encodeVideo([frame(), frame()], { format: 'mp4', codec: 'av01.0.04M.08', webCodecs: fixed }))
    .bytes;
  const ftyp = find(mp4, null, 'ftyp'),
    brands = [];
  for (let at = ftyp.start + 8; at < ftyp.end; at += 4) brands.push(String.fromCharCode(...mp4.subarray(at, at + 4)));
  assert.ok(brands.includes('av01'), `brands ${brands}`);
  const moov = find(mp4, null, 'moov'),
    stbl = find(mp4, find(mp4, find(mp4, find(mp4, moov, 'trak'), 'mdia'), 'minf'), 'stbl'),
    stsz = find(mp4, stbl, 'stsz'),
    mdat = find(mp4, null, 'mdat');
  assert.deepEqual([u32(mp4, stsz.start + 12), u32(mp4, stsz.start + 16)], [SEQUENCE_HEADER.length + 4, 4]);
  assert.deepEqual([...mp4.subarray(mdat.start, mdat.end)], [...SEQUENCE_HEADER, ...FRAME, ...FRAME]);

  const webm = (
    await encodeVideo([frame()], {
      codec: 'av01.0.04M.08',
      webCodecs: codecs({ payload: () => unit(0).subarray(0, -1) }),
    })
  ).bytes;
  const segment = elements(webm).find((one) => one.id === 0x18538067),
    [cluster] = inside(webm, segment, 0x1f43b675),
    [block] = inside(webm, cluster, 0xa3);
  assert.deepEqual([...webm.subarray(block.start + 4, block.end)], [...SEQUENCE_HEADER, ...FRAME]);
});

test('an AV1 unit that cannot be walked is stored as the encoder gave it', async () => {
  const broken = Uint8Array.of(0x12, 0x00, 0x32, 0x09, 0x10); // A frame OBU whose size runs past the end
  const mp4 = (
    await encodeVideo([frame()], {
      format: 'mp4',
      codec: 'av01.0.04M.08',
      webCodecs: codecs({ payload: () => broken }),
    })
  ).bytes;
  const mdat = find(mp4, null, 'mdat');
  assert.deepEqual([...mp4.subarray(mdat.start, mdat.end)], [...broken]);
});

test('H.265 in MP4: an hvc1 or hev1 entry with the encoder record as hvcC, asked for in length-prefixed form', async () => {
  const record = Uint8Array.of(
    1,
    1,
    0x60,
    0,
    0,
    0,
    0x90,
    0,
    0,
    0,
    0,
    0,
    93,
    0xf0,
    0,
    0xfc,
    0xfd,
    0xf8,
    0xf8,
    0,
    0,
    0x0f,
    0,
  );
  for (const codec of ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0']) {
    const asked = [],
      webCodecs = codecs({ payload: () => Uint8Array.of(0, 0, 0, 2, 0x26, 0x01) });
    const Base = webCodecs.VideoEncoder;
    webCodecs.VideoEncoder = class extends Base {
      static isConfigSupported = async (config) => (asked.push(config), { supported: true });
      encode(picture, options) {
        const output = this.output;
        this.output = (chunk) => output(chunk, { decoderConfig: { codec, description: record } });
        super.encode(picture, options);
        this.output = output;
      }
    };
    const video = await encodeVideo([frame()], { format: 'mp4', codec, webCodecs }),
      bytes = video.bytes,
      stbl = find(
        bytes,
        find(bytes, find(bytes, find(bytes, find(bytes, null, 'moov'), 'trak'), 'mdia'), 'minf'),
        'stbl',
      ),
      entry = find(bytes, find(bytes, stbl, 'stsd'), codec.slice(0, 4), 8),
      hvcC = find(bytes, entry, 'hvcC', 78);
    assert.deepEqual(asked[0].hevc, { format: 'hevc' });
    assert.deepEqual([...bytes.subarray(hvcC.start, hvcC.end)], [...record]);
    assert.ok(find(bytes, entry, 'colr', 78));
    assert.equal(video.mimeType, `video/mp4; codecs="${codec}"`);
  }
  const silent = codecs();
  await assert.rejects(
    encodeVideo([frame()], { format: 'mp4', codec: 'hvc1.1.6.L93.B0', webCodecs: silent }),
    /H\.265/,
  );
  await assert.rejects(encodeVideo([frame()], { codec: 'hvc1.1.6.L93.B0', webCodecs: silent }), /does not fit/);
});

/** A sequence header OBU (AV1 5.5) with tier-high level 8, 4:2:0 at sample position 2, profile 0, 8 bits. */
function sequenceHeader() {
  const fields = [
    [0, 3],
    [0, 1],
    [0, 1], // profile, still_picture, reduced_still_picture_header
    [0, 1],
    [0, 1],
    [0, 5], // timing_info_present_flag, initial_display_delay_present_flag, operating_points_cnt_minus_1
    [0, 12],
    [8, 5],
    [1, 1], // operating_point_idc, seq_level_idx, seq_tier
    [15, 4],
    [15, 4],
    [639, 16],
    [359, 16], // frame size bits and maxima
    [0, 1],
    [0, 1],
    [1, 1],
    [1, 1], // frame ids, 128x128, filter intra, intra edge
    [0, 4],
    [1, 1],
    [0, 2], // compound and warp tools, enable_order_hint, jnt_comp and ref_frame_mvs
    [1, 1],
    [1, 1],
    [6, 3], // choose screen content tools, choose integer mv, order_hint_bits_minus_1
    [0, 1],
    [1, 1],
    [1, 1], // superres, cdef, restoration
    [0, 1],
    [0, 1],
    [1, 1],
    [1, 8],
    [13, 8],
    [1, 8], // high_bitdepth, mono_chrome, colour description
    [0, 1],
    [2, 2],
    [0, 1],
    [1, 1], // color_range, chroma_sample_position, separate_uv_delta_q, trailing one
  ];
  const bits = fields.flatMap(([value, size]) => Array.from({ length: size }, (_, i) => (value >> (size - 1 - i)) & 1));
  while (bits.length % 8) bits.push(0);
  const payload = [];
  for (let i = 0; i < bits.length; i += 8) payload.push(bits.slice(i, i + 8).reduce((v, b) => v * 2 + b, 0));
  return [0x0a, payload.length, ...payload];
}

test('the AV1 record is read from the sequence header the encoder wrote, which follows it as a config OBU', async () => {
  const header = sequenceHeader(),
    unit = () => Uint8Array.from([...TEMPORAL_DELIMITER, ...header, ...FRAME]),
    expected = [0x81, 8, 0x80 | 0x08 | 0x04 | 2, 0, ...header];
  // The codec string names level 5.1 main tier; the stream says level 8 (4.0) high tier.
  const mp4 = (
    await encodeVideo([frame()], { format: 'mp4', codec: 'av01.0.13M.08', webCodecs: codecs({ payload: unit }) })
  ).bytes;
  const stbl = find(mp4, find(mp4, find(mp4, find(mp4, find(mp4, null, 'moov'), 'trak'), 'mdia'), 'minf'), 'stbl'),
    entry = find(mp4, find(mp4, stbl, 'stsd'), 'av01', 8),
    av1C = find(mp4, entry, 'av1C', 78);
  assert.deepEqual([...mp4.subarray(av1C.start, av1C.end)], expected);
  const webm = (await encodeVideo([frame()], { codec: 'av01.0.13M.08', webCodecs: codecs({ payload: unit }) })).bytes,
    segment = elements(webm).find((one) => one.id === 0x18538067),
    [tracks] = inside(webm, segment, 0x1654ae6b),
    [entry2] = inside(webm, tracks, 0xae),
    [priv] = inside(webm, entry2, 0x63a2);
  assert.deepEqual([...webm.subarray(priv.start, priv.end)], expected);
});

test('a sequence header that ends before its colour fields leaves the AV1 record to the codec string', async () => {
  const whole = sequenceHeader(),
    cut = [whole[0], 6, ...whole.slice(2, 8)],
    unit = () => Uint8Array.from([...TEMPORAL_DELIMITER, ...cut, ...FRAME]);
  const mp4 = (
    await encodeVideo([frame()], { format: 'mp4', codec: 'av01.0.13M.08', webCodecs: codecs({ payload: unit }) })
  ).bytes;
  const stbl = find(mp4, find(mp4, find(mp4, find(mp4, find(mp4, null, 'moov'), 'trak'), 'mdia'), 'minf'), 'stbl'),
    entry = find(mp4, find(mp4, stbl, 'stsd'), 'av01', 8),
    av1C = find(mp4, entry, 'av1C', 78);
  assert.deepEqual([...mp4.subarray(av1C.start, av1C.end)], [0x81, 13, 0x0c, 0]);
});

test('frames with their own times: variable durations in MP4 and WebM, keys by time, times from the first frame', async () => {
  const timed = (times, last) =>
      times.map((timestamp, i) => ({
        ...frame(i),
        timestamp,
        ...(i === times.length - 1 && last ? { duration: last } : {}),
      })),
    mp4 = await encodeVideo(timed([1, 1.1, 1.25, 1.3]), {
      format: 'mp4',
      codec: 'vp09.00.10.08',
      fps: 10,
      keyFrameInterval: 0.2,
      webCodecs: codecs(),
    });
  // The last frame lasts the gap before it; times count from the first frame.
  assert.equal(mp4.duration, 0.35);
  assert.equal(mp4.frames, 4);
  const moov = find(mp4.bytes, null, 'moov'),
    stbl = ['trak', 'mdia', 'minf', 'stbl'].reduce((box, type) => find(mp4.bytes, box, type), moov),
    stts = find(mp4.bytes, stbl, 'stts'),
    stss = find(mp4.bytes, stbl, 'stss'),
    rows = Array.from({ length: u32(mp4.bytes, stts.start + 4) }, (_, i) => [
      u32(mp4.bytes, stts.start + 8 + 8 * i),
      u32(mp4.bytes, stts.start + 12 + 8 * i),
    ]);
  // Time unit fps * 1000 = 10000 a second: 0.1, 0.15, 0.05 and 0.05 seconds.
  assert.deepEqual(rows, [
    [1, 1000],
    [1, 1500],
    [2, 500],
  ]);
  // A key frame once keyFrameInterval seconds have passed since the last: at 0 and 0.25 seconds.
  assert.deepEqual(
    [u32(mp4.bytes, stss.start + 4), u32(mp4.bytes, stss.start + 8), u32(mp4.bytes, stss.start + 12)],
    [2, 1, 3],
  );

  const webm = await encodeVideo(timed([0, 0.1, 0.25, 0.3], 0.2), { fps: 10, webCodecs: codecs() }),
    segment = elements(webm.bytes).find((one) => one.id === 0x18538067),
    [tracks] = inside(webm.bytes, segment, 0x1654ae6b),
    [entry] = inside(webm.bytes, tracks, 0xae),
    [info] = inside(webm.bytes, segment, 0x1549a966),
    [length] = inside(webm.bytes, info, 0x4489),
    blocks = inside(webm.bytes, segment, 0x1f43b675).flatMap((cluster) =>
      inside(webm.bytes, cluster, 0xa3).map((block) => ({ cluster, block })),
    );
  assert.equal(webm.duration, 0.5, 'the last frame lasts its own duration');
  assert.equal(new DataView(webm.bytes.buffer, webm.bytes.byteOffset + length.start).getFloat64(0), 500);
  assert.equal(inside(webm.bytes, entry, 0x23e383).length, 0, 'no DefaultDuration for frames of varying length');
  const times = blocks.map(({ cluster, block }) => {
    const time = inside(webm.bytes, cluster, 0xe7)[0],
      base = [...webm.bytes.subarray(time.start, time.end)].reduce((n, b) => n * 256 + b, 0);
    return base + new DataView(webm.bytes.buffer, webm.bytes.byteOffset + block.start + 1).getInt16(0);
  });
  assert.deepEqual(times, [0, 100, 250, 300]);

  for (const bad of [
    [{ ...frame(), timestamp: 0 }, frame()],
    [frame(), { ...frame(), timestamp: 0.1 }],
    timed([0, 0.1, 0.1]),
    timed([0, 0.2, 0.1]),
    timed([0, Number.NaN]),
    timed([0, 0.1], -1),
  ])
    await assert.rejects(encodeVideo(bad, { webCodecs: codecs() }), RangeError);
});

test('streamVideo cuts the sound into each fragment beside its frames, with its edit, roll group and track', async () => {
  const webCodecs = codecs({ audio: ['opus'], description: opusHead(312, 48_000) }),
    pieces = [];
  for await (const piece of streamVideo([frame(1), frame(2), frame(3), frame(4)], {
    codec: 'vp09.00.10.08',
    fps: 2,
    keyFrameInterval: 1,
    audio: sound(2, 48_000),
    webCodecs,
  }))
    pieces.push(piece);
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  pieces.reduce((at, piece) => (bytes.set(piece, at), at + piece.length), 0);
  const top = boxes(bytes),
    moov = top.find((one) => one.type === 'moov'),
    [, trak] = boxes(bytes, moov.start, moov.end).filter((one) => one.type === 'trak'),
    mvex = find(bytes, moov, 'mvex'),
    stbl = find(bytes, find(bytes, find(bytes, trak, 'mdia'), 'minf'), 'stbl'),
    elst = find(bytes, find(bytes, trak, 'edts'), 'elst');
  assert.equal(boxes(bytes, mvex.start, mvex.end).filter((one) => one.type === 'trex').length, 2);
  assert.ok(find(bytes, stbl, 'sgpd'), 'the roll group is described in the header');
  // Duration 0 runs the edit to the end of the fragmented media; media time is the pre-skip.
  assert.deepEqual([u32(bytes, elst.start + 8), u32(bytes, elst.start + 12)], [0, 312]);
  const moofs = top.filter((one) => one.type === 'moof');
  assert.equal(moofs.length, 2);
  let soundSamples = 0;
  for (const [n, moof] of moofs.entries()) {
    const trafs = boxes(bytes, moof.start, moof.end).filter((one) => one.type === 'traf');
    assert.equal(trafs.length, 2, 'video and sound in each fragment');
    const sound = trafs[1],
      trun = find(bytes, sound, 'trun'),
      tfdt = find(bytes, sound, 'tfdt'),
      count = u32(bytes, trun.start + 4),
      data = moof.start - 8 + u32(bytes, trun.start + 8);
    assert.equal(u32(bytes, find(bytes, sound, 'tfhd').start + 4), 2);
    assert.equal(Number(new DataView(bytes.buffer).getBigUint64(tfdt.start + 4)), n * 48_000, 'sound decode time');
    assert.ok(find(bytes, sound, 'sbgp'));
    assert.deepEqual([...bytes.subarray(data, data + 3)], [0xaa, 0xbb, 0xcc], 'sound data offset');
    soundSamples += count;
  }
  // Half-second blocks: two seconds of sound is four samples, each fragment the second its frames cover.
  assert.equal(soundSamples, 4);
});
