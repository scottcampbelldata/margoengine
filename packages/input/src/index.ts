/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
/**
 * One source feeding an action. Each sample is multiplied by `scale` (finite, default 1) and summed into the action.
 * - `key`: `KeyboardEvent.code` (non-empty); 1 while held.
 * - `mouse`: button 0..4; 1 while held.
 * - `pointer`: movement on `x`/`y` (pixels) or `wheel` (`WheelEvent.deltaY`) since the last update.
 * - `gamepad-axis` / `gamepad-button`: axis or button `index` (integer >= 0) of gamepad `gamepad` (default 0);
 *   axes get the deadzone applied.
 * - `touch`: a control from `createStick`/`bindTouchButton` by `id`; `axis` reads a stick in [-1, 1], otherwise 1 while down.
 */
export type Binding =
  | { type: 'key'; code: string; scale?: number }
  | { type: 'mouse'; button: number; scale?: number }
  | { type: 'pointer'; axis: 'x' | 'y' | 'wheel'; scale?: number }
  | { type: 'gamepad-axis' | 'gamepad-button'; index: number; gamepad?: number; scale?: number }
  | { type: 'touch'; id: string; axis?: 'x' | 'y'; scale?: number };
/** Per-action result of the last {@link Input.update}. The object is reused across updates. */
export interface ActionState {
  /** Sum of the scaled binding samples, clamped to [-1, 1]. */
  value: number;
  /** True while `value` is non-zero (magnitude above 1e-6). */
  down: boolean;
  /** True on the update where `down` became true. */
  pressed: boolean;
  /** True on the update where `down` became false. */
  released: boolean;
}
/** Options for the {@link Input} constructor. */
export interface InputOptions {
  /** Where keyboard, pointer, wheel and blur listeners attach. Default `window`. */
  target?: EventTarget;
  /** Gamepad source. Default `navigator.getGamepads()`, or an empty list where unsupported. */
  gamepads?: () => readonly (Gamepad | null)[];
  /** Gamepad axis deadzone in [0, 1); axes rescale to fill the rest of the range. Default 0.15. */
  deadzone?: number;
}

