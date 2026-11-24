/// <reference lib="esnext.disposable" preserve="true" />
import type { AudioListener } from './listener.js';
import { smoothParam } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

/** First-order ACN/SN3D playback settings. */
export interface AmbisonicAudioOptions {
  /** Channel convention. Default 'ambix': W,Y,Z,X in SN3D. Other conventions raise unsupported. */
  format?: 'ambix';
  /** Loop the complete buffer. Default true. */
  loop?: boolean;
  /** Linear output gain, 0..1. Default 1. */
  volume?: number;
  /** Matrix/gain smoothing time constant in seconds. Default listener.smoothing. */
  smoothing?: number;
}

/**
 * First-order AmbiX bed decoded to two virtual cardioids at +/-30 degrees.
 * Follows listener orientation, supports full 3D field rotation, and ignores listener translation.
 */
export class AmbisonicAudio {
  /** Shared four-channel W,Y,Z,X buffer. No cloning or format inference. */
  readonly buffer: AudioBuffer;
  private readonly listener: AudioListener;
  private readonly splitter: ChannelSplitterNode;
  private readonly merger: ChannelMergerNode;
  private readonly output: GainNode;
  private readonly matrix: GainNode[] = [];
  private readonly values = new Float64Array(8).fill(NaN);
  private readonly forward = [0, 0, -1];
  private readonly left = [-1, 0, 0];
  private rotation = [0,0,0,1];
  private readonly smoothing: number;
  private readonly loop: boolean;
  private level: number;
  private source: AudioBufferSourceNode | null = null;
  private disposed = false;

