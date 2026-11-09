// Numeric filter data from ITU-R BS.1770-5 Annex 2, pages 18-19. Not library code.
const a = [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
  0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125];
const b = [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
  0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375];
/** @internal The four published 12-tap interpolation phases. */
export const peakPhases: readonly (readonly number[])[] = [a, b, [...b].reverse(), [...a].reverse()];

/** Estimate true peak as a linear gain using ITU's four-phase FIR, including zero-padded boundaries and sample peaks. */
export function measureTruePeak(channels: readonly Float32Array[]): number {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 32)
    throw new RangeError('True peak needs 1..32 PCM channels; pass an array of Float32Arrays');
  const length = channels[0]?.length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length)
      throw new TypeError('True peak needs equal-length Float32Array channels; decode or copy the PCM first');
    for (const value of channel) if (!Number.isFinite(value))
      throw new TypeError('True peak needs finite PCM samples; remove NaN and Infinity from the input');
  }
  let peak = 0;
  const history = channels.map(() => new Float64Array(12));
  for (let n = 0; n < length + 11; n++) {
    const at = n % 12;
    for (let c = 0; c < channels.length; c++) {
      const value = n < length ? channels[c][n] : 0;
      history[c][at] = value;
      peak = Math.max(peak, Math.abs(value));
      for (const phase of peakPhases) {
        let sum = 0;
        for (let k = 0; k < 12; k++) sum += phase[k] * history[c][(at - k + 12) % 12];
        peak = Math.max(peak, Math.abs(sum));
      }
    }
  }
  return peak;
}