/** Semantic action state is reused; sample once per simulation tick. */
export class Input {
  private readonly states = new Map<string, ActionState>();
  private readonly samples: { name: string; state: ActionState }[] = [];
  private readonly keys = new Set<string>();
  private buttons = 0;
  private readonly motion = { x: 0, y: 0, wheel: 0 };
  private readonly touch = new Map<string, { x: number; y: number; down: boolean; reset?: () => void }>();
  private readonly cleanups: (() => void)[] = [];
  private readonly gamepads: () => readonly (Gamepad | null)[];
  private readonly deadzone: number;
  private disposed = false;
  /**
   * Map named actions to bindings and start listening on `target`. Key presses inside form fields are ignored.
   * @throws RangeError for an invalid deadzone or a non-function `gamepads`.
   * @throws TypeError for an empty action name, an action without bindings, or an invalid binding.
   */
  constructor(
    readonly actions: Readonly<Record<string, readonly Binding[]>>,
    { target = window, gamepads = () => navigator.getGamepads?.() ?? [], deadzone = 0.15 }: InputOptions = {},
  ) {
    if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1 || typeof gamepads !== 'function')
      throw new RangeError('Invalid input options');
    this.gamepads = gamepads;
    this.deadzone = deadzone;
    for (const [name, bindings] of Object.entries(actions)) {
      if (!name || !bindings.length) throw new TypeError('Actions need names and bindings');
      for (const binding of bindings) {
        if (
          !Number.isFinite(binding.scale ?? 1) ||
          !['key', 'mouse', 'pointer', 'gamepad-axis', 'gamepad-button', 'touch'].includes(binding.type)
        )
          throw new TypeError('Invalid action binding');
        if (
          (binding.type === 'key' && !binding.code) ||
          (binding.type === 'mouse' &&
            (!Number.isInteger(binding.button) || binding.button < 0 || binding.button > 4)) ||
          ((binding.type === 'gamepad-axis' || binding.type === 'gamepad-button') &&
            (!Number.isInteger(binding.index) ||
              binding.index < 0 ||
              !Number.isInteger(binding.gamepad ?? 0) ||
              (binding.gamepad ?? 0) < 0)) ||
          (binding.type === 'pointer' && !['x', 'y', 'wheel'].includes(binding.axis)) ||
          (binding.type === 'touch' &&
            (!binding.id || (binding.axis !== undefined && binding.axis !== 'x' && binding.axis !== 'y')))
        )
          throw new TypeError('Invalid action binding');
      }
      this.states.set(name, { value: 0, down: false, pressed: false, released: false });
      this.samples.push({ name, state: this.states.get(name)! });
    }
    try {
      this.listen(target, 'keydown', (event) => {
        const e = event as KeyboardEvent,
          node = e.composedPath()[0] as Element;
        if (!node?.closest?.('input,textarea,select,[contenteditable=true]')) this.keys.add(e.code);
      });
      this.listen(target, 'keyup', (event) => this.keys.delete((event as KeyboardEvent).code));
      this.listen(target, 'pointerdown', (event) => {
        if ((event as PointerEvent).pointerType !== 'touch') this.buttons |= 1 << (event as PointerEvent).button;
      });
      this.listen(target, 'pointerup', (event) => {
        this.buttons &= ~(1 << (event as PointerEvent).button);
      });
      this.listen(target, 'pointermove', (event) => {
        const e = event as PointerEvent;
        if (e.pointerType !== 'touch') {
          this.motion.x += e.movementX || 0;
          this.motion.y += e.movementY || 0;
        }
      });
      this.listen(target, 'wheel', (event) => {
        this.motion.wheel += (event as WheelEvent).deltaY;
      });
      this.listen(target, 'blur', () => this.reset());
      this.listen(target, 'pointercancel', () => this.reset());
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }
  /**
   * Live state of `action`, refreshed by each {@link Input.update}.
   * @throws TypeError for an unknown action.
   */
  state(action: string): Readonly<ActionState> {
    const state = this.states.get(action);
    if (!state) throw new TypeError('Unknown input action');
    return state;
  }
  /**
   * Sample every binding into its action state and clear the accumulated pointer motion. Call once per tick.
   * @throws MargoError `'disposed'` after {@link Input.dispose}.
   */
  update(): void {
    if (this.disposed) throw new MargoError('disposed', 'Input is disposed; create a new Input');
    const pads = this.gamepads();
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i],
        name = sample.name,
        state = sample.state;
      let value = 0;
      const bindings = this.actions[name];
      for (let j = 0; j < bindings.length; j++) {
        const binding = bindings[j];
        let sample = 0;
        switch (binding.type) {
          case 'key':
            sample = +this.keys.has(binding.code);
            break;
          case 'mouse':
            sample = +!!(this.buttons & (1 << binding.button));
            break;
          case 'pointer':
            sample = this.motion[binding.axis];
            break;
          case 'touch': {
            const stick = this.touch.get(binding.id);
            sample = binding.axis ? (stick?.[binding.axis] ?? 0) : +(stick?.down ?? false);
            break;
          }
          case 'gamepad-button':
            sample = pads[binding.gamepad ?? 0]?.buttons[binding.index]?.value ?? 0;
            break;
          case 'gamepad-axis': {
            const axis = pads[binding.gamepad ?? 0]?.axes[binding.index] ?? 0;
            sample =
              Math.abs(axis) <= this.deadzone
                ? 0
                : (Math.sign(axis) * (Math.abs(axis) - this.deadzone)) / (1 - this.deadzone);
            break;
          }
        }
        if (Number.isFinite(sample)) value += sample * (binding.scale ?? 1);
      }
      value = Math.max(-1, Math.min(1, value));
      const down = Math.abs(value) > 1e-6;
      state.pressed = down && !state.down;
      state.released = !down && state.down;
      state.down = down;
      state.value = value;
    }
    this.motion.x = this.motion.y = this.motion.wheel = 0;
  }
  /**
   * Append a 120 px on-screen touch stick to `parent`, readable through `touch` bindings with this `id`.
   * Removed on dispose.
   * @throws TypeError when disposed, `id` is empty, or `id` is already used by a touch control.
   */
  createStick(parent: HTMLElement, id: string): HTMLDivElement {
    if (this.disposed || !id || this.touch.has(id)) throw new TypeError('Invalid or duplicate touch control');
    const doc = parent.ownerDocument,
      element = doc.createElement('div'),
      knob = doc.createElement('div'),
      state = { x: 0, y: 0, down: false };
    let pointer: number | null = null;
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', `${id} touch stick`);
    element.style.cssText =
      'position:relative;width:120px;height:120px;border:2px solid #747c86;border-radius:50%;touch-action:none;background:#20222644';
    knob.style.cssText =
      'position:absolute;left:40px;top:40px;width:36px;height:36px;border:2px solid white;border-radius:50%;background:#167f68;pointer-events:none';
    element.append(knob);
    parent.append(element);
    this.touch.set(id, state);
    const move = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      const rect = element.getBoundingClientRect(),
        radius = Math.min(rect.width, rect.height) / 2;
      if (!radius) return;
      const x = (e.clientX - rect.left - rect.width / 2) / radius,
        y = (e.clientY - rect.top - rect.height / 2) / radius,
        length = Math.max(1, Math.hypot(x, y));
      state.x = x / length;
      state.y = y / length;
      knob.style.transform = `translate(${state.x * 40}px,${state.y * 40}px)`;
    };
    this.listen(element, 'pointerdown', (event) => {
      if (pointer !== null) return;
      const e = event as PointerEvent;
      pointer = e.pointerId;
      state.down = true;
      element.setPointerCapture?.(pointer);
      move(event);
    });
    this.listen(element, 'pointermove', move);
    const reset = () => {
      pointer = null;
      state.down = false;
      state.x = state.y = 0;
      knob.style.transform = '';
    };
    (state as typeof state & { reset: () => void }).reset = reset;
    const release = (event: Event) => {
      if ((event as PointerEvent).pointerId !== pointer) return;
      reset();
    };
    this.listen(element, 'pointerup', release);
    this.listen(element, 'pointercancel', release);
    this.listen(element, 'lostpointercapture', release);
    this.cleanups.push(() => {
      this.touch.delete(id);
      element.remove();
    });
    return element;
  }
  /**
   * Make an existing element a touch button for `touch` bindings with this `id`; pointer, Space and Enter press it.
   * @throws TypeError when disposed, `id` is empty, or `id` is already used by a touch control.
   */
  bindTouchButton(element: HTMLElement, id: string): void {
    if (this.disposed || !id || this.touch.has(id)) throw new TypeError('Invalid or duplicate touch control');
    const state = { x: 0, y: 0, down: false };
    this.touch.set(id, state);
    let pointer: number | null = null,
      key = false;
    const reset = () => {
      pointer = null;
      key = false;
      state.down = false;
    };
    (state as typeof state & { reset: () => void }).reset = reset;
    this.listen(element, 'pointerdown', (event) => {
      if (pointer !== null) return;
      pointer = (event as PointerEvent).pointerId;
      state.down = true;
      element.setPointerCapture?.(pointer);
    });
    const release = (event: Event) => {
      if ((event as PointerEvent).pointerId !== pointer) return;
      pointer = null;
      state.down = key;
    };
    this.listen(element, 'pointerup', release);
    this.listen(element, 'pointercancel', release);
    this.listen(element, 'lostpointercapture', release);
    this.listen(element, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === ' ' || (event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        key = true;
        state.down = true;
      }
    });
    this.listen(element, 'keyup', (event) => {
      if ((event as KeyboardEvent).key === ' ' || (event as KeyboardEvent).key === 'Enter') {
        key = false;
        state.down = pointer !== null;
      }
    });
    this.listen(element, 'blur', reset);
    this.cleanups.push(() => this.touch.delete(id));
  }
  /**
   * Play a dual-rumble effect; resolves false when the gamepad has no vibration actuator.
   * @param duration Milliseconds, in [0, 10000].
   * @param strength Magnitude in [0, 1] for both motors. Default 1.
   * @param gamepad Gamepad index, an integer >= 0. Default 0.
   * @throws MargoError `'disposed'` after {@link Input.dispose}.
   * @throws RangeError for an out-of-range argument.
   */
  async rumble(duration: number, strength = 1, gamepad = 0): Promise<boolean> {
    if (this.disposed) throw new MargoError('disposed', 'Input is disposed; create a new Input');
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 10_000 ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1 ||
      !Number.isInteger(gamepad) ||
      gamepad < 0
    )
      throw new RangeError('Invalid haptics');
    const actuator = this.gamepads()[gamepad]?.vibrationActuator;
    if (!actuator) return false;
    await actuator.playEffect('dual-rumble', { duration, strongMagnitude: strength, weakMagnitude: strength });
    return true;
  }
  /** Release all keys, buttons and touch controls and clear pending motion; runs on blur and pointercancel. */
  reset(): void {
    this.keys.clear();
    this.buttons = 0;
    this.motion.x = this.motion.y = this.motion.wheel = 0;
    for (const state of this.touch.values()) {
      state.reset?.();
      state.down = false;
      state.x = state.y = 0;
    }
  }
  /** Remove all listeners and created sticks. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.cleanups.length - 1; i >= 0; i--) this.cleanups[i]();
    this.cleanups.length = 0;
    this.reset();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
