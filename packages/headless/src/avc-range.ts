// The sample range an H.264 sequence parameter set declares (ITU-T H.264 7.3.2.1.1 and E.1.1), set to the range the
// encoder reported. A player converts H.264 samples to RGB by the SPS's video_full_range_flag and ignores the
// container's `colr` box, so when an encoder writes full-range samples, says so in its `decoderConfig.colorSpace`, but
// leaves its SPS saying limited (Chromium's H.264 encoder on Windows with an AMD GPU does), every frame plays back
// contrast stretched: (v - 16) x 255 / 219. The rewrite touches only the VUI's video signal type; every other bit is
// copied, so the parameter set decodes the same in every other respect.

/** The RBSP of a NAL unit, without its header byte and with the emulation prevention bytes taken out. */
function unescape(nal: Uint8Array): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      zeros = 0;
      continue;
    }
    out.push(nal[i]);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  return out;
}

/** `rbsp` with an emulation prevention byte wherever two zero bytes meet a byte of 3 or less. */
function escape(rbsp: readonly number[]): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

const PROFILES_WITH_CHROMA = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * The SPS NAL unit `nal` with its video_full_range_flag set to `fullRange`, or undefined when it already says that or
 * cannot be read (anything not understood is left alone).
 */
export function spsWithRange(nal: Uint8Array, fullRange: boolean): Uint8Array | undefined {
  if (!nal.length || (nal[0] & 0x1f) !== 7) return undefined;
  const rbsp = unescape(nal),
    total = rbsp.length * 8;
  let at = 0;
  const bit = (): number => {
      if (at >= total) throw new RangeError('SPS ends early; it is left as the encoder wrote it');
      return (rbsp[at >> 3] >> (7 - (at++ & 7))) & 1;
    },
    bits = (n: number): number => {
      let value = 0;
      for (let i = 0; i < n; i++) value = value * 2 + bit();
      return value;
    },
    ue = (): number => {
      let zeros = 0;
      while (!bit()) if (++zeros > 31) throw new RangeError('Exp-Golomb code too long; the SPS is left as the encoder wrote it');
      return 2 ** zeros - 1 + bits(zeros);
    },
    skipScalingList = (size: number): void => {
      let last = 8,
        next = 8;
      for (let j = 0; j < size && next !== 0; j++) {
        const code = ue(),
          delta = code & 1 ? (code + 1) / 2 : -code / 2;
        next = (last + delta + 256) % 256;
        if (next !== 0) last = next;
      }
    };
  try {
    const profile = bits(8);
    bits(16); // constraint flags and level_idc
    ue(); // seq_parameter_set_id
    if (PROFILES_WITH_CHROMA.has(profile)) {
      const chroma = ue();
      if (chroma === 3) bit(); // separate_colour_plane_flag
      ue(); // bit_depth_luma_minus8
      ue(); // bit_depth_chroma_minus8
      bit(); // qpprime_y_zero_transform_bypass_flag
      if (bit())
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bit()) skipScalingList(i < 6 ? 16 : 64);
    }
    ue(); // log2_max_frame_num_minus4
    const order = ue();
    if (order === 0) ue();
    else if (order === 1) {
      bit();
      ue();
      ue();
      for (let i = ue(); i > 0; i--) ue();
    }
    ue(); // max_num_ref_frames
    bit(); // gaps_in_frame_num_value_allowed_flag
    ue();
    ue(); // picture width and height
    if (!bit()) bit(); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
    bit(); // direct_8x8_inference_flag
    if (bit()) for (let i = 0; i < 4; i++) ue(); // frame cropping
    // The stop bit: the last 1 of the RBSP. Everything between the read point and it is copied as it is.
    let stop = total - 1;
    while (stop >= 0 && !((rbsp[stop >> 3] >> (7 - (stop & 7))) & 1)) stop--;
    const out: number[] = [],
      put = (value: number, n: number): void => {
        for (let i = n - 1; i >= 0; i--) out.push(Math.floor(value / 2 ** i) % 2);
      },
      copy = (from: number, to: number): void => {
        for (let i = from; i < to; i++) out.push((rbsp[i >> 3] >> (7 - (i & 7))) & 1);
      },
      // video_signal_type_present_flag 1, video_format 5 (unspecified), the range, no colour description.
      signal = (): void => put(0b110100 | (fullRange ? 2 : 0), 6);
    const vuiFlag = at;
    if (!bit()) {
      if (!fullRange) return undefined; // No VUI: the range is limited already.
      copy(0, vuiFlag);
      put(1, 1); // vui_parameters_present_flag
      put(0, 2); // no aspect ratio, no overscan
      signal();
      put(0, 6); // no chroma location, timing, NAL HRD, VCL HRD, pic_struct or bitstream restriction
    } else {
      if (bit() && bits(8) === 255) bits(32); // aspect_ratio_info: idc, then sar width and height when extended
      if (bit()) bit(); // overscan_info
      const signalFlag = at;
      if (bit()) {
        bits(3); // video_format
        const rangeBit = at;
        if (bit() === (fullRange ? 1 : 0)) return undefined;
        copy(0, rangeBit);
        put(fullRange ? 1 : 0, 1);
        copy(rangeBit + 1, stop);
      } else {
        if (!fullRange) return undefined;
        copy(0, signalFlag);
        signal();
        copy(signalFlag + 1, stop);
      }
    }
    out.push(1);
    while (out.length % 8) out.push(0);
    const bytes: number[] = [];
    for (let i = 0; i < out.length; i += 8) bytes.push(bits8(out, i));
    return Uint8Array.from([nal[0], ...escape(bytes)]);
  } catch {
    return undefined;
  }
}

