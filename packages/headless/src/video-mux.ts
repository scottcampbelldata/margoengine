// Containers for encoded video, written from the Matroska element list (RFC 9559), the WebM guidelines and ISO/IEC
// 14496-12 and 14496-15. Each file, or each piece of a streamed one, is built whole in memory, so every size and
// position in it is known and nothing is patched afterwards. The VP9 and AV1 configuration records follow their codecs'
// published ISOBMFF bindings; the colour code points are those of ISO/IEC 23091-2.

import { avcConfigurationWithRange, avcSampleWithRange } from './avc-range.js';

/** One encoded frame in decode order. Times are microseconds. */
export interface VideoSample {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  key: boolean;
  /** The alpha plane coded as a frame of the same codec, which WebM carries beside the colour (BlockAddID 1). */
  alpha?: Uint8Array;
}

/** What a container records about the stream. */
export interface VideoTrack {
  /** JSON provenance carried by the containing file. Default none. */
  provenance?: Readonly<Record<string, unknown>>;
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** The encoder's codec configuration, when it gives one. */
  description?: Uint8Array;
  colorSpace?: VideoColorSpaceInit;
  /** Frames have their own times, not 1 / fps apart: WebM then states no DefaultDuration. Default false. */
  variable?: boolean;
  /** Frames carry `alpha` (WebM with VP8 or VP9 only). Default false. */
  alpha?: boolean;
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

/** The OBUs of an AV1 temporal unit as `[type, start, end]`, or undefined when the unit cannot be walked (AV1 5.3). */
function obus(data: Uint8Array): [number, number, number][] | undefined {
  const out: [number, number, number][] = [];
  let at = 0;
  while (at < data.length) {
    const header = data[at],
      start = at;
    at += header & 4 ? 2 : 1;
    let size = data.length - at;
    if (header & 2) {
      size = 0;
      for (let i = 0; ; i++) {
        if (i === 8 || at >= data.length) return undefined;
        const byte = data[at++];
        size += (byte & 0x7f) * 2 ** (7 * i);
        if (!(byte & 0x80)) break;
      }
    }
    if (header & 0x80 || at + size > data.length) return undefined;
    out.push([(header >> 3) & 15, start, (at += size)]);
  }
  return out;
}

/**
 * The four fixed bytes of an AV1CodecConfigurationRecord read from a sequence header OBU's payload (AV1 5.5.1 to 5.5.2,
 * the binding's 2.3.3: every field equals the sequence header's), or undefined when it ends early.
 */
function av1RecordOfSequenceHeader(payload: Uint8Array): Uint8Array | undefined {
  let at = 0;
  // Reading past the end yields zero bits; the record is refused once the fields are read.
  const total = payload.length * 8,
    bits = (n: number): number => {
      let value = 0;
      for (let i = 0; i < n; i++, at++) value = value * 2 + (at < total ? (payload[at >> 3] >> (7 - (at & 7))) & 1 : 0);
      return value;
    },
    uvlc = (): void => {
      let zeros = 0;
      while (!bits(1)) if (++zeros >= 32) return;
      bits(zeros);
    };
  const profile = bits(3);
  bits(1); // still_picture
  const reduced = bits(1);
  let level = 0,
    tier = 0,
    orderHint = 0;
  if (reduced) level = bits(5);
  else {
    let decoderModel = 0,
      delayLength = 0;
    if (bits(1)) {
      bits(64); // num_units_in_display_tick, time_scale
      if (bits(1)) uvlc(); // equal_picture_interval, num_ticks_per_picture_minus_1
      decoderModel = bits(1);
      if (decoderModel) {
        delayLength = bits(5) + 1;
        bits(42); // num_units_in_decoding_tick, buffer_removal_time_length_minus_1, frame_presentation_time_length_minus_1
      }
    }
    const displayDelay = bits(1),
      points = bits(5) + 1;
    for (let i = 0; i < points; i++) {
      bits(12); // operating_point_idc
      const pointLevel = bits(5),
        pointTier = pointLevel > 7 ? bits(1) : 0;
      if (i === 0) [level, tier] = [pointLevel, pointTier];
      if (decoderModel && bits(1)) bits(2 * delayLength + 1);
      if (displayDelay && bits(1)) bits(4);
    }
  }
  const widthBits = bits(4) + 1,
    heightBits = bits(4) + 1;
  bits(widthBits + heightBits);
  if (!reduced && bits(1)) bits(7); // frame id lengths
  bits(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reduced) {
    bits(4); // interintra, masked compound, warped motion, dual filter
    orderHint = bits(1);
    if (orderHint) bits(2);
    const screen = bits(1) ? 2 : bits(1);
    if (screen > 0 && !bits(1)) bits(1); // seq_choose_integer_mv, seq_force_integer_mv
    if (orderHint) bits(3);
  }
  bits(3); // superres, cdef, restoration
  const high = bits(1),
    twelve = profile === 2 && high ? bits(1) : 0,
    mono = profile === 1 ? 0 : bits(1);
  let primaries = 2,
    transfer = 2,
    matrix = 2;
  if (bits(1)) [primaries, transfer, matrix] = [bits(8), bits(8), bits(8)];
  let x = 1,
    y = 1,
    position = 0;
  if (!mono) {
    if (primaries === 1 && transfer === 13 && matrix === 0) [x, y] = [0, 0];
    else {
      bits(1); // color_range
      if (profile === 1) [x, y] = [0, 0];
      else if (profile === 2) {
        if (twelve) {
          x = bits(1);
          y = x ? bits(1) : 0;
        } else [x, y] = [1, 0];
      }
      if (x && y) position = bits(2);
    }
  }
  if (at > total) return undefined;
  return Uint8Array.of(
    0x81,
    (profile << 5) | level,
    (tier << 7) | (high << 6) | (twelve << 5) | (mono << 4) | (x << 3) | (y << 2) | position,
    0,
  );
}

/**
 * The AV1CodecConfigurationRecord: the encoder's; else read from the first sample's sequence header, which then follows
 * as its config OBU (AV1 ISOBMFF binding 2.3.3; the Matroska AV1 mapping's CodecPrivate); else the four fixed bytes of
 * an `av01.P.LLT.DD` codec string. WebCodecs gives no AV1 description, and the string can name another level than the
 * encoder chose.
 */
function av1Configuration({ codec, description }: VideoTrack, first?: Uint8Array): Uint8Array {
  if (description?.length) return description;
  const header = first && obus(first)?.find(([type]) => type === 1);
  if (first && header) {
    const [, start, end] = header,
      offset = first[start] & 4 ? 2 : 1;
    let at = start + offset;
    if (first[start] & 2) while (first[at++] & 0x80);
    const fixed = av1RecordOfSequenceHeader(first.subarray(at, end));
    if (fixed) return concat([fixed, first.subarray(start, end)]);
  }
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

/** The input sample rate an `OpusHead` states (little-endian at byte 12), else the track's. */
function opusInputRate(sound: SoundTrack): number {
  const head = sound.description;
  if (!head || head.length < 16 || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') return sound.sampleRate;
  return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12, true);
}

/**
 * An AV1 temporal unit without its temporal delimiter and padding OBUs, which the AV1 ISOBMFF binding (2.4) and the
 * Matroska AV1 mapping both say SHOULD NOT be stored: a WebCodecs chunk may start with a delimiter (WebCodecs AV1
 * registration, section 2). OBU headers per AV1 5.3.1 to 5.3.3; sizes are leb128 (4.10.5). A unit that cannot be walked
 * is kept as it is.
 */
export function av1StoredUnit(data: Uint8Array): Uint8Array {
  const units = obus(data);
  if (!units?.some(([type]) => type === 2 || type === 15)) return data;
  return concat(units.filter(([type]) => type !== 2 && type !== 15).map(([, start, end]) => data.subarray(start, end)));
}

/** Samples as the container stores them: AV1 units lose their delimiters, other codecs stay as they are. */
const storedSamples = (codec: string, samples: readonly VideoSample[]): readonly VideoSample[] =>
  codec.startsWith('av01') ? samples.map((sample) => ({ ...sample, data: av1StoredUnit(sample.data) })) : samples;

/** The VP9 CodecPrivate of the Matroska codec mapping: profile, level, bit depth and chroma subsampling as ID, size, value. */
function vp9CodecPrivate(codec: string): Uint8Array {
  const [, profile, level, depth] = codec.split('.').map(Number);
  if (![profile, level, depth].every(Number.isInteger)) return new Uint8Array(0);
  return Uint8Array.of(1, 1, profile, 2, 1, level, 3, 1, depth, 4, 1, 0); // Chroma 0: 4:2:0 vertical (left, between rows)
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

/** The EBML header of a WebM file (RFC 9559 and the WebM guidelines). */
const ebmlHeader = () =>
  element(
    EBML,
    unsigned(0x4286, 1),
    unsigned(0x42f7, 1),
    unsigned(0x42f2, 4),
    unsigned(0x42f3, 8),
    element(0x4282, text('webm')),
    unsigned(0x4287, 4),
    unsigned(0x4285, 2),
  );

/** Info, with the duration in milliseconds when it is known. */
const webmInfo = (end?: number) =>
  element(
    INFO,
    unsigned(0x2ad7b1, 1_000_000),
    ...(end === undefined ? [] : [float(0x4489, end / 1000)]),
    element(0x4d80, text('Margo Engine')),
    element(0x5741, text('Margo Engine')),
  );

/** Tracks: the video, and the sound when there is one. `first` is the first stored frame (AV1 reads its sequence header). */
function webmTracks(track: VideoTrack, sound: SoundTrack | undefined, first: Uint8Array | undefined): Uint8Array {
  const family = track.codec.split('.')[0],
    vp9Private = family === 'vp09' ? vp9CodecPrivate(track.codec) : new Uint8Array(0),
    colour = colourCodes(track.colorSpace);
  return element(
    TRACKS,
    element(
      0xae,
      unsigned(0xd7, 1),
      unsigned(0x73c5, 1),
      unsigned(0x83, 1),
      unsigned(0x9c, 0),
      ...(track.variable ? [] : [unsigned(0x23e383, Math.round(1e9 / track.fps))]),
      // MaxBlockAdditionID 1: blocks may carry BlockAddID 1, the alpha frame (RFC 9559 5.1.4.1.16).
      ...(track.alpha ? [unsigned(0x55ee, 1)] : []),
      element(0x86, text(WEBM_CODECS[family])),
      ...(family === 'av01' ? [element(0x63a2, av1Configuration(track, first))] : []),
      ...(vp9Private.length ? [element(0x63a2, vp9Private)] : []),
      element(
        0xe0,
        unsigned(0xb0, track.width),
        unsigned(0xba, track.height),
        // AlphaMode 1: the BlockAdditional of BlockAddID 1 holds the alpha (RFC 9559 5.1.4.1.28.4).
        ...(track.alpha ? [unsigned(0x53c0, 1)] : []),
        element(
          0x55b0,
          unsigned(0x55b1, colour.matrix),
          // ChromaSitingHorz 1 (left collocated), ChromaSitingVert 2 (half): where encodeVideo makes its chroma.
          unsigned(0x55b7, 1),
          unsigned(0x55b8, 2),
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
            // SamplingFrequency is the OpusHead's input sample rate (Matroska codec mapping, A_OPUS).
            element(0xe1, float(0xb5, opusInputRate(sound)), unsigned(0x9f, sound.channels)),
          ),
        ]
      : []),
  );
}

/** Tags holding the provenance JSON, or nothing. */
const webmTags = (provenance: VideoTrack['provenance']) =>
  provenance
    ? element(
        0x1254c367,
        element(
          0x7373,
          element(0x63c0),
          element(0x67c8, element(0x45a3, text('MARGO_PROVENANCE')), element(0x4487, text(JSON.stringify(provenance)))),
        ),
      )
    : new Uint8Array(0);

const ms = (time: number) => Math.round(time / 1000);

/** A cluster being filled: its time in milliseconds, whether it starts at a key frame, and its blocks. */
interface WebMGroup {
  time: number;
  key: boolean;
  blocks: Uint8Array[];
}

/**
 * Puts frames and sound into clusters in time order: a new cluster at each key frame, and wherever a block's offset
 * from its cluster would pass MOST_BLOCK_OFFSET. Sound goes in between the frames; `hear` places the sound before a time.
 */
function webmClusters(sounds: readonly VideoSample[]) {
  const groups: WebMGroup[] = [];
  let previous = 0,
    heard = 0;
  const block = (group: WebMGroup, number: number, time: number, sample: VideoSample) => {
      const head = new Uint8Array(4);
      head[0] = 0x80 | number;
      new DataView(head.buffer).setInt16(1, time - group.time);
      if (!sample.alpha) {
        head[3] = sample.key ? 0x80 : 0;
        group.blocks.push(element(0xa3, head, sample.data));
        return;
      }
      // A SimpleBlock has no room for additions, so a frame with alpha is a BlockGroup: the Block, BlockAdditions >
      // BlockMore > BlockAddID 1 and BlockAdditional, and for a frame that is not a key frame a ReferenceBlock to the
      // frame before, as a Block has no key flag (RFC 9559 5.1.3.5 to 5.1.3.5.5).
      const back = previous - time,
        width = back ? Math.ceil((Math.log2(-back) + 1) / 8) : 1;
      group.blocks.push(
        element(
          0xa0,
          element(0xa1, head, sample.data),
          element(0x75a1, element(0xa6, unsigned(0xee, 1), element(0xa5, sample.alpha))),
          ...(sample.key ? [] : [element(0xfb, bigEndian(2 ** (8 * width) + back, width))]),
        ),
      );
    },
    hear = (until: number) => {
      for (; heard < sounds.length && ms(sounds[heard].timestamp) < until; heard++) {
        const time = ms(sounds[heard].timestamp);
        let group = groups.at(-1);
        if (!group || time - group.time > MOST_BLOCK_OFFSET) groups.push((group = { time, key: false, blocks: [] }));
        block(group, 2, time, sounds[heard]);
      }
    };
  return {
    groups,
    hear,
    video(sample: VideoSample) {
      const time = ms(sample.timestamp);
      hear(time);
      let group = groups.at(-1);
      if (!group || sample.key || time - group.time > MOST_BLOCK_OFFSET)
        groups.push((group = { time, key: sample.key, blocks: [] }));
      block(group, 1, time, sample);
      previous = time;
    },
  };
}

/** A cue point: a key frame's cluster at `at` bytes into the Segment's data. */
const cuePoint = (time: number, at: number) =>
  element(0xbb, unsigned(0xb3, time), element(0xb7, unsigned(0xf7, 1), unsigned(0xf1, at)));

/** A WebM file: header, one cluster per key frame, then cues for seeking. Timestamps are whole milliseconds. */
export function muxWebM(track: VideoTrack, frames: readonly VideoSample[], sound?: SoundTrack): Uint8Array {
  const samples = storedSamples(track.codec, frames),
    end = [...samples, ...(sound?.samples ?? [])].reduce(
      (most, sample) => Math.max(most, sample.timestamp + sample.duration),
      0,
    ),
    info = webmInfo(end),
    tracks = webmTracks(track, sound, samples[0]?.data),
    filling = webmClusters(sound?.samples ?? []);
  for (const sample of samples) filling.video(sample);
  filling.hear(Number.POSITIVE_INFINITY);
  const groups = filling.groups,
    clusters = groups.map(({ time, blocks }) => element(CLUSTER, unsigned(0xe7, time), ...blocks)),
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
    if (group.key) points.push(cuePoint(group.time, at));
    at += clusters[i].length;
  });
  const segment = [
      seekHead(start, start + info.length, at),
      info,
      tracks,
      ...clusters,
      element(CUES, ...points),
      webmTags(track.provenance),
    ],
    size = bigEndian(
      segment.reduce((sum, part) => sum + part.length, 0),
      8,
    );
  size[0] = 1; // The 8-byte size marker; a file is far below 2^56 bytes.
  return concat([ebmlHeader(), elementId(SEGMENT), size, ...segment]);
}

/**
 * Writes a WebM as frames arrive, as a live stream is written (RFC 9559 6.2, unknown sizes): the Segment's size is
 * unknown, as the end is not known when the header goes out, and so the header states no duration and has no SeekHead.
 * {@link add} takes each video sample in decode order and gives back the pieces now complete: the header first, then
 * each cluster once the next key frame shows where it ends. Each cluster is whole when written, so its size is known.
 * {@link finish} gives the last clusters and the Cues, which a reader that walks the file finds at its end. The joined
 * pieces are one file; the header and clusters are what Media Source Extensions take.
 */
export class StreamedWebM {
  readonly #track: VideoTrack;
  readonly #sound?: SoundTrack;
  readonly #filling: ReturnType<typeof webmClusters>;
  readonly #points: Uint8Array[] = [];
  /** Bytes written into the Segment's data, where cue positions count from; -1 before the header. */
  #at = -1;

