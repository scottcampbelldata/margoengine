// Containers for encoded video, written from the Matroska element list (RFC 9559), the WebM guidelines and ISO/IEC
// 14496-12 and 14496-15. Each file is built whole in memory, so every size and position is known and nothing is
// patched afterwards. The VP9 and AV1 configuration records follow their codecs' published ISOBMFF bindings; the colour
// code points are those of ISO/IEC 23091-2.

/** One encoded frame in decode order. Times are microseconds. */
export interface VideoSample {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  key: boolean;
}

/** What a container records about the stream. */
export interface VideoTrack {
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** The encoder's codec configuration, when it gives one. */
  description?: Uint8Array;
  colorSpace?: VideoColorSpaceInit;
}

/** An encoded sound stream beside the video. Sample times are microseconds. */
export interface SoundTrack {
  /** `'opus'`, or `'aac'` in MP4 only. */
  codec: 'opus' | 'aac';
  sampleRate: number;
  channels: number;
  /** The encoder's configuration: `OpusHead` for Opus when it gives one, the AudioSpecificConfig for AAC. */
  description?: Uint8Array;
  samples: readonly VideoSample[];
  /** Samples the encoder put before the sound, which an MP4 edit list cuts. AAC only: Opus states its own pre-skip. */
  leadIn?: number;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
/** `value` big-endian in `length` bytes. Division, not shifts: positions can pass 32 bits. */
const bigEndian = (value: number, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
};
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const PRIMARIES: Readonly<Record<string, number>> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 },
  TRANSFER: Readonly<Record<string, number>> = {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    'iec61966-2-1': 13,
    pq: 16,
    hlg: 18,
  },
  MATRIX: Readonly<Record<string, number>> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 },
  UNSPECIFIED = 2;

/** The colour code points of a stream. Fields the encoder left out stay "unspecified". */
function colourCodes(colorSpace: VideoColorSpaceInit | undefined) {
  return {
    primaries: PRIMARIES[colorSpace?.primaries ?? ''] ?? UNSPECIFIED,
    transfer: TRANSFER[colorSpace?.transfer ?? ''] ?? UNSPECIFIED,
    matrix: MATRIX[colorSpace?.matrix ?? ''] ?? UNSPECIFIED,
    fullRange: colorSpace?.fullRange ?? false,
  };
}

/** AV1CodecConfigurationRecord: the encoder's, or the four fixed bytes read from an `av01.P.LLT.DD` codec string. */
function av1Configuration({ codec, description }: VideoTrack): Uint8Array {
  if (description?.length) return description;
  const [, profile, level, tier, depth] = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(codec) ?? [, 0, 0, 'M', 8],
    bits = Number(depth);
  return Uint8Array.of(
    0x81,
    (Number(profile) << 5) | Number(level),
    (tier === 'H' ? 0x80 : 0) | (bits > 8 ? 0x40 : 0) | (bits > 10 ? 0x20 : 0) | 0x0c, // 0x0c: 4:2:0
    0,
  );
}

