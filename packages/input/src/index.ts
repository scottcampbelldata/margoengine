/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
export { bindingLabel, type GlyphLayout } from './labels.js';
export { Gestures, type GestureEvent, type GestureOptions, type GestureType } from './gestures.js';
/** Modifier keys a `key` binding can require; the binding only fires while all of them are held. */
export type Modifier = 'shift' | 'ctrl' | 'alt' | 'meta';
const MODIFIER_CODES: Record<Modifier, readonly string[]> = {
  shift: ['ShiftLeft', 'ShiftRight'],
  ctrl: ['ControlLeft', 'ControlRight'],
  alt: ['AltLeft', 'AltRight'],
  meta: ['MetaLeft', 'MetaRight'],
};
/**
 * One source feeding an action. Each sample is multiplied by `scale` (finite, default 1) and summed into the action.
 * - `key`: `KeyboardEvent.code` (non-empty); 1 while held. With `modifiers` it is a chord (for example Ctrl+S):
 *   the key counts only while every listed modifier is also held.
 * - `mouse`: button 0..4; 1 while held.
 * - `pointer`: movement on `x`/`y` (pixels) or `wheel` (`WheelEvent.deltaY` in pixels: a line counts 16 and a page 800) since the last update.
 * - `gamepad-axis` / `gamepad-button`: axis or button `index` (integer >= 0) of gamepad `gamepad` (default 0);
 *   axes get the deadzone applied.
 * - `touch`: a control from `createStick`/`bindTouchButton` by `id`; `axis` reads a stick in [-1, 1], otherwise 1 while down.
 * - `control`: a number published by code through {@link Input.control}: `axis` of control `id`, default `'value'`.
 *   `Gyro` and `Pen` publish this way.
 */
export type Binding =
  | { type: 'key'; code: string; modifiers?: readonly Modifier[]; scale?: number }
  | { type: 'mouse'; button: number; scale?: number }
  | { type: 'pointer'; axis: 'x' | 'y' | 'wheel'; scale?: number }
  | { type: 'gamepad-axis' | 'gamepad-button'; index: number; gamepad?: number; scale?: number }
  | { type: 'touch'; id: string; axis?: 'x' | 'y'; scale?: number }
  | { type: 'control'; id: string; axis?: string; scale?: number };
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
  /**
   * Input contexts: context name to the actions it owns. An action listed in any context reads 0 unless one of its
   * contexts is enabled (see {@link Input.setContext}); unlisted actions are always active. All contexts start enabled.
   */
  contexts?: Readonly<Record<string, readonly string[]>>;
}

/** Takes the place of the devices while set with {@link Input.setFeed}. */
export interface InputFeed {
  /** Called at the start of every {@link Input.update}. Calling `setFeed(null)` here gives this update to the devices. */
  begin(): void;
  /** What one binding of `action` gives this update, as {@link Input.bindingValue} would report it. */
  read(action: string, binding: number): number;
}

/** Plain, JSON-safe snapshot of every action's bindings, as written by {@link Input.exportBindings}. */
export type BindingMap = Record<string, Binding[]>;

// Pointer Events 3, 4.1.1.3: the `buttons` bit of each `button` index (left 1, middle 4, right 2, back 8, forward 16).
const BUTTON_BITS = [1, 4, 2, 8, 16];
function fromButtons(buttons: number): number {
  let held = 0;
  for (let i = 0; i < BUTTON_BITS.length; i++) if (buttons & BUTTON_BITS[i]) held |= 1 << i;
  return held;
}
const BINDING_TYPES = ['key', 'mouse', 'pointer', 'gamepad-axis', 'gamepad-button', 'touch', 'control'];
function validateBinding(binding: Binding): void {
  if (!binding || typeof binding !== 'object')
    throw new TypeError(
      'Invalid action binding; bind an action to key, mouse, gamepad or touch codes (see InputOptions)',
    );
  if (!Number.isFinite(binding.scale ?? 1) || !BINDING_TYPES.includes(binding.type))
    throw new TypeError(
      'Invalid action binding; bind an action to key, mouse, gamepad or touch codes (see InputOptions)',
    );
  if (
    (binding.type === 'key' &&
      (!binding.code ||
        (binding.modifiers !== undefined &&
          (!Array.isArray(binding.modifiers) || binding.modifiers.some((m) => !(m in MODIFIER_CODES)))))) ||
    (binding.type === 'mouse' && (!Number.isInteger(binding.button) || binding.button < 0 || binding.button > 4)) ||
    ((binding.type === 'gamepad-axis' || binding.type === 'gamepad-button') &&
      (!Number.isInteger(binding.index) ||
        binding.index < 0 ||
        !Number.isInteger(binding.gamepad ?? 0) ||
        (binding.gamepad ?? 0) < 0)) ||
    (binding.type === 'pointer' && !['x', 'y', 'wheel'].includes(binding.axis)) ||
    (binding.type === 'touch' &&
      (!binding.id || (binding.axis !== undefined && binding.axis !== 'x' && binding.axis !== 'y'))) ||
    (binding.type === 'control' &&
      (!binding.id || typeof binding.id !== 'string' || (binding.axis !== undefined && !binding.axis)))
  )
    throw new TypeError(
      'Invalid action binding; bind an action to key, mouse, gamepad or touch codes (see InputOptions)',
    );
}

