import { Audio, type AudioListener, type AudioOptions } from '@margoengine/audio';
import { smoothParam } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Options for a full-sphere ACN/SN3D AmbiX bed. */
export interface BinauralAudioOptions extends AudioOptions {
  /** Only AmbiX ACN/SN3D is accepted. Default 'ambix'. */
  format?: 'ambix';
}

const orderOf = (buffer: AudioBuffer): number => {
  const order = Math.sqrt(buffer?.numberOfChannels) - 1;
  if (![1, 2, 3].includes(order) || !Number.isFinite(buffer.duration) || buffer.duration <= 0)
    throw fault(
      'unsupported',
      'BinauralAudio needs a positive-duration 4, 9 or 16 channel AmbiX buffer; convert the recording to ACN/SN3D first',
    );
  return order;
};

/** Real ACN/SN3D harmonics, orders 0..3, for a unit direction [front, left, up]. */
export function ambixBasis(order: number, direction: readonly [number, number, number]): Float64Array {
  if (
    !Number.isInteger(order) ||
    order < 0 ||
    order > 3 ||
    direction.length !== 3 ||
    direction.some((v) => !Number.isFinite(v)) ||
    Math.abs(Math.hypot(...direction) - 1) > 1e-10
  )
    throw rangeError(
      'AmbiX basis needs order 0..3 and a unit [front,left,up] vector; normalize the direction first',
      'state',
    );
  const z = direction[2],
    azimuth = Math.atan2(direction[1], direction[0]);
  const values = new Float64Array((order + 1) ** 2);
  const factorial = (n: number): number => {
    let v = 1;
    for (let i = 2; i <= n; i++) v *= i;
    return v;
  };
  let diagonal = 1;
  for (let m = 0; m <= order; m++) {
    if (m > 0) diagonal *= (2 * m - 1) * Math.sqrt(Math.max(0, 1 - z * z));
    let previous = 0,
      current = diagonal;
    for (let n = m; n <= order; n++) {
      if (n > m) {
        const next = ((2 * n - 1) * z * current - (n + m - 1) * previous) / (n - m);
        previous = current;
        current = next;
      }
      const normalization = Math.sqrt(((m === 0 ? 1 : 2) * factorial(n - m)) / factorial(n + m));
      values[n * n + n + m] = normalization * current * Math.cos(m * azimuth);
      if (m > 0) values[n * n + n - m] = normalization * current * Math.sin(m * azimuth);
    }
  }
  return values;
}

/**
 * First/second/third-order AmbiX decoded over a 32-direction Gauss-Legendre sphere
 * through native Web Audio HRTFs. Inherits buffer transport, seeks, fades and filters.
 */
export class BinauralAudio extends Audio {
  /** Ambisonic order inferred from the complete channel set: 1, 2 or 3. */
  readonly order: number;
  /** Number of native HRTF virtual loudspeakers, always 32. */
  readonly speakerCount = 32;
  private readonly splitter: ChannelSplitterNode;
  private readonly output: GainNode;
  private readonly matrix: GainNode[] = [];
  private readonly speakers: { node: PannerNode; direction: [number, number, number] }[] = [];
  private rotation = [0, 0, 0, 1];
  private written = false;

