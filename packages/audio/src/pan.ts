import { Audio, type AudioOptions } from '@margoengine/audio';
import type { AudioListener } from '@margoengine/audio';
import { smoothParam } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Non-positional stereo playback options. */
export interface StereoAudioOptions extends AudioOptions {
  /** Equal-power pan from -1 (left) to 1 (right). Default 0. */
  pan?: number;
}

const validPan = (value: number): number => {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw rangeError('Pan must be finite in -1..1; choose a stereo position', 'state');
  return value;
};
const validate = (options: StereoAudioOptions): StereoAudioOptions => {
  validPan(options.pan ?? 0);
  return options;
};

/** A non-positional sound through a native StereoPannerNode, including stereo input. */
export class StereoAudio extends Audio {
  /** Native panner; its AudioParam also supports sample-accurate automation. */
  readonly panner: StereoPannerNode;
  private panValue: number;

  constructor(listener: AudioListener, options: StereoAudioOptions = {}) {
    validate(options);
    if (typeof listener.context.createStereoPanner !== 'function')
      throw fault('unsupported', 'Stereo panning needs createStereoPanner; use a supporting Web Audio context');
    super(listener, options);
    this.panValue = options.pan ?? 0;
    this.panner = this.context.createStereoPanner();
    this.panner.pan.setValueAtTime(this.panValue, this.context.currentTime);
    this.gain.disconnect(listener.input);
    this.gain.connect(this.panner).connect(listener.input);
  }

  /** Finite stereo pan -1..1, smoothed using listener.smoothing. */
  get pan(): number {
    return this.panValue;
  }
  set pan(value: number) {
    if (this.isDisposed) throw fault('disposed', 'StereoAudio is disposed; create a new sound');
    this.panValue = validPan(value);
    smoothParam(this.panner.pan, value, this.context, this.listener.smoothing);
  }

  /** Last graph node, for analysers and wet sends. */
  override getOutput(): AudioNode {
    return this.panner ?? this.gain;
  }

  /** Release the source and stereo graph; safe to call repeatedly. */
  override dispose(): void {
    super.dispose();
    this.panner?.disconnect();
  }
}