/** Samples Opus decoders drop at the start: from the encoder's `OpusHead` (little-endian at byte 10), else 0. */
function opusPreSkip({ description }: SoundTrack): number {
  const head = description;
  if (!head || head.length < 12 || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') return 0;
  return head[10] | (head[11] << 8);
}

/** The `OpusHead` a WebM track holds (RFC 7845): the encoder's, or a plain one for one or two channels. */
function opusHead(sound: SoundTrack): Uint8Array {
  if (opusPreSkip(sound) || sound.description?.length) return sound.description!;
  const head = new Uint8Array(19);
  head.set(text('OpusHead'));
  const view = new DataView(head.buffer);
  head[8] = 1;
  head[9] = sound.channels;
  view.setUint32(12, sound.sampleRate, true);
  return head;
}

// Matroska

const elementId = (id: number): Uint8Array => bigEndian(id, id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1);
/** The shortest EBML size field for `size`. All ones means "unknown", so the top value of each length is skipped. */
function sizeField(size: number): Uint8Array {
  let length = 1;
  while (size >= 2 ** (7 * length) - 1) length++;
  const out = bigEndian(size, length);
  out[0] |= 1 << (8 - length);
  return out;
}
const element = (id: number, ...payload: Uint8Array[]): Uint8Array => {
  const body = concat(payload);
  return concat([elementId(id), sizeField(body.length), body]);
};
const unsigned = (id: number, value: number, length = Math.max(1, Math.ceil(Math.log2(value + 1) / 8))): Uint8Array =>
  element(id, bigEndian(value, length));
const float = (id: number, value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(id, bytes);
};

const EBML = 0x1a45dfa3,
  SEGMENT = 0x18538067,
  SEEK_HEAD = 0x114d9b74,
  INFO = 0x1549a966,
  TRACKS = 0x1654ae6b,
  CLUSTER = 0x1f43b675,
  CUES = 0x1c53bb6b,
  WEBM_CODECS: Readonly<Record<string, string>> = { vp8: 'V_VP8', vp09: 'V_VP9', av01: 'V_AV1' },
  MOST_BLOCK_OFFSET = 30_000; // A block's time is a signed 16-bit offset from its cluster, in milliseconds.

/** A WebM file: header, one cluster per key frame, then cues for seeking. Timestamps are whole milliseconds. */
export function muxWebM(track: VideoTrack, samples: readonly VideoSample[], sound?: SoundTrack): Uint8Array {
  const family = track.codec.split('.')[0],
    colour = colourCodes(track.colorSpace),
    ms = (time: number) => Math.round(time / 1000),
    end = [...samples, ...(sound?.samples ?? [])].reduce(
      (most, sample) => Math.max(most, sample.timestamp + sample.duration),
      0,
    ),
    info = element(
      INFO,
      unsigned(0x2ad7b1, 1_000_000),
      float(0x4489, end / 1000),
      element(0x4d80, text('Margo Engine')),
      element(0x5741, text('Margo Engine')),
    ),
    tracks = element(
      TRACKS,
      element(
        0xae,
        unsigned(0xd7, 1),
        unsigned(0x73c5, 1),
        unsigned(0x83, 1),
        unsigned(0x9c, 0),
        unsigned(0x23e383, Math.round(1e9 / track.fps)),
        element(0x86, text(WEBM_CODECS[family])),
        ...(family === 'av01' ? [element(0x63a2, av1Configuration(track))] : []),
        element(
          0xe0,
          unsigned(0xb0, track.width),
          unsigned(0xba, track.height),
          element(
            0x55b0,
            unsigned(0x55b1, colour.matrix),
            unsigned(0x55b9, colour.fullRange ? 2 : 1),
            unsigned(0x55ba, colour.transfer),
            unsigned(0x55bb, colour.primaries),
          ),
        ),
      ),
      ...(sound
        ? [
            element(
              0xae,
              unsigned(0xd7, 2),
              unsigned(0x73c5, 2),
              unsigned(0x83, 2),
              unsigned(0x9c, 0),
              element(0x86, text('A_OPUS')),
              element(0x63a2, opusHead(sound)),
              // Nanoseconds: what decoders drop at the start, and how far back a seek must begin (80 ms, RFC 7845).
              unsigned(0x56aa, Math.round((opusPreSkip(sound) * 1e9) / 48_000)),
              unsigned(0x56bb, 80_000_000),
              element(0xe1, float(0xb5, sound.sampleRate), unsigned(0x9f, sound.channels)),
            ),
          ]
        : []),
    ),
    groups: { time: number; key: boolean; blocks: Uint8Array[] }[] = [],
    block = (group: { time: number; blocks: Uint8Array[] }, number: number, time: number, sample: VideoSample) => {
      const head = new Uint8Array(4);
      head[0] = 0x80 | number;
      new DataView(head.buffer).setInt16(1, time - group.time);
      head[3] = sample.key ? 0x80 : 0;
      group.blocks.push(element(0xa3, head, sample.data));
    };
  // Sound goes in between the frames in time order; a stretch of sound past the last frame gets clusters of its own.
  const sounds = sound?.samples ?? [];
  let heard = 0;
  const hear = (until: number) => {
    for (; heard < sounds.length && ms(sounds[heard].timestamp) < until; heard++) {
      const time = ms(sounds[heard].timestamp);
      let group = groups.at(-1);
      if (!group || time - group.time > MOST_BLOCK_OFFSET) groups.push((group = { time, key: false, blocks: [] }));
      block(group, 2, time, sounds[heard]);
    }
  };
  for (const sample of samples) {
    const time = ms(sample.timestamp);
    hear(time);
    let group = groups.at(-1);
    if (!group || sample.key || time - group.time > MOST_BLOCK_OFFSET)
      groups.push((group = { time, key: sample.key, blocks: [] }));
    block(group, 1, time, sample);
  }
  hear(Number.POSITIVE_INFINITY);
  const clusters = groups.map(({ time, blocks }) => element(CLUSTER, unsigned(0xe7, time), ...blocks)),
    // Positions are 8 bytes wide so the seek head has one size whatever it points at.
    seekHead = (info: number, tracks: number, cues: number) =>
      element(
        SEEK_HEAD,
        ...[
          [INFO, info],
          [TRACKS, tracks],
          [CUES, cues],
        ].map(([id, at]) => element(0x4dbb, element(0x53ab, elementId(id)), unsigned(0x53ac, at, 8))),
      ),
    start = seekHead(0, 0, 0).length,
    points: Uint8Array[] = [];
  let at = start + info.length + tracks.length;
  groups.forEach((group, i) => {
    if (group.key)
      points.push(element(0xbb, unsigned(0xb3, group.time), element(0xb7, unsigned(0xf7, 1), unsigned(0xf1, at))));
    at += clusters[i].length;
  });
  const segment = [seekHead(start, start + info.length, at), info, tracks, ...clusters, element(CUES, ...points)],
    size = bigEndian(
      segment.reduce((sum, part) => sum + part.length, 0),
      8,
    );
  size[0] = 1; // The 8-byte size marker; a file is far below 2^56 bytes.
  return concat([
    element(
      EBML,
      unsigned(0x4286, 1),
      unsigned(0x42f7, 1),
      unsigned(0x42f2, 4),
      unsigned(0x42f3, 8),
      element(0x4282, text('webm')),
      unsigned(0x4287, 4),
      unsigned(0x4285, 2),
    ),
    elementId(SEGMENT),
    size,
    ...segment,
  ]);
}

// ISO base media

const u16 = (value: number) => bigEndian(value, 2),
  u32 = (value: number) => bigEndian(value, 4),
  u64 = (value: number) => bigEndian(value, 8),
  i32 = (value: number) => u32(value < 0 ? value + 2 ** 32 : value),
  box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
    const body = concat(payload);
    return concat([u32(body.length + 8), text(type), body]);
  },
  fullBox = (type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array =>
    box(type, Uint8Array.of(version), bigEndian(flags, 3), ...payload),
  UNITY_MATRIX = concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));