  constructor(listener: AudioListener, buffer: AudioBuffer, options: AmbisonicAudioOptions = {}) {
    this.listener = listener;
    if ((options.format ?? 'ambix') !== 'ambix' || buffer?.numberOfChannels !== 4)
      throw fault('unsupported', 'AmbisonicAudio needs four-channel first-order AmbiX ACN/SN3D; convert FuMa/HOA or choose the correct buffer');
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0)
      throw fault('state', 'AmbisonicAudio needs a decoded positive-duration buffer; use listener.load(url, {signal})');
    this.buffer = buffer;
    this.loop = options.loop ?? true;
    if (typeof this.loop !== 'boolean') throw fault('state', 'Ambisonic loop needs a boolean; choose true or false');
    this.level = this.validVolume(options.volume ?? 1);
    this.smoothing = options.smoothing ?? listener.smoothing;
    if (!Number.isFinite(this.smoothing) || this.smoothing < 0)
      throw rangeError('Ambisonic smoothing must be finite and nonnegative; use seconds or 0 for immediate changes', 'state');
    const context = listener.context;
    if (typeof context.createChannelSplitter !== 'function' || typeof context.createChannelMerger !== 'function')
      throw fault('unsupported', 'AmbisonicAudio needs Web Audio channel splitters/mergers; use a supporting AudioContext');
    this.splitter = context.createChannelSplitter(4);
    this.merger = context.createChannelMerger(2);
    this.splitter.channelInterpretation = 'discrete';
    this.output = context.createGain();
    this.output.gain.value = this.level;
    for (let ear=0;ear<2;ear++) for(let channel=0;channel<4;channel++) {
      const gain=context.createGain();
      gain.channelCount=1;gain.channelCountMode='explicit';gain.channelInterpretation='discrete';
      this.splitter.connect(gain,channel);gain.connect(this.merger,0,ear);this.matrix.push(gain);
    }
    this.merger.connect(this.output).connect(listener.input);
    listener.addSource(this);
    try { this.update(); } catch(error) { this.dispose();throw error; }
  }

  /** True while a source is playing or scheduled. */
  get isPlaying(): boolean { return this.source !== null; }
  /** Linear output gain 0..1, independent of field orientation. */
  get volume(): number { return this.level; }
  set volume(value: number) {
    this.assertLive();this.level=this.validVolume(value);
    smoothParam(this.output.gain,value,this.listener.context,this.smoothing);
  }

  /** Start at audio-clock time at (default now), from buffer phase zero. Already playing raises state. */
  play(at=this.listener.context.currentTime): this {
    this.assertLive();
    if (!Number.isFinite(at) || at < this.listener.context.currentTime)
      throw rangeError('Ambisonic start needs a finite time at or after now; use context.currentTime', 'state');
    if (this.source) throw fault('state','Ambisonic bed is already playing; stop before restarting');
    const source=this.listener.context.createBufferSource();
    source.buffer=this.buffer;source.loop=this.loop;source.connect(this.splitter);
    source.onended=()=>{if(this.source===source){source.disconnect();this.source=null;}};
    source.start(at);this.source=source;return this;
  }
  /** Stop and disconnect the current source, including a scheduled start. */
  stop(): void {
    this.assertLive();
    if(this.source){this.source.onended=null;this.source.stop();this.source.disconnect();this.source=null;}
  }

  /** World-space active field rotation as [x,y,z,w] quaternion. Normalized and copied; identity faces -Z. */
  setRotation(value: readonly [number,number,number,number]): this {
    this.assertLive();
    if(value.length!==4 || [0,1,2,3].some(i=>!Number.isFinite(value[i])))
      throw rangeError('Ambisonic rotation needs four finite quaternion components; pass [x,y,z,w]', 'state');
    const scale=Math.max(...value.map(Math.abs));
    if(scale===0)throw rangeError('Ambisonic rotation must be nonzero; use [0,0,0,1] for identity', 'state');
    const q=value.map(v=>v/scale),length=Math.hypot(...q);
    this.rotation=q.map(v=>v/length);this.update();return this;
  }

  /** Update from listener forward/up directions. Listener frame updates call this automatically, including XR poses. */
  update(): void {
    this.assertLive();
    const pose=this.listener.forward,u=this.listener.up;
    const candidate=[u[1]*pose[2]-u[2]*pose[1],u[2]*pose[0]-u[0]*pose[2],u[0]*pose[1]-u[1]*pose[0]];
    const length=Math.hypot(...candidate),f=this.forward,left=this.left;
    // Retain the last independent basis; a bed created at a degenerate pose starts facing -Z, +Y up.
    if(Number.isFinite(length)&&length>=1e-12)for(let i=0;i<3;i++) {
      left[i]=candidate[i]/length;f[i]=pose[i];
    }
    const [x,y,z,w]=this.rotation;
    for(let ear=0;ear<2;ear++) {
      const sign=ear===0?1:-1;
      const d=[0,1,2].map(i=>f[i]*Math.sqrt(3)/2+sign*left[i]/2);
      // Apply inverse field quaternion to the world-space virtual microphone direction.
      const tx=2*(-y*d[2]+z*d[1]),ty=2*(-z*d[0]+x*d[2]),tz=2*(-x*d[1]+y*d[0]);
      const local=[d[0]+w*tx-y*tz+z*ty,d[1]+w*ty-z*tx+x*tz,d[2]+w*tz-x*ty+y*tx];
      const coefficients=[0.5,-local[0]/2,local[1]/2,-local[2]/2];
      coefficients.forEach((value,channel)=>{
        const i=ear*4+channel;
        if(value!==this.values[i])smoothParam(this.matrix[i].gain,value,this.listener.context,this.smoothing,Number.isNaN(this.values[i]));
        this.values[i]=value;
      });
    }
  }
  /** Release sources and decoder graph. Shared buffers remain usable. Idempotent; listener teardown also disposes. */
  dispose(): void {
    if(this.disposed)return;
    this.stop();this.disposed=true;this.listener.removeSource(this);
    this.splitter.disconnect();for(const gain of this.matrix)gain.disconnect();this.merger.disconnect();this.output.disconnect();
  }
  private validVolume(value:number):number {
    if(!Number.isFinite(value)||value<0||value>1)throw rangeError('Ambisonic volume needs a finite value in 0..1; choose a linear output gain','state');
    return value;
  }
  private assertLive():void {if(this.disposed)throw fault('disposed','AmbisonicAudio is disposed; create a new bed');}
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void {this.dispose();}
}
