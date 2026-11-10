import { MargoError } from '@margoengine/math/errors';
import type { Binding } from './index.js';
import type { ControlHost } from './motion.js';

/** Structural WebXR source, compatible with native XRInputSource without an ambient XR dependency. */
export interface InputXRSource {
  handedness: 'left' | 'right' | 'none';
  gamepad?: {
    readonly axes: readonly number[];
    readonly buttons: readonly { value: number; pressed: boolean; touched: boolean }[];
  } | null;
  hand?: { get(name: string): object | undefined } | null;
  gripSpace?: object | null;
}
/** Structural session exposing native input sources and select/squeeze lifecycle events. */
export interface InputXRSession extends EventTarget {
  readonly inputSources: Iterable<InputXRSource>;
}
/** Structural frame used only for optional hand joints and grip pose channels. */
export interface InputXRFrame {
  getJointPose?(joint: object, space: object): { transform: { position: { x: number; y: number; z: number } } } | null;
  getPose?(
    grip: object,
    space: object,
  ): {
    transform: {
      position: { x: number; y: number; z: number };
      orientation: { x: number; y: number; z: number; w: number };
    };
  } | null;
}
/** Source filter. Index selects the nth source matching handedness in session order (default 0). */
export interface XRBindingSource {
  /** Default any hand. */
  hand?: 'left' | 'right' | 'none';
  /** Default 0. */
  source?: number;
  /** Default 1, applied by the ordinary Input binding. */
  scale?: number;
}
/** XR-specific descriptors, converted by XRBindings.binding or map to standard replayable control bindings. */
export type XRBinding = XRBindingSource &
  (
    | { type: 'xr-button'; index: number; value?: 'value' | 'pressed' | 'touched' }
    | { type: 'xr-axis'; index: number }
    | { type: 'xr-select' | 'xr-grip' | 'xr-pinch' }
    | { type: 'xr-grip-pose'; component: 'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw' | 'tracked' }
  );
/** Pinch hysteresis uses joint-centre distances in metres. */
export interface XRBindingsOptions {
  /** Distance that starts a pinch. Default 0.02 m. */
  pinchStart?: number;
  /** Distance that ends a pinch. Default 0.03 m. Must exceed pinchStart. */
  pinchEnd?: number;
  /** Control id shared by binding() and attach(). Default 'xr'. Use distinct ids for multiple publishers. */
  id?: string;
}
/**
 * Publish XR buttons, axes, select, squeeze/grip and hysteretic hand pinch into any Input or VectorInput.
 * Call update(frame, referenceSpace) before input.update(). No frame is needed for controllers or select events.
 * Record the Input with InputRecorder, including binding-specific interactions; replay needs no XR session.
 */