  constructor(listener: AudioListener, buffer: AudioBuffer, options: BinauralAudioOptions = {}) {
    const order = orderOf(buffer);
    if ((options.format ?? 'ambix') !== 'ambix')
      throw fault('unsupported', 'BinauralAudio accepts AmbiX only; convert the recording to ACN/SN3D');
    super(listener, { ...options, loop: options.loop ?? true });
    this.order = order;
    const context = listener.context;
    this.splitter = context.createChannelSplitter(buffer.numberOfChannels);
    this.splitter.channelInterpretation = 'discrete';
    this.output = context.createGain();
    this.output.connect(listener.input);
    this.gain.disconnect(listener.input);
    this.gain.channelCount = buffer.numberOfChannels;
    this.gain.channelCountMode = 'explicit';
    this.gain.channelInterpretation = 'discrete';
    this.gain.connect(this.splitter);
    for (const sign of [-1, 1])
      for (const ring of [-1, 1]) {
        const z = sign * Math.sqrt((3 + ring * 2 * Math.sqrt(6 / 5)) / 7);
        const weight = (18 - ring * Math.sqrt(30)) / 36 / 16;
        for (let az = 0; az < 8; az++) {
          const angle = (az * Math.PI) / 4,
            radius = Math.sqrt(1 - z * z);
          const direction: [number, number, number] = [radius * Math.cos(angle), radius * Math.sin(angle), z];
          const node = context.createPanner();
          node.panningModel = 'HRTF';
          node.rolloffFactor = 0;
          node.channelCount = 1;
          node.channelCountMode = 'explicit';
          node.connect(this.output);
          this.speakers.push({ node, direction });
          const basis = ambixBasis(order, direction);
          for (let channel = 0; channel < basis.length; channel++) {
            const gain = context.createGain();
            gain.gain.value = weight * (2 * Math.floor(Math.sqrt(channel)) + 1) * basis[channel];
            gain.channelCount = 1;
            gain.channelCountMode = 'explicit';
            gain.channelInterpretation = 'discrete';
            this.splitter.connect(gain, channel);
            gain.connect(node);
            this.matrix.push(gain);
          }
        }
      }
    this.update();
    this.setBuffer(buffer);
  }

  /** Replace with the same AmbiX order. Validate before interrupting a playing bed. */
  override setBuffer(buffer: AudioBuffer): this {
    if (orderOf(buffer) !== this.order)
      throw fault('unsupported', 'Replacement AmbiX order differs; create another BinauralAudio for that order');
    return super.setBuffer(buffer);
  }

  /** Last stereo node, for analysers or wet sends. */
  override getOutput(): AudioNode {
    return this.output ?? this.gain;
  }

  /** Active field rotation in engine world coordinates, normalized [x,y,z,w]. */
  setRotation(value: readonly [number, number, number, number]): this {
    if (this.isDisposed) throw fault('disposed', 'BinauralAudio is disposed; create a new bed');
    if (value.length !== 4 || [0, 1, 2, 3].some((i) => !Number.isFinite(value[i])))
      throw rangeError('Field rotation needs four finite components; use [0,0,0,1] for identity', 'state');
    const scale = Math.max(...value.map(Math.abs));
    if (!scale) throw rangeError('Field rotation must be nonzero; use [0,0,0,1] for identity', 'state');
    const q = value.map((v) => v / scale),
      length = Math.hypot(...q);
    this.rotation = q.map((v) => v / length);
    this.update();
    return this;
  }

  /** Translate the distant speaker sphere with the listener; native HRTFs follow listener orientation. */
  override update(): void {
    if (this.isDisposed) return;
    const [x, y, z, w] = this.rotation,
      position = this.listener.position;
    for (const {
      node,
      direction: [front, left, up],
    } of this.speakers) {
      const d = [-left, up, -front];
      const tx = 2 * (y * d[2] - z * d[1]),
        ty = 2 * (z * d[0] - x * d[2]),
        tz = 2 * (x * d[1] - y * d[0]);
      const rotated = [
        d[0] + w * tx + y * tz - z * ty,
        d[1] + w * ty + z * tx - x * tz,
        d[2] + w * tz + x * ty - y * tx,
      ];
      [node.positionX, node.positionY, node.positionZ].forEach((param, i) => {
        const value = position[i] + rotated[i];
        if (param.value !== value) smoothParam(param, value, this.context, this.listener.smoothing, !this.written);
      });
    }
    this.written = true;
  }

  /** Disconnect the entire HRTF graph and source. Idempotent; listener teardown also disposes. */
  override dispose(): void {
    super.dispose();
    this.splitter?.disconnect();
    for (const gain of this.matrix) gain.disconnect();
    for (const { node } of this.speakers) node.disconnect();
    this.output?.disconnect();
  }
}
