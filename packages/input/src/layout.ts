import { MargoError } from '@margoengine/math/errors';
import type { Binding } from './index.js';
import { bindingLabel, type GlyphLayout } from './labels.js';

/** Structural navigator.keyboard surface. No browser permission or map is read until refresh. */
export interface InputKeyboardMapSource {
  getLayoutMap(): Promise<Iterable<readonly [string, string]>>;
  /** Draft layoutchange events are not exposed by every implementation of getLayoutMap. */
  addEventListener?: EventTarget['addEventListener'];
  /** Paired with addEventListener when draft layoutchange events are supported. */
  removeEventListener?: EventTarget['removeEventListener'];
}
/** Options for KeyboardLabels. */
export interface KeyboardLabelsOptions {
  /** Native navigator.keyboard by default. Null explicitly disables map lookup. */
  keyboard?: InputKeyboardMapSource | null;
  /** Bound on each map request, including automatic layoutchange refreshes. Default 5000 ms. */
  timeout?: number;
}
/**
 * Format a prompt with an already loaded native Keyboard Map; never changes the binding's physical code.
 * ASCII letters are capitalized for keycap prompts. Unicode glyphs and punctuation are preserved.
 * Missing/blank/control-character labels use the standard bindingLabel. Chords and gamepad glyphs are retained.
 */
export function layoutBindingLabel(
  binding: Binding,
  map?: ReadonlyMap<string, string> | null,
  layout: GlyphLayout = 'xbox',
): string {
  const fallback = bindingLabel(binding, layout);
  if (binding.type !== 'key') return fallback;
  const glyph = map?.get(binding.code);
  if (!glyph?.trim() || /[\u0000-\u001f\u007f]/.test(glyph)) return fallback;
  const codeLabel = bindingLabel({ ...binding, modifiers: undefined }, layout);
  return fallback.slice(0, -codeLabel.length) + (/^[a-z]$/.test(glyph) ? glyph.toUpperCase() : glyph);
}
/**
 * Layout-aware key prompts with automatic native layoutchange refreshes and standard fallback labels.
 * Await refresh once, then call label synchronously. Listen for 'change' to redraw prompts.
 * Automatic failures are observable as lastError plus an 'error' event; explicit refresh rejects unexpected errors.
 */
export class KeyboardLabels extends EventTarget {
  /** Most recent automatic/explicit refresh error, or null after success or an expected capability denial. */
  lastError: unknown = null;
  private current: ReadonlyMap<string, string> | null = null;
  private readonly keyboard: InputKeyboardMapSource | null | undefined;
  private readonly timeout: number;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private disposed = false;
  /** @throws RangeError for an invalid timeout; use finite positive milliseconds. */
  constructor({
    keyboard = (globalThis.navigator as (Navigator & { keyboard?: InputKeyboardMapSource }) | undefined)?.keyboard,
    timeout = 5000,
  }: KeyboardLabelsOptions = {}) {
    super();
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new RangeError('Invalid keyboard-map timeout; use positive finite milliseconds');
    this.keyboard = keyboard;
    this.timeout = timeout;
    if (keyboard?.addEventListener && keyboard.removeEventListener)
      keyboard.addEventListener('layoutchange', this.onLayoutChange);
  }
  /** Whether the browser exposes Keyboard Map, independent of permissions policy. */
  get supported(): boolean {
    return typeof this.keyboard?.getLayoutMap === 'function';
  }
  /** Whether a map was obtained, including a valid empty map. */
  get available(): boolean {
    return this.current !== null;
  }
  /** Current read-only snapshot, or null when unavailable/denied. */
  get map(): ReadonlyMap<string, string> | null {
    return this.current;
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'Keyboard labels are disposed; create new KeyboardLabels');
  }
  private readonly onLayoutChange = (): void => {
    void this.refresh().catch((error) => {
      if (!this.disposed) {
        this.lastError = error;
        this.dispatchEvent(new Event('error'));
      }
    });
  };
  /** Synchronous prompt using the latest map, or the standard fallback. @throws MargoError after disposal. */
  label(binding: Binding, layout: GlyphLayout = 'xbox'): string {
    this.check();
    return layoutBindingLabel(binding, this.current, layout);
  }
  /**
   * Load the map with a bounded abortable wait. Last-started request wins; stale results never replace a newer map.
   * Returns false when unsupported, denied or superseded. Known policy/permission/unsupported denials use fallback.
   * @throws DOMException on abort/timeout; unexpected native errors are propagated, with lastError retained.
   */
  async refresh({ signal }: { signal?: AbortSignal } = {}): Promise<boolean> {
    this.check();
    signal?.throwIfAborted();
    const generation = ++this.generation;
    if (!this.supported) {
      this.current = null;
      return false;
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException('Keyboard map timed out; refresh again when the browser is ready', 'TimeoutError'),
        ),
      this.timeout,
    );
    const combined = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    try {
      const native = await new Promise<Iterable<readonly [string, string]>>((resolve, reject) => {
        const abort = () => reject(combined.reason);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) {
          abort();
          return;
        }
        Promise.resolve()
          .then(() => this.keyboard!.getLayoutMap())
          .then(resolve, reject)
          .finally(() => combined.removeEventListener('abort', abort));
      });
      const map = new Map(native);
      for (const [code, glyph] of map)
        if (typeof code !== 'string' || typeof glyph !== 'string')
          throw new TypeError('Invalid keyboard map; provide string key codes and glyphs');
      if (this.disposed || generation !== this.generation) return false;
      this.current = map;
      this.lastError = null;
      this.dispatchEvent(new Event('change'));
      return true;
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      if (this.disposed || generation !== this.generation) return false;
      if (
        ['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes((error as { name?: string })?.name ?? '')
      ) {
        this.current = null;
        this.lastError = null;
        this.dispatchEvent(new Event('change'));
        return false;
      }
      this.lastError = error;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Cancel pending refreshes and remove the layout listener. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.keyboard?.removeEventListener?.('layoutchange', this.onLayoutChange);
    this.lifetime.abort(new MargoError('disposed', 'Keyboard labels are disposed; create new KeyboardLabels'));
    this.current = null;
  }
  /** Deterministic disposal for using declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
