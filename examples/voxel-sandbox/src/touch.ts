// Touch controls: the left half of the canvas is a walking stick, the right half a look drag (a tap places, a 400 ms
// press breaks), with jump, fly and down buttons and a hotbar that swipes. The stick lives here because
// @margoengine/input's Gestures has tap, swipe and pinch but no stick. The first half of the file is plain maths, tested
// in node.

/** Pixels from the touch's start at which the stick is fully over. */
export const STICK_RADIUS = 60;
/** The part of the stick's travel that does nothing, 0 to 1. */
export const DEAD_ZONE = 0.18;
/** A held touch that has not moved breaks after this many milliseconds. */
export const HOLD_MS = 400;
/** A touch that moves further than this many pixels is a drag: it neither places nor breaks. */
export const TAP_SLOP = 10;
/** Stick, jump and fly reach the game at this rate. */
export const INPUT_HZ = 30;

/**
 * The stick's position for a drag of (dx, dy) pixels: x right, y forward (screen up), length 0 inside the dead zone and
 * growing to 1 at `radius`, in the same direction as the drag.
 */
export function stickVector(
  dx: number,
  dy: number,
  radius: number = STICK_RADIUS,
  deadZone: number = DEAD_ZONE,
): { x: number; y: number } {
  const length = Math.hypot(dx, dy),
    travel = length / radius;
  if (travel <= deadZone || length === 0) return { x: 0, y: 0 };
  const strength = Math.min(1, (travel - deadZone) / (1 - deadZone));
  return { x: (dx / length) * strength, y: (-dy / length) * strength };
}

/**
 * The key codes a stick position holds. Eight directions: a key is held when the stick is within 67.5 degrees of its
 * axis, so diagonals hold two and a stick at rest holds none.
 */
export function stickKeys(x: number, y: number): string[] {
  const length = Math.hypot(x, y);
  if (length === 0) return [];
  const axis = Math.cos((67.5 * Math.PI) / 180) * length,
    codes: string[] = [];
  if (y > axis) codes.push('KeyW');
  if (y < -axis) codes.push('KeyS');
  if (x > axis) codes.push('KeyD');
  if (x < -axis) codes.push('KeyA');
  return codes;
}

/** What a finished touch on the look side was. */
export function pressKind(heldMs: number, moved: number): 'tap' | 'hold' | 'drag' {
  if (moved > TAP_SLOP) return 'drag';
  return heldMs >= HOLD_MS ? 'hold' : 'tap';
}

/**
 * The hotbar slots shown on a screen with room for `fit` of `count`: a run around `selected`, moved inward at the ends.
 * Returns [first, last], inclusive.
 */
export function hotbarWindow(selected: number, count: number, fit: number): [number, number] {
  const shown = Math.max(1, Math.min(count, fit)),
    first = Math.max(0, Math.min(count - shown, selected - Math.floor(shown / 2)));
  return [first, first + shown - 1];
}

/** How many 44 px slots (with their 2 px gaps and the bar's padding) fit in `width` CSS pixels, odd when it is short. */
export function slotsThatFit(width: number): number {
  const fit = Math.max(1, Math.floor((width - 24) / 46));
  return fit >= 9 ? 9 : fit % 2 ? fit : fit - 1;
}

/** The slot a hotbar swipe lands on: one slot per 44 px, clamped to the bar. */
export function swipedSlot(start: number, dx: number, count: number): number {
  return Math.max(0, Math.min(count - 1, start - Math.round(dx / 44)));
}

/** What {@link TouchControls} drives. */
export interface TouchTarget {
  /** Turns the view by a drag of this many CSS pixels. */
  look(dx: number, dy: number): void;
  /** Places a block at the crosshair. */
  place(): void;
  /** Breaks the block at the crosshair. */
  break(): void;
  /** Toggles flying; returns whether flying is on. */
  fly(): boolean;
  /** The keys the game reads; the controls hold the stick's and the jump and down buttons' codes in it. */
  keys: Set<string>;
  /** The selected hotbar slot. */
  slot(): number;
  select(slot: number): void;
  /** Slots in the hotbar. */
  slots: number;
}

const LOOK_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];

/** Pointer events on the canvas and the touch buttons. `active` is false until the player starts playing. */
export class TouchControls {
  active = false;
  readonly #target: TouchTarget;
  readonly #canvas: HTMLElement;
  readonly #events = new AbortController();
  #stick = -1;
  #stickX = 0;
  #stickY = 0;
  #nowX = 0;
  #nowY = 0;
  #look = -1;
  #lookX = 0;
  #lookY = 0;
  #lookStart = 0;
  #moved = 0;
  #broke = false;
  #sampled = 0;
  readonly #ring: HTMLElement;
  readonly #down: HTMLElement;

