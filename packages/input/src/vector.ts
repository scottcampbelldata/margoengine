import { Input, type Binding, type InputOptions } from './index.js';

/** Two scalar binding composites form one stick. Positive y is down, matching gamepads. */
export interface VectorBinding {
  /** Bindings summed into x, before the radial processor. */
  x: readonly Binding[];
  /** Bindings summed into y, before the radial processor. */
  y: readonly Binding[];
  /** Inner radius, rescaled continuously to unit magnitude. Default 0.15. */
  deadzone?: number;
  /** Convert every nonzero result to unit length. Default false: preserve analog magnitude. */
  normalize?: boolean;
}
/** Reused vector state, refreshed by VectorInput.update. */
export interface VectorActionState {
  x: number;
  y: number;
  magnitude: number;
  down: boolean;
  pressed: boolean;
  released: boolean;
}
/** Options for VectorInput. Axis deadzones are replaced by each vector's radial deadzone. */
export interface VectorInputOptions extends Omit<InputOptions, 'deadzone'> {
  /** Additional scalar actions, sharing devices, contexts and replay. Default none. */
  actions?: Readonly<Record<string, readonly Binding[]>>;
}
/** WASD composite with a downward-positive y axis. Opposite keys cancel. */
export function wasd(): VectorBinding {
  return {
    x: [
      { type: 'key', code: 'KeyD' },
      { type: 'key', code: 'KeyA', scale: -1 },
    ],
    y: [
      { type: 'key', code: 'KeyS' },
      { type: 'key', code: 'KeyW', scale: -1 },
    ],
  };
}
/**
 * Named vector actions on the standard Input device/context/rebinding/recording path.
 * Scalar channels are named `<name>.x` and `<name>.y`; contexts and rebinding use those names.
 * InputRecorder records this object directly and InputReplay plays into it unchanged.
 */
export class VectorInput extends Input {
  private readonly vectors = new Map<string, { binding: VectorBinding; state: VectorActionState }>();
  /** @throws RangeError for an invalid deadzone; TypeError for empty names, axes or channel collisions. */
  constructor(vectors: Readonly<Record<string, VectorBinding>>, { actions = {}, ...options }: VectorInputOptions = {}) {
    const channels = { ...actions };
    for (const [name, binding] of Object.entries(vectors)) {
      if (!name || !binding?.x?.length || !binding?.y?.length || `${name}.x` in channels || `${name}.y` in channels)
        throw new TypeError(
          'Invalid vector action; use a name, two nonempty binding arrays and unique scalar channels',
        );
      const deadzone = binding.deadzone ?? 0.15;
      if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1)
        throw new RangeError('Invalid radial deadzone; use a finite radius in [0, 1)');
      channels[`${name}.x`] = binding.x;
      channels[`${name}.y`] = binding.y;
    }
    super(channels, { ...options, deadzone: 0 });
    for (const [name, binding] of Object.entries(vectors))
      this.vectors.set(name, {
        binding: { ...binding },
        state: { x: 0, y: 0, magnitude: 0, down: false, pressed: false, released: false },
      });
  }
  /** @throws TypeError for an unknown name; define it in the constructor's vector map. */
  vector(name: string): Readonly<VectorActionState> {
    const vector = this.vectors.get(name);
    if (!vector) throw new TypeError('Unknown vector action; define it in the vector map first');
    return vector.state;
  }
  /** Sample devices once, then apply one radial deadzone and unit-circle clamp per vector. */
  override update(): void {
    super.update();
    for (const [name, { binding, state }] of this.vectors) {
      const x = this.state(`${name}.x`).value,
        y = this.state(`${name}.y`).value;
      const length = Math.hypot(x, y),
        deadzone = binding.deadzone ?? 0.15;
      const magnitude =
        length <= deadzone ? 0 : binding.normalize ? 1 : (Math.min(1, length) - deadzone) / (1 - deadzone);
      const down = magnitude > 1e-6;
      state.pressed = down && !state.down;
      state.released = !down && state.down;
      state.down = down;
      state.x = magnitude ? (x / length) * magnitude : 0;
      state.y = magnitude ? (y / length) * magnitude : 0;
      state.magnitude = magnitude;
    }
  }
  /** Reset devices and vector state immediately, including on window blur. */
  override reset(): void {
    super.reset();
    for (const { state } of this.vectors?.values() ?? []) {
      state.x = state.y = state.magnitude = 0;
      state.released = state.down;
      state.down = state.pressed = false;
    }
  }
}