/** The sample entry for the track's codec, with its configuration record and colour box. */
function sampleEntry(track: VideoTrack): Uint8Array {
  const family = track.codec.split('.')[0],
    colour = colourCodes(track.colorSpace),
    head = [
      new Uint8Array(6),
      u16(1), // data_reference_index
      new Uint8Array(16),
      u16(track.width),
      u16(track.height),
      u32(0x480000), // 72 dpi, as the format fixes it
      u32(0x480000),
      u32(0),
      u16(1), // frame_count
      new Uint8Array(32),
      u16(0x18),
      u16(0xffff),
    ],
    colr = box(
      'colr',
      text('nclx'),
      u16(colour.primaries),
      u16(colour.transfer),
      u16(colour.matrix),
      Uint8Array.of(colour.fullRange ? 0x80 : 0),
    );
  if (family === 'avc1') return box('avc1', ...head, box('avcC', track.description!), colr);
  if (family === 'av01') return box('av01', ...head, box('av1C', av1Configuration(track)), colr);
  const [, profile, level, depth] = track.codec.split('.').map(Number);
  return box(
    'vp09',
    ...head,
    fullBox(
      'vpcC',
      1,
      0,
      Uint8Array.of(
        profile,
        level,
        (depth << 4) | (1 << 1) | (colour.fullRange ? 1 : 0), // Chroma 1: 4:2:0, colocated with luma
        colour.primaries,
        colour.transfer,
        colour.matrix,
      ),
      u16(0),
    ),
    colr,
  );
}