  constructor(canvas: HTMLElement, hotbar: HTMLElement, buttons: HTMLElement, target: TouchTarget) {
    this.#canvas = canvas;
    this.#target = target;
    const signal = this.#events.signal;
    this.#ring = buttons.querySelector<HTMLElement>('#stick')!;
    this.#down = buttons.querySelector<HTMLElement>('#touch-down')!;
    canvas.addEventListener('pointerdown', this.#pointerDown, { signal });
    canvas.addEventListener('pointermove', this.#pointerMove, { signal });
    canvas.addEventListener('pointerup', this.#pointerUp, { signal });
    canvas.addEventListener('pointercancel', this.#pointerUp, { signal });
    // Android's long press menu would end the 400 ms press.
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        if (this.active) event.preventDefault();
      },
      { signal },
    );
    holdButton(buttons.querySelector('#touch-jump')!, target.keys, 'Space', signal);
    holdButton(this.#down, target.keys, 'KeyC', signal);
    buttons.querySelector('#touch-fly')!.addEventListener('click', () => this.#showDown(target.fly()), { signal });
    swipeHotbar(hotbar, target, signal);
  }

  /** The stick's current position (for tests and the HUD). */
  get stick(): { x: number; y: number } {
    return this.#stick < 0 ? { x: 0, y: 0 } : stickVector(this.#nowX - this.#stickX, this.#nowY - this.#stickY);
  }

  /** Once a frame: a held press breaks after {@link HOLD_MS}, and at {@link INPUT_HZ} the stick reaches the game's keys. */
  update(now: number): void {
    if (this.#look >= 0 && !this.#broke && this.#moved <= TAP_SLOP && now - this.#lookStart >= HOLD_MS) {
      this.#broke = true;
      if (this.active) this.#target.break();
    }
    if (now - this.#sampled < 1000 / INPUT_HZ) return;
    this.#sampled = now;
    const { x, y } = this.stick,
      held = stickKeys(x, y),
      keys = this.#target.keys;
    for (const code of LOOK_KEYS)
      if (held.includes(code)) keys.add(code);
      else keys.delete(code);
  }

  /** Shows the down button while flying or swimming. */
  #showDown(on: boolean): void {
    this.#down.hidden = !on;
  }

  /** Whether flying or swimming: the down button is useful. */
  setDownVisible(on: boolean): void {
    if (this.#down.hidden === on) this.#showDown(on);
  }

  dispose(): void {
    this.#events.abort();
  }

  readonly #pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || !this.active) return;
    this.#canvas.setPointerCapture?.(event.pointerId);
    const left = event.clientX < this.#canvas.clientWidth / 2;
    if (left && this.#stick < 0) {
      this.#stick = event.pointerId;
      this.#stickX = this.#nowX = event.clientX;
      this.#stickY = this.#nowY = event.clientY;
      this.#ring.style.transform = `translate(${event.clientX - 60}px, ${event.clientY - 60}px)`;
      this.#ring.hidden = false;
    } else if (!left && this.#look < 0) {
      this.#look = event.pointerId;
      this.#lookX = event.clientX;
      this.#lookY = event.clientY;
      this.#lookStart = performance.now();
      this.#moved = 0;
      this.#broke = false;
    }
  };

  readonly #pointerMove = (event: PointerEvent): void => {
    if (event.pointerId === this.#stick) {
      this.#nowX = event.clientX;
      this.#nowY = event.clientY;
    } else if (event.pointerId === this.#look) {
      const dx = event.clientX - this.#lookX,
        dy = event.clientY - this.#lookY;
      this.#lookX = event.clientX;
      this.#lookY = event.clientY;
      this.#moved += Math.hypot(dx, dy);
      this.#target.look(dx, dy);
    }
  };

  readonly #pointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.#stick) {
      this.#stick = -1;
      this.#ring.hidden = true;
    } else if (event.pointerId === this.#look) {
      this.#look = -1;
      if (!this.#broke && event.type === 'pointerup' && this.active) {
        const kind = pressKind(performance.now() - this.#lookStart, this.#moved);
        if (kind === 'tap') this.#target.place();
        else if (kind === 'hold') this.#target.break();
      }
    }
  };
}

// A button that holds a key code while pressed, including when the finger slides off it.
function holdButton(button: HTMLElement, keys: Set<string>, code: string, signal: AbortSignal): void {
  button.addEventListener(
    'pointerdown',
    (event) => {
      button.setPointerCapture?.(event.pointerId);
      keys.add(code);
    },
    { signal },
  );
  const release = () => keys.delete(code);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    button.addEventListener(type, release, { signal });
}

// A tap on a slot selects it; a swipe along the bar moves the selection.
function swipeHotbar(hotbar: HTMLElement, target: TouchTarget, signal: AbortSignal): void {
  let id = -1,
    startX = 0,
    startSlot = 0,
    moved = false;
  hotbar.addEventListener(
    'pointerdown',
    (event) => {
      id = event.pointerId;
      startX = event.clientX;
      startSlot = target.slot();
      moved = false;
      hotbar.setPointerCapture?.(id);
    },
    { signal },
  );
  hotbar.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerId !== id) return;
      const dx = event.clientX - startX;
      if (Math.abs(dx) > TAP_SLOP) moved = true;
      if (moved) {
        const slot = swipedSlot(startSlot, dx, target.slots);
        if (slot !== target.slot()) target.select(slot);
      }
    },
    { signal },
  );
  hotbar.addEventListener(
    'pointerup',
    (event) => {
      if (event.pointerId !== id) return;
      id = -1;
      if (moved) return;
      // Pointer capture retargets the event to the bar: find the slot by position.
      const slot = document.elementsFromPoint(event.clientX, event.clientY).find((e) => e.matches('.slot')) as
        | HTMLElement
        | undefined;
      if (slot?.dataset.slot) target.select(Number(slot.dataset.slot));
    },
    { signal },
  );
}