const bits8 = (list: readonly number[], from: number): number => {
  let value = 0;
  for (let i = 0; i < 8; i++) value = value * 2 + list[from + i];
  return value;
};

/**
 * The AVCDecoderConfigurationRecord (ISO/IEC 14496-15 5.3.3.1) with every SPS saying `fullRange`; the record as it is
 * when it says that already or cannot be read.
 */
export function avcConfigurationWithRange(record: Uint8Array, fullRange: boolean): Uint8Array {
  if (record.length < 7 || record[0] !== 1) return record;
  const parts: Uint8Array[] = [record.subarray(0, 6)];
  let at = 6,
    changed = false;
  const count = record[5] & 0x1f;
  for (let i = 0; i < count; i++) {
    if (at + 2 > record.length) return record;
    const size = (record[at] << 8) | record[at + 1],
      nal = record.subarray(at + 2, at + 2 + size);
    if (nal.length !== size) return record;
    const ranged = spsWithRange(nal, fullRange);
    if (ranged) changed = true;
    const body = ranged ?? nal;
    if (body.length > 0xffff) return record;
    parts.push(Uint8Array.of(body.length >> 8, body.length & 0xff), body);
    at += 2 + size;
  }
  if (!changed) return record;
  parts.push(record.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let to = 0;
  for (const part of parts) {
    out.set(part, to);
    to += part.length;
  }
  return out;
}

/**
 * A length-prefixed H.264 sample with any in-band SPS saying `fullRange`; the sample itself when none changes.
 * `lengthSize` is the record's lengthSizeMinusOne plus 1.
 */
export function avcSampleWithRange(sample: Uint8Array, lengthSize: number, fullRange: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0,
    changed = false;
  while (at + lengthSize <= sample.length) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + sample[at + i];
    const nal = sample.subarray(at + lengthSize, at + lengthSize + size);
    if (nal.length !== size) return sample;
    const ranged = spsWithRange(nal, fullRange);
    if (ranged) changed = true;
    const body = ranged ?? nal,
      prefix = new Uint8Array(lengthSize);
    for (let i = lengthSize - 1, n = body.length; i >= 0; i--, n = Math.floor(n / 256)) prefix[i] = n % 256;
    parts.push(prefix, body);
    at += lengthSize + size;
  }
  if (!changed || at !== sample.length) return sample;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let to = 0;
  for (const part of parts) {
    out.set(part, to);
    to += part.length;
  }
  return out;
}