  constructor(track: VideoTrack, sound?: SoundTrack) {
    this.#track = track;
    this.#sound = sound;
    this.#filling = webmClusters(sound?.samples ?? []);
  }

  /** Takes the next video sample in decode order; returns the header and any clusters it completes. */
  add(frame: VideoSample): Uint8Array[] {
    const [sample] = storedSamples(this.#track.codec, [frame]),
      out: Uint8Array[] = [];
    if (this.#at < 0) {
      const head = [webmInfo(), webmTracks(this.#track, this.#sound, sample.data), webmTags(this.#track.provenance)];
      this.#at = head.reduce((sum, part) => sum + part.length, 0);
      // An unknown size is all ones (RFC 9559 6.2); 8 bytes, as live writers give it.
      out.push(
        concat([ebmlHeader(), elementId(SEGMENT), Uint8Array.of(1, 255, 255, 255, 255, 255, 255, 255), ...head]),
      );
    }
    if (sample.key) {
      this.#filling.hear(ms(sample.timestamp));
      out.push(...this.#clusters());
    }
    this.#filling.video(sample);
    return out;
  }

  /** The last clusters, with the sound after the last frame, and the Cues. */
  finish(): Uint8Array[] {
    if (this.#at < 0) return [];
    this.#filling.hear(Number.POSITIVE_INFINITY);
    return [...this.#clusters(), element(CUES, ...this.#points)];
  }

  /** The clusters filled so far, written and indexed. */
  #clusters(): Uint8Array[] {
    return this.#filling.groups.splice(0).map(({ time, key, blocks }) => {
      if (key) this.#points.push(cuePoint(time, this.#at));
      const cluster = element(CLUSTER, unsigned(0xe7, time), ...blocks);
      this.#at += cluster.length;
      return cluster;
    });
  }
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
function sampleEntry(track: VideoTrack, first?: Uint8Array): Uint8Array {
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
  // ISO/IEC 14496-15 8.4.1: HEVCSampleEntry with the encoder's HEVCDecoderConfigurationRecord.
  if (family === 'hvc1' || family === 'hev1') return box(family, ...head, box('hvcC', track.description!), colr);
  if (family === 'av01') return box('av01', ...head, box('av1C', av1Configuration(track, first)), colr);
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
        (depth << 4) | (colour.fullRange ? 1 : 0), // Chroma 0: 4:2:0 vertical (left column, between rows), as made
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
    // Opus: 48000, whatever the input rate (Encapsulation of Opus in ISOBMFF 4.3.1); the AAC rate is its own.
    u32((sound.codec === 'opus' ? 48_000 : sound.sampleRate) * 0x10000),
  ];
  if (sound.codec === 'opus')
    return box(
      'Opus',
      ...head,
      box(
        'dOps',
        Uint8Array.of(0, sound.channels),
        u16(opusPreSkip(sound)),
        u32(opusInputRate(sound)),
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

/**
 * The time unit of a sound track, the samples its edit list cuts from the start, and its presentation in milliseconds.
 * Opus counts at 48 kHz, its decoders' rate, and cuts its OpusHead pre-skip (Encapsulation of Opus in ISOBMFF 4.4: the
 * edit list does the trimming, PreSkip is informative); AAC counts at its own rate and cuts the measured lead-in.
 */
function soundTiming(sound: SoundTrack) {
  const sampleRate = sound.codec === 'opus' ? 48_000 : sound.sampleRate,
    cut = sound.codec === 'opus' ? opusPreSkip(sound) : (sound.leadIn ?? 0),
    last = sound.samples.at(-1)!,
    end = Math.round(((last.timestamp + last.duration) * sampleRate) / 1e6);
  return { sampleRate, cut, end, milliseconds: Math.round(((end - cut) / sampleRate) * 1000) };
}

/** The `trak` of a sound. Its time unit is one sample. */
function soundTrak(sound: SoundTrack, position: number): Uint8Array {
  const { samples } = sound,
    { sampleRate, cut: leadIn, end, milliseconds } = soundTiming(sound),
    ticks = (time: number) => Math.round((time * sampleRate) / 1e6),
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
    ...(leadIn ? [box('edts', fullBox('elst', 0, 0, u32(1), u32(milliseconds), u32(leadIn), u16(1), u16(0)))] : []),
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
          // ISO/IEC 14496-12 10.1 and 10.1.1.2: every AAC frame needs the one before it to decode right (roll
          // distance -1). Without this group WebKit's decodeAudioData drops the lead-in twice and the sound plays
          // 44 ms early; with it, WebKit, Chromium, AudioToolbox and ffmpeg all start it on the edit list's sample.
          // Opus needs 80 ms of decoded packets before a random access point is right (Encapsulation of Opus in ISOBMFF
          // 4.3.3 and RFC 7845 4.6), so its roll distance is that many packets, counted from the first's length.
          fullBox(
            'sgpd',
            1,
            0,
            text('roll'),
            u32(2),
            u32(1),
            u16(
              0x10000 - (sound.codec === 'aac' ? 1 : Math.max(1, Math.ceil(3840 / Math.max(1, durations[0] ?? 960)))),
            ),
          ),
          fullBox('sbgp', 0, 0, text('roll'), u32(1), u32(samples.length), u32(1)),
        ),
      ),
    ),
  );
}

/**
 * An H.264 track whose parameter sets state the sample range the encoder reported, so the stream and the `colr` box
 * agree: players follow the SPS, and an encoder can report full range while its SPS says limited (Chromium's on the
 * Radeon 680M; docs/work-lists/amd-gpu-hunt.md row 11). Other codecs, and tracks with no reported range, stay as they are.
 */
function rangeAgreed(track: VideoTrack, samples: readonly VideoSample[]) {
  const full = track.colorSpace?.fullRange,
    record = track.description;
  if (!track.codec.startsWith('avc1') || typeof full !== 'boolean' || !record || record.length < 5 || record[0] !== 1)
    return { track, samples };
  const lengthSize = (record[4] & 3) + 1;
  return {
    track: { ...track, description: avcConfigurationWithRange(record, full) },
    samples: samples.map((sample) =>
      sample.key ? { ...sample, data: avcSampleWithRange(sample.data, lengthSize, full) } : sample,
    ),
  };
}

/** A progressive MP4: `moov` first so playback can start before the end arrives, each track's samples in one chunk. */
export function muxMP4(video: VideoTrack, frames: readonly VideoSample[], sound?: SoundTrack): Uint8Array {
  const { track, samples } = rangeAgreed(video, storedSamples(video.codec, frames)),
    family = track.codec.split('.')[0],
    timescale = Math.round(track.fps * 1000),
    ticks = (time: number) => Math.round((time * timescale) / 1e6),
    shown = samples.map((sample) => ticks(sample.timestamp)),
    // Decode times are the presentation times in order, so the first is 0 and no edit list is needed.
    decoded = [...shown].sort((a, b) => a - b),
    end = samples.reduce((most, sample) => Math.max(most, ticks(sample.timestamp + sample.duration)), 0),
    durations = decoded.map((time, i) => (decoded[i + 1] ?? end) - time),
    offsets = shown.map((time, i) => time - decoded[i]),
    // Each track header holds its own presentation length; the movie's is the longer (ISO/IEC 14496-12 8.2.2, 8.3.2).
    seen = Math.round((end / timescale) * 1000),
    milliseconds = Math.max(seen, sound ? soundTiming(sound).milliseconds : 0),
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
      ...(family === 'av01' ? [text('av01')] : []), // AV1 ISOBMFF binding 2.1: SHALL be among the compatible brands
    ),
    table = (type: string, version: number, rows: readonly [number, number][]) =>
      fullBox(type, version, 0, u32(rows.length), ...rows.flatMap(([count, value]) => [u32(count), i32(value)])),
    moov = (position: number) =>
      box(
        'moov',
        ...(track.provenance ? [box('udta', box('marg', text(JSON.stringify(track.provenance))))] : []),
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
            u32(seen),
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
                fullBox('stsd', 0, 0, u32(1), sampleEntry(track, samples[0]?.data)),
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
        ...(sound ? [soundTrak(sound, position + bytes)] : []),
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

// Fragmented ISO base media (ISO/IEC 14496-12 8.8): a header whose sample tables are empty and whose `mvex` says
// fragments follow, then a `moof` and `mdat` per key frame interval, then an `mfra` (8.8.9 to 8.8.11) so a player can
// seek in the finished file without reading every `moof`. Each fragment's times are absolute (`tfdt`, 8.8.12) and its
// sample offsets count from its own `moof` (`default-base-is-moof`, 8.8.7.1), so fragments stand alone.

const KEY_FLAGS = 0x02000000, // sample_depends_on 2: depends on no other sample
  DELTA_FLAGS = 0x01010000; // sample_depends_on 1 and sample_is_non_sync_sample

/** A track's header with empty sample tables: its samples are all in fragments. */
const emptyTables = (entry: Uint8Array, ...more: Uint8Array[]) =>
  box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
    ...more,
  );

/** One track's run in a fragment: `samples` with durations, flags and composition offsets in the track's time unit. */
interface FragmentRun {
  track: number;
  decodeTime: number;
  samples: readonly { data: Uint8Array; duration: number; flags: number; offset: number }[];
  /** Samples in the sound's roll group (the description in the header's `sgpd`). */
  rolls?: boolean;
}

/** A `traf` whose `trun` data offset is `dataOffset` bytes past the start of its `moof`. */
function trackFragment({ track, decodeTime, samples, rolls }: FragmentRun, dataOffset: number): Uint8Array {
  const offsets = samples.some((sample) => sample.offset !== 0);
  return box(
    'traf',
    fullBox('tfhd', 0, 0x020000, u32(track)), // default-base-is-moof
    fullBox('tfdt', 1, 0, u64(decodeTime)),
    // Data offset, then per sample: duration, size, flags and (version 1, signed) composition offset.
    fullBox(
      'trun',
      1,
      0x000001 | 0x000100 | 0x000200 | 0x000400 | (offsets ? 0x000800 : 0),
      u32(samples.length),
      i32(dataOffset),
      ...samples.flatMap((sample) => [
        u32(sample.duration),
        u32(sample.data.length),
        u32(sample.flags),
        ...(offsets ? [i32(sample.offset)] : []),
      ]),
    ),
    ...(rolls ? [fullBox('sbgp', 0, 0, text('roll'), u32(1), u32(samples.length), u32(1))] : []),
  );
}

/**
 * Writes a fragmented MP4 as samples arrive: {@link add} takes each video sample in decode order and gives back the
 * pieces now complete, {@link finish} the rest. The sound, given whole, is cut into each fragment beside its frames.
 * The joined pieces are one file.
 */
export class FragmentedMP4 {
  readonly #track: VideoTrack;
  readonly #sound?: SoundTrack;
  readonly #timescale: number;
  readonly #soundTicks: number[] = [];
  readonly #soundDurations: number[] = [];
  #pending: VideoSample[] = [];
  #heard = 0;
  #sequence = 0;
  #written = 0;
  #started = false;
  readonly #index: { time: number; position: number }[] = [];

  constructor(track: VideoTrack, sound?: SoundTrack) {
    this.#track = rangeAgreed(track, []).track;
    this.#sound = sound;
    this.#timescale = Math.round(track.fps * 1000);
    if (sound) {
      const { sampleRate, end } = soundTiming(sound),
        ticks = sound.samples.map((sample) => Math.round((sample.timestamp * sampleRate) / 1e6));
      this.#soundTicks.push(...ticks);
      this.#soundDurations.push(...ticks.map((tick, i) => (ticks[i + 1] ?? end) - tick));
    }
  }

  /** Takes the next video sample in decode order; returns the header and any fragment it completes. */
  add(sample: VideoSample): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (!this.#started) {
      this.#started = true;
      out.push(this.#emit(this.#header(sample)));
    }
    if (sample.key && this.#pending.length) out.push(this.#fragment(sample.timestamp));
    this.#pending.push(sample);
    return out;
  }

  /** The last fragment and the random access index. */
  finish(): Uint8Array[] {
    if (!this.#started) return [];
    const out = this.#pending.length ? [this.#fragment(undefined)] : [];
    out.push(this.#emit(this.#randomAccess()));
    return out;
  }

  #emit(bytes: Uint8Array): Uint8Array {
    this.#written += bytes.length;
    return bytes;
  }

  #header(first: VideoSample): Uint8Array {
    const track = this.#track,
      sound = this.#sound,
      family = track.codec.split('.')[0],
      firstData = storedSamples(track.codec, [first])[0].data,
      ftyp = box(
        'ftyp',
        text('iso6'),
        u32(0),
        text('iso6'),
        text('iso5'),
        text('isom'),
        text('mp41'),
        ...(family === 'avc1' ? [text('avc1')] : []),
        ...(family === 'av01' ? [text('av01')] : []),
      ),
      handler = (type: string) => fullBox('hdlr', 0, 0, u32(0), text(type), new Uint8Array(12), text('Margo Engine\0')),
      dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
      trex = (id: number) => fullBox('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0));
    let soundTrak: Uint8Array[] = [];
    if (sound) {
      const { sampleRate, cut } = soundTiming(sound),
        roll =
          0x10000 -
          (sound.codec === 'aac' ? 1 : Math.max(1, Math.ceil(3840 / Math.max(1, this.#soundDurations[0] ?? 960))));
      soundTrak = [
        box(
          'trak',
          fullBox(
            'tkhd',
            0,
            3,
            u32(0),
            u32(0),
            u32(2),
            u32(0),
            u32(0),
            new Uint8Array(12),
            u16(0x100),
            u16(0),
            UNITY_MATRIX,
            u32(0),
            u32(0),
          ),
          // The edit starts the presentation `cut` samples into the media; a duration of 0 in a fragmented file runs it
          // to the end of the media, however many fragments follow (14496-12 8.6.6.3).
          ...(cut ? [box('edts', fullBox('elst', 0, 0, u32(1), u32(0), u32(cut), u16(1), u16(0)))] : []),
          box(
            'mdia',
            fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(0), u16(0x55c4), u16(0)),
            handler('soun'),
            box(
              'minf',
              fullBox('smhd', 0, 0, u32(0)),
              dinf,
              // The roll group of muxMP4's sound track; each fragment's `sbgp` puts its samples in it.
              emptyTables(soundEntry(sound), fullBox('sgpd', 1, 0, text('roll'), u32(2), u32(1), u16(roll))),
            ),
          ),
        ),
      ];
    }
    const moov = box(
      'moov',
      ...(track.provenance ? [box('udta', box('marg', text(JSON.stringify(track.provenance))))] : []),
      fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(1000),
        u32(0),
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
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(0),
          new Uint8Array(16),
          UNITY_MATRIX,
          u32(track.width * 0x10000),
          u32(track.height * 0x10000),
        ),
        box(
          'mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.#timescale), u32(0), u16(0x55c4), u16(0)),
          handler('vide'),
          box('minf', fullBox('vmhd', 0, 1, new Uint8Array(8)), dinf, emptyTables(sampleEntry(track, firstData))),
        ),
      ),
      ...soundTrak,
      box('mvex', trex(1), ...(sound ? [trex(2)] : [])),
    );
    return concat([ftyp, moov]);
  }

  /** The pending video samples as one fragment, ending where the next fragment's first sample starts (µs). */
  #fragment(next: number | undefined): Uint8Array {
    const { samples } = rangeAgreed(this.#track, storedSamples(this.#track.codec, this.#pending)),
      timescale = this.#timescale,
      ticks = (time: number) => Math.round((time * timescale) / 1e6),
      shown = samples.map((sample) => ticks(sample.timestamp)),
      decoded = [...shown].sort((a, b) => a - b),
      end =
        next === undefined
          ? samples.reduce((most, sample) => Math.max(most, ticks(sample.timestamp + sample.duration)), 0)
          : ticks(next),
      video: FragmentRun = {
        track: 1,
        decodeTime: decoded[0],
        samples: samples.map((sample, i) => ({
          data: sample.data,
          duration: (decoded[i + 1] ?? end) - decoded[i],
          flags: sample.key ? KEY_FLAGS : DELTA_FLAGS,
          offset: shown[i] - decoded[i],
        })),
      },
      runs = [video];
    const sound = this.#sound;
    if (sound) {
      const from = this.#heard;
      while (this.#heard < sound.samples.length && (next === undefined || sound.samples[this.#heard].timestamp < next))
        this.#heard++;
      if (this.#heard > from)
        runs.push({
          track: 2,
          decodeTime: this.#soundTicks[from],
          rolls: true,
          samples: sound.samples.slice(from, this.#heard).map((sample, i) => ({
            data: sample.data,
            duration: this.#soundDurations[from + i],
            flags: KEY_FLAGS,
            offset: 0,
          })),
        });
    }
    this.#index.push({ time: shown[0], position: this.#written });
    this.#pending = [];
    // The moof's size does not depend on the offsets in it, so it is built once to measure and once to keep.
    const sequence = ++this.#sequence,
      moof = (offsets: number[]) =>
        box('moof', fullBox('mfhd', 0, 0, u32(sequence)), ...runs.map((run, i) => trackFragment(run, offsets[i]))),
      sizes = runs.map((run) => run.samples.reduce((sum, sample) => sum + sample.data.length, 0)),
      head = moof(runs.map(() => 0)).length + 16,
      bytes = sizes.reduce((sum, size) => sum + size, 0);
    const offsets = sizes.map((_, i) => head + sizes.slice(0, i).reduce((sum, size) => sum + size, 0));
    return this.#emit(
      concat([
        moof(offsets),
        u32(1),
        text('mdat'),
        u64(bytes + 16),
        ...runs.flatMap((run) => run.samples.map((sample) => sample.data)),
      ]),
    );
  }

  /** `mfra`: the video track's fragments by presentation time and file position, then `mfro` with its size. */
  #randomAccess(): Uint8Array {
    const tfra = fullBox(
        'tfra',
        1,
        0,
        u32(1),
        u32(0), // traf, trun and sample numbers one byte each
        u32(this.#index.length),
        ...this.#index.flatMap(({ time, position }) => [u64(time), u64(position), Uint8Array.of(1, 1, 1)]),
      ),
      size = tfra.length + 8 + 16;
    return box('mfra', tfra, fullBox('mfro', 0, 0, u32(size)));
  }
}