export class XRBindings {
  private readonly entries: { binding: XRBinding; axis: string }[] = [];
  private readonly hosts = new Map<ControlHost, Record<string, number>>();
  private readonly selecting = new Set<InputXRSource>();
  private readonly squeezing = new Set<InputXRSource>();
  private readonly selectTaps = new Set<InputXRSource>();
  private readonly gripTaps = new Set<InputXRSource>();
  private readonly pinching = new Set<InputXRSource>();
  private readonly cleanups: (() => void)[] = [];
  private readonly start: number;
  private readonly end: number;
  private readonly id: string;
  private disposed = false;
  private ended = false;
  /** @throws RangeError for invalid distances; TypeError for an empty control id. */
  constructor(
    private readonly session: InputXRSession,
    { pinchStart = 0.02, pinchEnd = 0.03, id = 'xr' }: XRBindingsOptions = {},
  ) {
    if (!Number.isFinite(pinchStart + pinchEnd) || pinchStart <= 0 || pinchEnd <= pinchStart)
      throw new RangeError('Invalid pinch distances; use 0 < pinchStart < pinchEnd in metres');
    if (!id) throw new TypeError('Empty XR control id; give the publisher a unique name');
    this.start = pinchStart;
    this.end = pinchEnd;
    this.id = id;
    for (const [type, held, taps] of [
      ['select', this.selecting, this.selectTaps],
      ['squeeze', this.squeezing, this.gripTaps],
    ] as const) {
      const onStart = (event: Event) => {
        const source = (event as Event & { inputSource: InputXRSource }).inputSource;
        held.add(source);
        taps.add(source);
      };
      const onEnd = (event: Event) => held.delete((event as Event & { inputSource: InputXRSource }).inputSource);
      this.listen(`${type}start`, onStart);
      this.listen(`${type}end`, onEnd);
    }
    this.listen('end', () => {
      this.ended = true;
      this.clear();
      this.publishZero();
    });
    this.listen('inputsourceschange', () => {
      const live = new Set(session.inputSources);
      for (const set of [this.selecting, this.squeezing, this.selectTaps, this.gripTaps, this.pinching])
        for (const source of set) if (!live.has(source)) set.delete(source);
    });
  }
  private listen(type: string, callback: EventListener): void {
    this.session.addEventListener(type, callback);
    this.cleanups.push(() => this.session.removeEventListener(type, callback));
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'XR bindings are disposed; create a new XRBindings');
  }
  /** Convert a typed XR descriptor to a standard Input binding. @throws TypeError for an invalid descriptor. */
  binding(binding: XRBinding): Binding {
    this.check();
    if (
      !binding ||
      !['xr-button', 'xr-axis', 'xr-select', 'xr-grip', 'xr-pinch', 'xr-grip-pose'].includes(binding.type) ||
      !Number.isInteger(binding.source ?? 0) ||
      (binding.source ?? 0) < 0 ||
      !Number.isFinite(binding.scale ?? 1) ||
      (binding.hand !== undefined && !['left', 'right', 'none'].includes(binding.hand)) ||
      ((binding.type === 'xr-button' || binding.type === 'xr-axis') &&
        (!Number.isInteger(binding.index) || binding.index < 0)) ||
      (binding.type === 'xr-button' &&
        binding.value !== undefined &&
        !['value', 'pressed', 'touched'].includes(binding.value)) ||
      (binding.type === 'xr-grip-pose' &&
        !['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'tracked'].includes(binding.component))
    )
      throw new TypeError(
        'Invalid XR binding; use a supported type, nonnegative integer source/index and finite scale',
      );
    const axis = `b${this.entries.length}`;
    this.entries.push({ binding: { ...binding }, axis });
    return { type: 'control', id: this.id, axis, scale: binding.scale };
  }
  /** Convert a mixed native/XR action map, ready for the Input constructor or importBindings. */
  map(actions: Readonly<Record<string, readonly (XRBinding | Binding)[]>>): Record<string, Binding[]> {
    this.check();
    return Object.fromEntries(
      Object.entries(actions).map(([name, bindings]) => [
        name,
        bindings.map((binding) =>
          binding.type.startsWith('xr-') ? this.binding(binding as XRBinding) : (binding as Binding),
        ),
      ]),
    );
  }
  /** Publish to an Input's controls. Returns a detach function; a host may only attach once. */
  attach(host: ControlHost): () => void {
    this.check();
    if (this.hosts.has(host)) throw new TypeError('XR host already attached; detach it before attaching again');
    this.hosts.set(host, host.control(this.id));
    return () => {
      if (this.hosts.delete(host)) host.removeControl(this.id);
    };
  }
  /** Sample sources; missing/untracked/disconnected inputs read zero. @throws MargoError after disposal. */
  update(frame?: InputXRFrame, space?: object): void {
    this.check();
    const sources = this.ended ? [] : Array.from(this.session.inputSources),
      live = new Set(sources);
    for (const set of [this.selecting, this.squeezing, this.selectTaps, this.gripTaps, this.pinching])
      for (const source of set) if (!live.has(source)) set.delete(source);
    for (const source of sources) {
      const thumb = source.hand?.get('thumb-tip'),
        index = source.hand?.get('index-finger-tip');
      const a = thumb && space ? frame?.getJointPose?.(thumb, space)?.transform.position : undefined;
      const b = index && space ? frame?.getJointPose?.(index, space)?.transform.position : undefined;
      const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
      if (distance <= (this.pinching.has(source) ? this.end : this.start)) this.pinching.add(source);
      else this.pinching.delete(source);
    }
    for (const { binding, axis } of this.entries) {
      const source = sources.filter((s) => binding.hand === undefined || s.handedness === binding.hand)[
        binding.source ?? 0
      ];
      let value = 0;
      if (source)
        switch (binding.type) {
          case 'xr-button': {
            const button = source.gamepad?.buttons[binding.index];
            value = Number(button?.[binding.value ?? 'value'] ?? 0);
            break;
          }
          case 'xr-axis':
            value = source.gamepad?.axes[binding.index] ?? 0;
            break;
          case 'xr-select':
            value = +(this.selecting.has(source) || this.selectTaps.has(source));
            break;
          case 'xr-grip':
            value = +(this.squeezing.has(source) || this.gripTaps.has(source));
            break;
          case 'xr-pinch':
            value = +this.pinching.has(source);
            break;
          case 'xr-grip-pose': {
            const pose = source.gripSpace && space ? frame?.getPose?.(source.gripSpace, space) : null;
            value =
              binding.component === 'tracked'
                ? +!!pose
                : pose
                  ? binding.component.startsWith('q')
                    ? pose.transform.orientation[binding.component.slice(1) as 'x' | 'y' | 'z' | 'w']
                    : pose.transform.position[binding.component as 'x' | 'y' | 'z']
                  : 0;
            break;
          }
        }
      for (const values of this.hosts.values()) values[axis] = Number.isFinite(value) ? value : 0;
    }
    this.selectTaps.clear();
    this.gripTaps.clear();
  }
  private clear(): void {
    for (const set of [this.selecting, this.squeezing, this.selectTaps, this.gripTaps, this.pinching]) set.clear();
  }
  private publishZero(): void {
    for (const values of this.hosts.values()) for (const { axis } of this.entries) values[axis] = 0;
  }
  /** Remove all listeners and published controls; safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const cleanup of this.cleanups) cleanup();
    for (const host of this.hosts.keys()) host.removeControl(this.id);
    this.hosts.clear();
  }
  /** Deterministic disposal for using declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