/** Runs of equal values as `[count, value]`, the form `stts` and `ctts` store. */
function runs(values: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const value of values) {
    const last = out.at(-1);
    if (last?.[1] === value) last[0]++;
    else out.push([1, value]);
  }
  return out;
}

/** The sample entry of a sound: `Opus` with `dOps` (Encapsulation of Opus in ISOBMFF), or `mp4a` with `esds`. */
function soundEntry(sound: SoundTrack): Uint8Array {
  const head = [
    new Uint8Array(6),
    u16(1), // data_reference_index
    new Uint8Array(8),
    u16(sound.channels),
    u16(16),
    u32(0),
    u32(sound.sampleRate * 0x10000),
  ];
  if (sound.codec === 'opus')
    return box(
      'Opus',
      ...head,
      box(
        'dOps',
        Uint8Array.of(0, sound.channels),
        u16(opusPreSkip(sound)),
        u32(sound.sampleRate),
        u16(0),
        Uint8Array.of(0),
      ),
    );
  // ISO/IEC 14496-1 descriptors; every length here fits one byte.
  const descriptor = (tag: number, ...payload: Uint8Array[]) => {
      const body = concat(payload);
      return concat([Uint8Array.of(tag, body.length), body]);
    },
    config = descriptor(
      4,
      Uint8Array.of(0x40, 0x15), // MPEG-4 audio; an audio stream
      new Uint8Array(3),
      u32(0),
      u32(0),
      descriptor(5, sound.description!),
    );
  return box(
    'mp4a',
    ...head,
    fullBox('esds', 0, 0, descriptor(3, u16(2), Uint8Array.of(0), config, descriptor(6, Uint8Array.of(2)))),
  );
}

/** The `trak` of a sound. Its time unit is one sample. */
function soundTrak(sound: SoundTrack, position: number, milliseconds: number): Uint8Array {
  const { samples, sampleRate, leadIn = 0 } = sound,
    ticks = (time: number) => Math.round((time * sampleRate) / 1e6),
    last = samples.at(-1)!,
    end = ticks(last.timestamp + last.duration),
    durations = samples.map(
      (sample, i) => (samples[i + 1] ? ticks(samples[i + 1].timestamp) : end) - ticks(sample.timestamp),
    );
  const rows = runs(durations);
  return box(
    'trak',
    fullBox(
      'tkhd',
      0,
      3, // Enabled, in the movie
      u32(0),
      u32(0),
      u32(2),
      u32(0),
      u32(milliseconds),
      new Uint8Array(12),
      u16(0x100), // Full volume
      u16(0),
      UNITY_MATRIX,
      u32(0),
      u32(0),
    ),
    // ISO/IEC 14496-12 edit list: the presentation starts `leadIn` samples into the media, so the sound plays on time.
    ...(leadIn
      ? [
          box(
            'edts',
            fullBox(
              'elst',
              0,
              0,
              u32(1),
              u32(Math.round(((end - leadIn) / sampleRate) * 1000)),
              u32(leadIn),
              u16(1),
              u16(0),
            ),
          ),
        ]
      : []),
    box(
      'mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(end), u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), text('soun'), new Uint8Array(12), text('Margo Engine\0')),
      box(
        'minf',
        fullBox('smhd', 0, 0, u32(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        box(
          'stbl',
          fullBox('stsd', 0, 0, u32(1), soundEntry(sound)),
          fullBox('stts', 0, 0, u32(rows.length), ...rows.flatMap(([count, value]) => [u32(count), u32(value)])),
          fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
          fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.data.length))),
          fullBox('co64', 0, 0, u32(1), u64(position)),
        ),
      ),
    ),
  );
}