/** Semantic action state is reused; sample once per simulation tick. */
export class Input {
  private readonly states = new Map<string, ActionState>();
  private readonly samples: { name: string; state: ActionState; values: number[] }[] = [];
  private readonly keys = new Set<string>();
  private buttons = 0;
  // Pressed since the last update, so a press and release between two updates still counts for one update.
  private readonly tapped = new Set<string>();
  private tappedButtons = 0;
  private readonly motion = { x: 0, y: 0, wheel: 0 };
  private readonly touch = new Map<
    string,
    { x: number; y: number; down: boolean; tapped?: boolean; reset?: () => void }
  >();
  private readonly controls = new Map<string, Record<string, number>>();
  private feed: InputFeed | null = null;
  private readonly cleanups: (() => void)[] = [];
  private readonly gamepads: () => readonly (Gamepad | null)[];
  private readonly deadzone: number;
  private disposed = false;
  private readonly target: EventTarget;
  private readonly initial: Record<string, readonly Binding[]>;
  private bindingsByAction: Record<string, readonly Binding[]>;
  private readonly owners = new Map<string, Set<string>>();
  private readonly enabled = new Set<string>();
  /** Current bindings per action. Replaced (not mutated) by {@link Input.rebind} and {@link Input.importBindings}. */
  get actions(): Readonly<Record<string, readonly Binding[]>> {
    return this.bindingsByAction;
  }
  /**
   * Map named actions to bindings and start listening on `target`. Key presses inside form fields are ignored.
   * @throws RangeError for an invalid deadzone or a non-function `gamepads`.
   * @throws TypeError for an empty action name, an action without bindings, or an invalid binding.
   */
  constructor(
    actions: Readonly<Record<string, readonly Binding[]>>,
    {
      target = window,
      gamepads = () => navigator.getGamepads?.() ?? [],
      deadzone = 0.15,
      contexts = {},
    }: InputOptions = {},
  ) {
    this.target = target;
    this.bindingsByAction = { ...actions };
    this.initial = { ...actions };
    if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1 || typeof gamepads !== 'function')
      throw new RangeError('Invalid input options; pass the documented option types');
    this.gamepads = gamepads;
    this.deadzone = deadzone;
    for (const [name, bindings] of Object.entries(actions)) {
      if (!name || !bindings.length)
        throw new TypeError('Actions need names and bindings; give every action at least one binding');
      for (const binding of bindings) validateBinding(binding);
      this.states.set(name, { value: 0, down: false, pressed: false, released: false });
      this.samples.push({ name, state: this.states.get(name)!, values: [] });
    }
    for (const [context, names] of Object.entries(contexts)) {
      if (!context || !Array.isArray(names))
        throw new TypeError('Invalid input context; map each context name to an array of action names');
      for (const name of names) {
        if (!this.states.has(name))
          throw new TypeError('Unknown input action in context; list only actions defined in the first argument');
        (this.owners.get(name) ?? this.owners.set(name, new Set()).get(name)!).add(context);
      }
      this.enabled.add(context);
    }
    try {
      this.listen(target, 'keydown', (event) => {
        const e = event as KeyboardEvent,
          node = e.composedPath()[0] as Element;
        // A repeat is no new press: after a blur reset it would press a key the player never pressed again.
        if (!e.repeat && !node?.closest?.('input,textarea,select,[contenteditable=true]')) {
          this.keys.add(e.code);
          this.tapped.add(e.code);
        }
      });
      this.listen(target, 'keyup', (event) => this.keys.delete((event as KeyboardEvent).code));
      this.listen(target, 'pointerdown', (event) => this.pointerButtons(event as PointerEvent));
      this.listen(target, 'pointerup', (event) => this.pointerButtons(event as PointerEvent));
      this.listen(target, 'pointermove', (event) => {
        const e = event as PointerEvent;
        if (e.pointerType !== 'touch') {
          this.motion.x += e.movementX || 0;
          this.motion.y += e.movementY || 0;
          this.pointerButtons(e);
        }
      });
      this.listen(target, 'wheel', (event) => {
        // WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. Sum in pixels so a notched wheel and a trackpad agree.
        const wheel = event as WheelEvent;
        this.motion.wheel += wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? 800 : 1);
      });
      this.listen(target, 'blur', () => this.reset());
      this.listen(target, 'pointercancel', () => this.reset());
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  /**
   * Pointer Events 3, 4.1.1.1: a button pressed or released while another is held fires no pointerdown or pointerup,
   * only a pointermove whose `button` names the changed button. `buttons` holds them all, so read it on every event.
   */
  private pointerButtons(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const bit = e.button >= 0 ? 1 << e.button : 0,
      known = typeof e.buttons === 'number';
    let held = known ? fromButtons(e.buttons) : this.buttons;
    if (e.type === 'pointerdown') held |= bit;
    else if (e.type === 'pointerup') held &= ~bit;
    else if (!bit || !known) return;
    this.tappedButtons |= held & ~this.buttons;
    this.buttons = held;
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
    if (!state) throw new TypeError('Unknown input action; add it to the actions option first');
    return state;
  }
  /**
   * What one binding of `action` gave at the last {@link Input.update}, with its `scale` applied and before the action
   * sums and clamps. Reads 0 for an index past the end, and while the action's contexts are off.
   * @throws TypeError for an unknown action.
   */
  bindingValue(action: string, binding: number): number {
    if (!this.states.has(action)) throw new TypeError('Unknown input action; add it to the actions option first');
    return this.samples.find((sample) => sample.name === action)!.values[binding] ?? 0;
  }
  /** Read bindings from `feed` instead of the devices, or from the devices again with `null`. See `InputReplay`. */
  setFeed(feed: InputFeed | null): void {
    this.feed = feed;
  }
  /**
   * Sample every binding into its action state and clear the accumulated pointer motion. Call once per tick.
   * @throws MargoError `'disposed'` after {@link Input.dispose}.
   */
  update(): void {
    if (this.disposed) throw new MargoError('disposed', 'Input is disposed; create a new Input');
    this.feed?.begin();
    const pads = this.gamepads(),
      feed = this.feed;
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i],
        name = sample.name,
        state = sample.state,
        values = sample.values;
      let value = 0;
      const bindings = this.bindingsByAction[name],
        owners = this.owners.get(name);
      let active = true;
      if (owners) {
        active = false;
        for (const context of owners)
          if (this.enabled.has(context)) {
            active = true;
            break;
          }
      }
      values.length = bindings.length;
      values.fill(0);
      for (let j = 0; active && j < bindings.length; j++) {
        if (feed) {
          value += values[j] = feed.read(name, j);
          continue;
        }
        const binding = bindings[j];
        let sample = 0;
        switch (binding.type) {
          case 'key':
            sample = +this.held(binding.code);
            if (sample && binding.modifiers)
              for (const modifier of binding.modifiers)
                if (!MODIFIER_CODES[modifier].some((code) => this.held(code))) sample = 0;
            break;
          case 'mouse':
            sample = +!!((this.buttons | this.tappedButtons) & (1 << binding.button));
            break;
          case 'pointer':
            sample = this.motion[binding.axis];
            break;
          case 'touch': {
            const stick = this.touch.get(binding.id);
            sample = binding.axis ? (stick?.[binding.axis] ?? 0) : +!!(stick?.down || stick?.tapped);
            break;
          }
          case 'control':
            sample = this.controls.get(binding.id)?.[binding.axis ?? 'value'] ?? 0;
            break;
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
        if (Number.isFinite(sample)) value += values[j] = sample * (binding.scale ?? 1);
      }
      value = Math.max(-1, Math.min(1, value));
      const down = Math.abs(value) > 1e-6;
      state.pressed = down && !state.down;
      state.released = !down && state.down;
      state.down = down;
      state.value = value;
    }
    this.motion.x = this.motion.y = this.motion.wheel = 0;
    this.clearTapped();
  }
  private held(code: string): boolean {
    return this.keys.has(code) || this.tapped.has(code);
  }
  private clearTapped(): void {
    this.tapped.clear();
    this.tappedButtons = 0;
    for (const state of this.touch.values()) state.tapped = false;
  }
  /**
   * The numbers of control `id`, made on first use. Write to them and `{ type: 'control', id, axis }` bindings read
   * them at each update, so any code can feed an action. Values go to 0 on {@link Input.reset}.
   * @throws TypeError for an empty id.
   * @throws MargoError `'disposed'` after {@link Input.dispose}.
   */
  control(id: string): Record<string, number> {
    if (this.disposed) throw new MargoError('disposed', 'Input is disposed; create a new Input');
    if (!id || typeof id !== 'string') throw new TypeError('Control ids must be non-empty strings');
    let values = this.controls.get(id);
    if (!values) this.controls.set(id, (values = Object.create(null) as Record<string, number>));
    return values;
  }
  /** Remove control `id`; bindings to it read 0. */
  removeControl(id: string): void {
    this.controls.delete(id);
  }
  /**
   * Append a 120 px on-screen touch stick to `parent`, readable through `touch` bindings with this `id`.
   * Removed on dispose.
   * @throws TypeError when disposed, `id` is empty, or `id` is already used by a touch control.
   */
  createStick(parent: HTMLElement, id: string): HTMLDivElement {
    if (this.disposed || !id || this.touch.has(id))
      throw new TypeError(
        'Invalid or duplicate touch control; give each touch control a unique name and a finite radius',
      );
    const doc = parent.ownerDocument,
      element = doc.createElement('div'),
      knob = doc.createElement('div'),
      state = { x: 0, y: 0, down: false, tapped: false };
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
      state.down = state.tapped = true;
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
    if (this.disposed || !id || this.touch.has(id))
      throw new TypeError(
        'Invalid or duplicate touch control; give each touch control a unique name and a finite radius',
      );
    const state = { x: 0, y: 0, down: false, tapped: false };
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
      state.down = state.tapped = true;
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
        state.down = state.tapped = true;
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
      throw new RangeError('Invalid haptics; pass finite durations and magnitudes from 0 to 1');
    const actuator = this.gamepads()[gamepad]?.vibrationActuator;
    if (!actuator) return false;
    await actuator.playEffect('dual-rumble', { duration, strongMagnitude: strength, weakMagnitude: strength });
    return true;
  }
  /**
   * Enable or disable an input context from the constructor's `contexts` option (for example mute gameplay actions
   * while a menu is open). Actions owned by no enabled context read 0, and held actions release on the next update.
   * @throws TypeError for an unknown context.
   */
  setContext(context: string, enabled: boolean): void {
    if (![...this.owners.values()].some((set) => set.has(context)))
      throw new TypeError('Unknown input context; use a name from the contexts option');
    if (enabled) this.enabled.add(context);
    else this.enabled.delete(context);
  }
  /** Whether `context` is currently enabled. Unknown contexts are not. */
  hasContext(context: string): boolean {
    return this.enabled.has(context);
  }
  /**
   * Replace the bindings of one action (for example from a rebinding screen).
   * @throws TypeError for an unknown action, no bindings, or an invalid binding.
   */
  rebind(action: string, bindings: readonly Binding[]): void {
    if (!this.states.has(action))
      throw new TypeError('Unknown input action; use a name from the actions given to the constructor');
    if (!bindings.length)
      throw new TypeError('Actions need names and bindings; give every action at least one binding');
    for (const binding of bindings) validateBinding(binding);
    this.bindingsByAction = { ...this.bindingsByAction, [action]: bindings.map((b) => ({ ...b })) };
  }
  /** Copy of every action's bindings, safe to `JSON.stringify` into localStorage or a settings file. */
  exportBindings(): BindingMap {
    return JSON.parse(JSON.stringify(this.bindingsByAction)) as BindingMap;
  }
  /**
   * Apply bindings from {@link Input.exportBindings} (or its JSON text). Unknown actions in the data are ignored so
   * saved files survive action renames; actions missing from the data keep their bindings. Nothing changes if any
   * entry is invalid.
   * @throws TypeError for malformed JSON or an invalid binding.
   */
  importBindings(data: BindingMap | string): void {
    let map: unknown;
    try {
      map = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      throw new TypeError(
        'Saved bindings are not valid JSON; pass the text from JSON.stringify(input.exportBindings())',
      );
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('Saved bindings must be an object');
    const next = { ...this.bindingsByAction };
    for (const [action, bindings] of Object.entries(map as Record<string, unknown>)) {
      if (!this.states.has(action)) continue;
      if (!Array.isArray(bindings) || !bindings.length)
        throw new TypeError('Invalid saved bindings; give each action a non-empty array of bindings');
      for (const binding of bindings) validateBinding(binding as Binding);
      next[action] = (bindings as Binding[]).map((b) => ({ ...b }));
    }
    this.bindingsByAction = next;
  }
  /** Restore the bindings given to the constructor. */
  resetBindings(): void {
    this.bindingsByAction = { ...this.initial };
  }
  /**
   * Wait for the next key, mouse button or gamepad button press and resolve with it as a {@link Binding}, for a
   * "press a key to rebind" prompt. Modifiers held with a key become `modifiers`; a modifier alone is taken when it is
   * released with no other key. A gamepad button already held at the call counts once released and pressed again.
   * Escape cancels.
   * @throws DOMException `AbortError` when `signal` aborts or the user presses Escape.
   * @throws MargoError `'disposed'` after {@link Input.dispose}.
   */
  captureBinding({ signal }: { signal?: AbortSignal } = {}): Promise<Binding> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new MargoError('disposed', 'Input is disposed; create a new Input'));
      let timer = 0;
      const done = (finish: () => void) => {
        this.target.removeEventListener('keydown', onKey);
        this.target.removeEventListener('keyup', onKeyUp);
        this.target.removeEventListener('pointerdown', onPointer);
        signal?.removeEventListener('abort', abort);
        if (timer) cancelAnimationFrame(timer);
        finish();
      };
      const abort = () => done(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
      // A modifier pressed alone may begin a chord (Ctrl, then S), so it is taken only when released with nothing else.
      let lone = '';
      const take = (e: KeyboardEvent) => {
        const flags: Record<Modifier, boolean> = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
        const modifiers = (Object.keys(flags) as Modifier[]).filter(
          (m) => flags[m] && !MODIFIER_CODES[m].includes(e.code),
        );
        done(() =>
          resolve(modifiers.length ? { type: 'key', code: e.code, modifiers } : { type: 'key', code: e.code }),
        );
      };
      const onKey = (event: Event) => {
        const e = event as KeyboardEvent;
        if (e.code === 'Escape') return done(() => reject(new DOMException('Cancelled', 'AbortError')));
        e.preventDefault?.();
        if (e.repeat) return;
        if (Object.values(MODIFIER_CODES).some((codes) => codes.includes(e.code))) lone = e.code;
        else take(e);
      };
      const onKeyUp = (event: Event) => {
        if ((event as KeyboardEvent).code === lone) take(event as KeyboardEvent);
      };
      const onPointer = (event: Event) => {
        const e = event as PointerEvent;
        if (e.pointerType === 'touch' || !(e.button >= 0 && e.button <= 4)) return;
        done(() => resolve({ type: 'mouse', button: e.button }));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort);
      this.target.addEventListener('keydown', onKey);
      this.target.addEventListener('keyup', onKeyUp);
      this.target.addEventListener('pointerdown', onPointer);
      // A button already held when capture starts (the one that opened the prompt) counts only after it is released.
      const held = new Set<string>();
      for (const pad of this.gamepads())
        pad?.buttons.forEach((button, index) => button.pressed && held.add(`${pad.index}:${index}`));
      const poll = () => {
        for (const pad of this.gamepads()) {
          if (!pad) continue;
          for (let index = 0; index < pad.buttons.length; index++) {
            const id = `${pad.index}:${index}`;
            if (!pad.buttons[index].pressed) held.delete(id);
            else if (!held.has(id)) return done(() => resolve({ type: 'gamepad-button', index, gamepad: pad.index }));
          }
        }
        timer = requestAnimationFrame(poll);
      };
      if (typeof requestAnimationFrame === 'function') timer = requestAnimationFrame(poll);
    });
  }
  /** Release all keys, buttons and touch controls and clear pending motion; runs on blur and pointercancel. */
  reset(): void {
    this.keys.clear();
    this.buttons = 0;
    this.motion.x = this.motion.y = this.motion.wheel = 0;
    this.clearTapped();
    for (const values of this.controls.values()) for (const axis in values) values[axis] = 0;
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
