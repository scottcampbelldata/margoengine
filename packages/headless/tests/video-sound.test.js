import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVideo } from '../dist/video.js';

const frame = (value) => ({ width: 4, height: 2, data: new Uint8Array(32).fill(value) });

/** WebCodecs stand-in. A video chunk holds one byte; a sound chunk marks its time. */
function codecs({ supported = () => true, description, audioFail } = {}) {
  const log = { audio: [], closed: 0, configs: [] };
  class VideoFrame {
    constructor(data, init) {
      Object.assign(this, init, { first: data[0] });
    }
    close() {}
  }
  class VideoEncoder extends EventTarget {
    state = 'configured';
    encodeQueueSize = 0;
    static isConfigSupported = async () => ({ supported: true });
    constructor({ output }) {
      super();
      this.output = output;
    }
    configure() {}
    encode(picture, { keyFrame }) {
      this.output(
        {
          byteLength: 1,
          timestamp: picture.timestamp,
          duration: picture.duration,
          type: keyFrame ? 'key' : 'delta',
          copyTo: (out) => (out[0] = picture.first),
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
      log.audio.push(init);
    }
    close() {
      log.closed++;
    }
  }
  class AudioEncoder {
    state = 'configured';
    static isConfigSupported = async (config) => ({ supported: supported(config.codec) });
    constructor({ output, error }) {
      this.output = output;
      this.fail = error;
    }
    configure(config) {
      log.configs.push(config);
      this.config = config;
    }
    encode(data) {
      if (audioFail) return this.fail(new Error('encoder broke'));
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
  return { binding: { VideoEncoder, VideoFrame, AudioEncoder, AudioData }, log };
}

const sound = (seconds = 1, rate = 48_000, channels = 2) => ({
  channels: Array.from({ length: channels }, () => new Float32Array(seconds * rate).fill(0.25)),
  sampleRate: rate,
});

/** Top-level MP4 boxes, or the children of `bytes`, by type. */
function boxes(bytes, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    out = [];
  while (from + 8 <= to) {
    let size = view.getUint32(from),
      head = 8;
    const type = String.fromCharCode(...bytes.subarray(from + 4, from + 8));
    if (size === 1) {
      size = Number(view.getBigUint64(from + 8));
      head = 16;
    }
    out.push({ type, start: from + head, end: from + size });
    from += size;
  }
  return out;
}
const child = (bytes, parent, type, skip = 0) =>
  boxes(bytes, parent.start + skip, parent.end).find((one) => one.type === type);
const includes = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

test('WebM with sound: an Opus track with its header and blocks of both tracks in time order', async () => {
  const { binding, log } = codecs();
  const video = await encodeVideo([frame(1), frame(2), frame(3)], {
    format: 'webm',
    fps: 2,
    audio: sound(),
    webCodecs: binding,
  });
  const { bytes } = video;
  assert.equal(video.audioCodec, 'opus');
  assert.ok(includes(bytes, 'A_OPUS'));
  assert.ok(includes(bytes, 'OpusHead'));
  // SimpleBlocks: id A3, a one-byte size here, then the track number with its marker bit, time and flags.
  const order = [];
  for (let i = 0; i + 6 < bytes.length; i++)
    if (
      bytes[i] === 0xa3 &&
      (bytes[i + 2] === 0x81 || bytes[i + 2] === 0x82) &&
      bytes[i + 1] >= 0x85 &&
      bytes[i + 1] <= 0x87
    )
      order.push(bytes[i + 2] === 0x81 ? 'v' : 'a');
  // Sound blocks of half a second each at 0 and 0.5 s; frames at 0, 0.5 and 1 s. A frame goes first at a tie.
  assert.deepEqual(order, ['v', 'a', 'v', 'a', 'v']);
  assert.equal(log.configs[0].codec, 'opus');
  assert.equal(log.configs[0].bitrate, 128_000);
  assert.equal(log.closed, log.audio.length);
});

test('the sound goes to the encoder as planes of half a second, stamped by its samples', async () => {
  const { binding, log } = codecs();
  const audio = sound(1.25, 48_000, 2);
  audio.channels[1].fill(0.75);
  await encodeVideo([frame(1)], { fps: 2, audio, webCodecs: binding });
  assert.deepEqual(
    log.audio.map((one) => [one.timestamp, one.numberOfFrames]),
    [
      [0, 24_000],
      [500_000, 24_000],
      [1_000_000, 12_000],
    ],
  );
  assert.equal(log.audio[2].data[0], 0.25);
  assert.equal(log.audio[2].data[12_000], 0.75);
  assert.equal(log.audio[0].format, 'f32-planar');
});

test('sound longer than the video gets clusters of its own and sets the duration', async () => {
  const { binding } = codecs();
  const { bytes } = await encodeVideo([frame(1)], { fps: 2, audio: sound(2), webCodecs: binding });
  let sound2 = 0;
  for (let i = 0; i + 6 < bytes.length; i++) if (bytes[i] === 0xa3 && bytes[i + 2] === 0x82) sound2++;
  assert.equal(sound2, 4);
  const at = Buffer.from(bytes).indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getFloat64(at + 3), 2000);
});

test('an encoder OpusHead is kept, and its pre-skip becomes the codec delay', async () => {
  const head = new Uint8Array(19);
  head.set(Buffer.from('OpusHead'));
  head[8] = 1;
  head[9] = 2;
  head[10] = 0x38; // 312 samples, little-endian
  head[11] = 0x01;
  const { binding } = codecs({ description: head });
  const { bytes } = await encodeVideo([frame(1)], { fps: 2, audio: sound(), webCodecs: binding });
  const at = Buffer.from(bytes).indexOf(Buffer.from([0x56, 0xaa]));
  const size = bytes[at + 2] & 0x7f;
  let delay = 0;
  for (let i = 0; i < size; i++) delay = delay * 256 + bytes[at + 3 + i];
  assert.equal(delay, Math.round((312 * 1e9) / 48_000));
});

test('MP4 with sound, AAC: a second track whose offset lands on its samples', async () => {
  const config = Uint8Array.of(0x11, 0x90);
  const { binding, log } = codecs({ description: config });
  const video = await encodeVideo([frame(1), frame(2)], {
    format: 'mp4',
    codec: 'vp09.00.10.08',
    fps: 2,
    audio: sound(1),
    webCodecs: binding,
  });
  const { bytes } = video;
  assert.equal(video.audioCodec, 'aac');
  assert.equal(log.configs[0].codec, 'mp4a.40.2');
  const top = boxes(bytes),
    moov = top.find((one) => one.type === 'moov'),
    mdat = top.find((one) => one.type === 'mdat'),
    tracks = boxes(bytes, moov.start, moov.end).filter((one) => one.type === 'trak');
  assert.equal(tracks.length, 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    mvhd = child(bytes, moov, 'mvhd');
  assert.equal(view.getUint32(mvhd.end - 4), 3, 'next track id');
  const mdia = child(bytes, tracks[1], 'mdia'),
    mdhd = child(bytes, mdia, 'mdhd'),
    minf = child(bytes, mdia, 'minf'),
    stbl = child(bytes, minf, 'stbl');
  assert.equal(view.getUint32(mdhd.start + 12), 48_000);
  assert.equal(view.getUint32(mdhd.start + 16), 48_000, 'one second in samples');
  assert.ok(includes(bytes.subarray(child(bytes, mdia, 'hdlr').start, child(bytes, mdia, 'hdlr').end), 'soun'));
  assert.ok(child(bytes, minf, 'smhd'));
  const stsd = child(bytes, stbl, 'stsd'),
    entry = boxes(bytes, stsd.start + 8, stsd.end)[0];
  assert.equal(entry.type, 'mp4a');
  assert.equal(view.getUint16(entry.start + 16), 2, 'channels');
  assert.equal(view.getUint32(entry.start + 24), 48_000 * 0x10000, 'rate');
  const esds = boxes(bytes, entry.start + 28, entry.end)[0];
  assert.equal(esds.type, 'esds');
  assert.ok(
    Buffer.from(bytes.subarray(esds.start, esds.end)).includes(Buffer.from([5, 2, 0x11, 0x90])),
    'AudioSpecificConfig',
  );
  const co64 = child(bytes, stbl, 'co64'),
    offset = Number(view.getBigUint64(co64.start + 8));
  assert.equal(offset, mdat.start + 2, 'after the two one-byte frames');
  assert.deepEqual([...bytes.subarray(offset, offset + 3)], [0xaa, 0xbb, 0xcc]);
  assert.equal(mdat.end, bytes.length);
  // Two chunks of 24,000 samples: one run in the time table.
  const stts = child(bytes, stbl, 'stts');
  assert.deepEqual(
    [view.getUint32(stts.start + 4), view.getUint32(stts.start + 8), view.getUint32(stts.start + 12)],
    [1, 2, 24_000],
  );
});

/**
 * An AAC stand-in that, as real AAC encoders do, puts `lead` silent samples before the sound and says nothing of them:
 * chunks of 1024 samples of channel 0 as float bytes, stamped from 0. Its decoder reads the floats back.
 */
function leadingCodecs(lead) {
  const { binding } = codecs();
  class AudioEncoder {
    state = 'configured';
    static isConfigSupported = async () => ({ supported: true });
    constructor({ output }) {
      this.output = output;
    }
    configure(config) {
      this.config = config;
      this.heard = [...new Float32Array(lead)];
    }
    encode(data) {
      this.heard.push(...data.data.subarray(0, data.numberOfFrames));
    }
    async flush() {
      const { sampleRate } = this.config;
      for (let at = 0; at < this.heard.length; at += 1024) {
        const floats = Float32Array.from({ length: 1024 }, (_, i) => this.heard[at + i] ?? 0);
        this.output(
          {
            byteLength: floats.byteLength,
            timestamp: Math.round((at * 1e6) / sampleRate),
            duration: Math.round((1024 * 1e6) / sampleRate),
            floats,
            copyTo: (out) => out.set(new Uint8Array(floats.buffer)),
          },
          at
            ? undefined
            : {
                decoderConfig: {
                  codec: 'mp4a.40.2',
                  sampleRate,
                  numberOfChannels: 1,
                  description: Uint8Array.of(0x11, 0x88),
                },
              },
        );
      }
      this.heard = [];
    }
    close() {
      this.state = 'closed';
    }
  }
  class AudioDecoder {
    state = 'configured';
    constructor({ output }) {
      this.output = output;
    }
    configure() {}
    decode(chunk) {
      this.output({ numberOfFrames: chunk.floats.length, copyTo: (out) => out.set(chunk.floats), close() {} });
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  return { ...binding, AudioEncoder, AudioDecoder };
}

/** The sound track's edit list as `{ segment, mediaTime }`, or undefined when it has none. */
function soundEdit(bytes) {
  const moov = boxes(bytes).find((one) => one.type === 'moov'),
    sound = boxes(bytes, moov.start, moov.end).filter((one) => one.type === 'trak')[1],
    edts = child(bytes, sound, 'edts');
  if (!edts) return undefined;
  const elst = child(bytes, edts, 'elst'),
    view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(elst.start + 4), 1, 'one edit');
  return {
    segment: view.getUint32(elst.start + 8),
    mediaTime: view.getInt32(elst.start + 12),
    rate: view.getUint16(elst.start + 16),
  };
}

test('MP4 with AAC: the encoder lead-in is measured and cut by an edit list, so the sound starts on time', async () => {
  for (const lead of [2112, 1024, 0]) {
    const video = await encodeVideo([frame(1), frame(2)], {
      format: 'mp4',
      codec: 'vp09.00.10.08',
      fps: 2,
      audio: { channels: [Float32Array.from({ length: 48_000 }, (_, i) => Math.sin(i / 7))], sampleRate: 48_000 },
      webCodecs: leadingCodecs(lead),
    });
    assert.equal(video.audioCodec, 'aac');
    const edit = soundEdit(video.bytes);
    if (!lead) {
      assert.equal(edit, undefined, 'no lead-in, no edit list');
      continue;
    }
    // 48,000 + lead samples in chunks of 1024; the edit starts after the lead and runs to the end, in milliseconds.
    const end = Math.ceil((48_000 + lead) / 1024) * 1024;
    assert.deepEqual(
      edit,
      { segment: Math.round(((end - lead) / 48_000) * 1000), mediaTime: lead, rate: 1 },
      `lead ${lead}`,
    );
  }
});

test('MP4 with AAC and no AudioDecoder has no edit list, as before', async () => {
  const { AudioDecoder, ...binding } = leadingCodecs(2112);
  assert.ok(AudioDecoder);
  const video = await encodeVideo([frame(1)], {
    format: 'mp4',
    codec: 'vp09.00.10.08',
    fps: 2,
    audio: sound(1, 48_000, 1),
    webCodecs: binding,
  });
  assert.equal(soundEdit(video.bytes), undefined);
});

test('MP4 falls back to Opus with a dOps box when AAC is missing', async () => {
  const { binding } = codecs({ supported: (codec) => codec === 'opus' });
  const video = await encodeVideo([frame(1)], {
    format: 'mp4',
    codec: 'vp09.00.10.08',
    fps: 2,
    audio: sound(1, 48_000, 1),
    webCodecs: binding,
  });
  assert.equal(video.audioCodec, 'opus');
  assert.ok(includes(video.bytes, 'dOps'));
});

test('a file without the option has no sound track', async () => {
  const { binding, log } = codecs();
  const video = await encodeVideo([frame(1)], { format: 'webm', fps: 2, webCodecs: binding });
  assert.equal(video.audioCodec, undefined);
  assert.equal(includes(video.bytes, 'A_OPUS'), false);
  assert.equal(log.audio.length, 0);
});

test('bad sound is refused, a missing encoder names itself, and an encoder failure rejects', async () => {
  const { binding } = codecs();
  const run = (audio, webCodecs = binding) => encodeVideo([frame(1)], { fps: 2, audio, webCodecs });
  await assert.rejects(run({ channels: [], sampleRate: 48_000 }), /one or two channels/);
  await assert.rejects(run({ channels: [new Float32Array(4), new Float32Array(5)], sampleRate: 48_000 }), /one length/);
  await assert.rejects(run({ channels: [new Float32Array(4)], sampleRate: 0 }), /sampleRate/);
  await assert.rejects(run({ ...sound(), bitrate: -1 }), /bitrate/);
  await assert.rejects(
    run(sound(), { VideoEncoder: binding.VideoEncoder, VideoFrame: binding.VideoFrame }),
    /needs AudioEncoder/,
  );
  await assert.rejects(run(sound(), codecs({ supported: () => false }).binding), /No audio codec/);
  await assert.rejects(run(sound(), codecs({ audioFail: true }).binding), /encoder broke/);
});