/** A progressive MP4: `moov` first so playback can start before the end arrives, each track's samples in one chunk. */
export function muxMP4(track: VideoTrack, samples: readonly VideoSample[], sound?: SoundTrack): Uint8Array {
  const family = track.codec.split('.')[0],
    timescale = Math.round(track.fps * 1000),
    ticks = (time: number) => Math.round((time * timescale) / 1e6),
    shown = samples.map((sample) => ticks(sample.timestamp)),
    // Decode times are the presentation times in order, so the first is 0 and no edit list is needed.
    decoded = [...shown].sort((a, b) => a - b),
    end = samples.reduce((most, sample) => Math.max(most, ticks(sample.timestamp + sample.duration)), 0),
    durations = decoded.map((time, i) => (decoded[i + 1] ?? end) - time),
    offsets = shown.map((time, i) => time - decoded[i]),
    heard = sound?.samples.at(-1),
    milliseconds = Math.max(
      Math.round((end / timescale) * 1000),
      heard ? Math.round((heard.timestamp + heard.duration) / 1000) : 0,
    ),
    keys = samples.flatMap((sample, i) => (sample.key ? [i + 1] : [])),
    timeToSample = runs(durations),
    offsetRuns = runs(offsets),
    ftyp = box(
      'ftyp',
      text('isom'),
      u32(512),
      text('isom'),
      text('iso2'),
      text('iso6'),
      text('mp41'),
      ...(family === 'avc1' ? [text('avc1')] : []),
    ),
    table = (type: string, version: number, rows: readonly [number, number][]) =>
      fullBox(type, version, 0, u32(rows.length), ...rows.flatMap(([count, value]) => [u32(count), i32(value)])),
    moov = (position: number) =>
      box(
        'moov',
        fullBox(
          'mvhd',
          0,
          0,
          u32(0),
          u32(0),
          u32(1000),
          u32(milliseconds),
          u32(0x10000),
          u16(0x100),
          new Uint8Array(10),
          UNITY_MATRIX,
          new Uint8Array(24),
          u32(sound ? 3 : 2),
        ),
        box(
          'trak',
          fullBox(
            'tkhd',
            0,
            3, // Enabled, in the movie
            u32(0),
            u32(0),
            u32(1),
            u32(0),
            u32(milliseconds),
            new Uint8Array(16),
            UNITY_MATRIX,
            u32(track.width * 0x10000),
            u32(track.height * 0x10000),
          ),
          box(
            'mdia',
            fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(end), u16(0x55c4), u16(0)),
            fullBox('hdlr', 0, 0, u32(0), text('vide'), new Uint8Array(12), text('Margo Engine\0')),
            box(
              'minf',
              fullBox('vmhd', 0, 1, new Uint8Array(8)),
              box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
              box(
                'stbl',
                fullBox('stsd', 0, 0, u32(1), sampleEntry(track)),
                table('stts', 0, timeToSample),
                ...(offsets.some(Boolean) ? [table('ctts', 1, offsetRuns)] : []), // Version 1: signed offsets
                fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32)),
                fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
                fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.data.length))),
                fullBox('co64', 0, 0, u32(1), u64(position)),
              ),
            ),
          ),
        ),
        ...(sound ? [soundTrak(sound, position + bytes, milliseconds)] : []),
      ),
    bytes = samples.reduce((sum, sample) => sum + sample.data.length, 0),
    soundBytes = (sound?.samples ?? []).reduce((sum, sample) => sum + sample.data.length, 0),
    // The 64-bit `mdat` header and `co64` keep one path for every size; the position never changes moov's size.
    header = concat([u32(1), text('mdat'), u64(bytes + soundBytes + 16)]),
    position = ftyp.length + moov(0).length + header.length;
  return concat([
    ftyp,
    moov(position),
    header,
    ...samples.map((sample) => sample.data),
    ...(sound?.samples ?? []).map((sample) => sample.data),
  ]);
}
