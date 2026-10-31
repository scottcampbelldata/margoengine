// The sandbox's DOM: hotbar, crosshair, HUD text, overlays and toasts. Plain elements from index.html.
import type { Pixels } from './textures.ts';
import { hotbarWindow } from './touch.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Draws a 16 x 16 texture into a small canvas (scaled up with pixelated rendering by CSS). */
function icon(pixels: Pixels | undefined, cross: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  if (pixels) {
    const context = canvas.getContext('2d')!,
      image = context.createImageData(16, 16);
    image.data.set(pixels.data);
    context.putImageData(image, 0, 0);
  }
  if (cross) canvas.classList.add('cross');
  return canvas;
}

/** Hotbar of nine slots: the block name per slot and the selected slot. */
export class Hotbar {
  readonly slots: string[];
  selected = 0;
  #root = element('hotbar');
  #label = element('hotbar-label');
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Slots shown at once; on a narrow touch screen fewer than nine, a run around the selected one. */
  fit = 9;
  constructor(
    slots: readonly string[],
    private readonly look: (name: string) => { label: string; pixels?: Pixels; cross: boolean },
  ) {
    this.slots = [...slots];
    this.#render();
  }
  get block(): string {
    return this.slots[this.selected];
  }
  select(slot: number): void {
    this.selected = ((slot % 9) + 9) % 9;
    this.#render();
    this.#flash();
  }
  /** Puts `name` in the selected slot, or selects the slot that already holds it. */
  pick(name: string): void {
    const at = this.slots.indexOf(name);
    if (at >= 0) this.selected = at;
    else this.slots[this.selected] = name;
    this.#render();
    this.#flash();
  }
  #flash(): void {
    this.#label.textContent = this.look(this.block).label;
    this.#label.classList.add('show');
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#label.classList.remove('show'), 1500);
  }
  /** Redraws the bar (after {@link Hotbar.fit} changed). */
  refresh(): void {
    this.#render();
  }
  #render(): void {
    const [first, last] = hotbarWindow(this.selected, this.slots.length, this.fit);
    this.#root.replaceChildren(
      ...this.slots.map((name, i) => {
        const slot = document.createElement('div'),
          { pixels, cross, label } = this.look(name),
          key = document.createElement('span');
        slot.className = i === this.selected ? 'slot selected' : 'slot';
        slot.title = `${i + 1}: ${label}`;
        slot.dataset.slot = String(i);
        slot.hidden = i < first || i > last;
        key.textContent = String(i + 1);
        slot.append(icon(pixels, cross), key);
        return slot;
      }),
    );
  }
}

/** The text HUD (top left). */
export function setHud(lines: readonly string[]): void {
  element('hud').textContent = lines.join('\n');
}

/** Shows or hides the HUD and returns whether it is shown. */
export function toggleHud(show?: boolean): boolean {
  return !element('hud').classList.toggle('hidden', show === undefined ? undefined : !show);
}

/** Counts presses inside 1.5 s and calls `found` on the third; a press after that window starts again. */
export function eggCounter(found: () => void, now: () => number = () => performance.now()): () => void {
  let count = 0,
    first = 0;
  return () => {
    const t = now();
    if (t - first > 1500) (count = 0), (first = t);
    if (++count === 3) (count = 0), found();
  };
}

/** A message near the top of the screen for two seconds. */
export function toast(text: string): void {
  const t = element('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout((toast as { timer?: ReturnType<typeof setTimeout> }).timer);
  (toast as { timer?: ReturnType<typeof setTimeout> }).timer = setTimeout(() => t.classList.remove('show'), 2000);
}

/** The start / pause overlay: `loading` text while the world generates, then the controls and a play prompt. */
export function setOverlay(state: 'loading' | 'paused' | 'playing' | 'hidden', text = ''): void {
  const overlay = element('overlay');
  overlay.dataset.state = state;
  overlay.hidden = state === 'playing' || state === 'hidden';
  element('overlay-status').textContent = text;
}

/**
 * The status line over the game: why this page is playing alone, or that the world is changing. `join` adds a Join
 * button that runs it. No text hides the line.
 */
export function setBanner(text: string, join?: () => void): void {
  const banner = element('banner'),
    button = banner.querySelector('button')!;
  banner.hidden = !text;
  banner.querySelector('span')!.textContent = text;
  button.hidden = !join;
  button.onclick = join ?? null;
}

/** Whether the page plays by touch: shows the touch buttons and the touch help, hides the keyboard help. */
export function setTouchUi(on: boolean): void {
  document.body.classList.toggle('touch', on);
  element('overlay').querySelector('.play')!.textContent = on ? 'Tap to play' : 'Click to play';
  element('touch-buttons').hidden = !on;
}

/** Shows the Report button (online on Plaza) and sets what it does. */
export function setReport(send: (() => void) | undefined): void {
  const button = element('report');
  button.hidden = !send;
  button.onclick = send ?? null;
}

/** Shows a fatal error. */
export function showError(error: unknown): void {
  setOverlay('loading', '');
  const box = element('error');
  box.hidden = false;
  box.textContent = `The sandbox stopped: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
}

/** Tints the screen while the eye is under water. */
export function setUnderwater(on: boolean): void {
  element('underwater').classList.toggle('on', on);
}

/** Hides every overlay, HUD and crosshair element (deterministic screenshots keep only the hotbar). */
export function setDeterministic(): void {
  document.body.classList.add('deterministic');
}
