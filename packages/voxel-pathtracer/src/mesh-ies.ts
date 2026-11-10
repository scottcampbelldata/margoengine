import { MargoError } from '@margoengine/math/errors';

/** Type C photometric intensity, horizontal planes of vertical samples, in candela. */
export interface TraceIESProfile {
  /** Strictly increasing polar angles in degrees, within 0 through 180. */
  readonly verticalAngles: Float32Array;
  /** Strictly increasing azimuth planes in degrees; one plane or symmetric 90/180/full 360 coverage. */
  readonly horizontalAngles: Float32Array;
  /** Horizontal-major absolute candela, with the file's multiplier already applied. */
  readonly candela: Float32Array;
  /** Optional lamp tilt angles, degrees. */
  readonly tiltAngles?: Float32Array;
  /** Multipliers at tiltAngles. */
  readonly tiltMultipliers?: Float32Array;
  /** LM-63 lamp-to-luminaire geometry, 1, 2 or 3. Default 1. */
  readonly lampGeometry?: number;
}

/** Options for parsing legacy LM-63 external tilt data. */
export interface TraceIESParseOptions {
  /** Contents of TILT=<filename>, resolved by the caller. No implicit network access. */
  tilt?: string;
}

function numbers(text: string): number[] {
  const tokens = text.trim().split(/[\s,]+/);
  if (tokens.length > 1_100_000 || tokens.some(s => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)))
    throw new TypeError('IES numeric section is malformed or too large; provide an LM-63 file');
  const values = tokens.map(Number);
  if (values.some(n => !Number.isFinite(n))) throw new RangeError('IES values must be finite');
  return values;
}
function angles(values: number[], low: number, high: number): Float32Array {
  if (!values.length || values.some((v, i) => v < low || v > high || (i > 0 && v <= values[i-1]!)))
    throw new RangeError(`IES angles must strictly increase in [${low}, ${high}] degrees`);
  const out = new Float32Array(values);
  if (out.some((v, i) => i > 0 && v <= out[i-1]!)) throw new RangeError('IES angle steps must remain distinct in Float32');
  return out;
}
function count(value: number | undefined): number {
  if (!Number.isInteger(value) || value! < 1 || value! > 1_000_000) throw new RangeError('IES sample counts must be positive bounded integers');
  return value!;
}

/** Parse LM-63 Type C candela and included/external tilt, without copying a third-party implementation. */
export function parseTraceIES(text: string, options: TraceIESParseOptions = {}): TraceIESProfile {
  if (typeof text !== 'string' || text.length > 32 << 20 || text.includes('\0'))
    throw new TypeError('IES input must be an LM-63 text file smaller than 32 MiB');
  const match = /^TILT=([^\r\n]+)[\r\n]+/m.exec(text);
  if (!match) throw new TypeError('IES file needs a TILT line');
  const mode = match[1]!.trim(), values = numbers(text.slice(match.index + match[0].length));
  let at = 0, tiltAngles: Float32Array | undefined, tiltMultipliers: Float32Array | undefined, lampGeometry: number | undefined;
  if (mode !== 'NONE') {
    const tilt = mode === 'INCLUDE' ? values : options.tilt === undefined ? undefined : numbers(options.tilt);
    if (!tilt) throw new MargoError('unsupported', 'IES external tilt needs options.tilt text; resolve its file: https://margoengine.com/errors#voxel-pathtracer');
    lampGeometry = tilt[0];
    if (![1,2,3].includes(lampGeometry!)) throw new RangeError('IES lamp geometry must be 1, 2 or 3');
    const n = count(tilt[1]);
    if (tilt.length < 2+n*2) throw new TypeError('IES tilt samples are truncated; provide the complete tilt table');
    tiltAngles = angles(tilt.slice(2,2+n),0,180);
    tiltMultipliers = new Float32Array(tilt.slice(2+n,2+n*2));
    if (tiltMultipliers.some(n=>!Number.isFinite(n)||n<0)) throw new RangeError('IES tilt multipliers must be finite and nonnegative');
    if (mode === 'INCLUDE') at = 2+n*2;
    else if (tilt.length !== 2+n*2) throw new TypeError('IES external tilt contains trailing data; provide only its declared tilt table');
  }
  if (values.length < at+13) throw new TypeError('IES photometric header is truncated; provide all 13 header values');
  const multiplier=values[at+2]!, vertical=count(values[at+3]), horizontal=count(values[at+4]), type=values[at+5];
  if (type !== 1) throw new MargoError('unsupported', 'IES rendering uses Type C photometry; convert Type A/B to Type C: https://margoengine.com/errors#voxel-pathtracer');
  if (multiplier < 0 || ![1,2].includes(values[at+6]!)) throw new RangeError('IES candela multiplier and dimension units are invalid; use a nonnegative multiplier and units 1 or 2');
  const samples=vertical*horizontal;
  if (samples > 1_000_000 || values.length !== at+13+vertical+horizontal+samples)
    throw new TypeError('IES angle and candela counts do not match the complete numeric section; provide the declared samples');
  at+=13;
  const verticalAngles=angles(values.slice(at,at+vertical),0,180);at+=vertical;
  const horizontalAngles=angles(values.slice(at,at+horizontal),0,360);at+=horizontal;
  if (horizontal > 1 && (horizontalAngles[0] !== 0 || ![90,180,360].includes(horizontalAngles[horizontal-1]!)))
    throw new RangeError('IES Type C planes must span 0 to 90, 180 or 360 degrees, or use one rotationally symmetric plane');
  const candela=new Float32Array(values.slice(at).map(n=>n*multiplier));
  if (candela.some(n=>!Number.isFinite(n)||n<0)) throw new RangeError('IES candela must be finite and nonnegative after scaling');
  return {verticalAngles,horizontalAngles,candela,...(tiltAngles?{tiltAngles,tiltMultipliers,lampGeometry}:{})};
}
