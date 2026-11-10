import type { Engine } from '@margoengine/core/extension';
import type { FrameCallback } from '@margoengine/core';
import type { Frames } from './internal.js';

const priorities = new WeakMap<FrameCallback, number>();
/** Cache the stable order until subscription membership changes; ordinary frames need no sorting or array copy. */
export class FrameCallbacks extends Set<FrameCallback> {
  private revision = 0;
  private sortedRevision = -1;
  private sorted: FrameCallback[] = [];
  private positive = false;
  override add(callback: FrameCallback): this {
    if (!this.has(callback)) { super.add(callback); this.revision++; }
    return this;
  }
  override delete(callback: FrameCallback): boolean {
    const removed = super.delete(callback);
    if (removed) this.revision++;
    return removed;
  }
  override clear(): void {
    if (this.size) { super.clear(); this.revision++; }
  }
  /** The snapshot for this revision, never edited in place while a dispatch reads it. */
  ordered(): readonly FrameCallback[] {
    if (this.sortedRevision !== this.revision) {
      this.sorted = [...this].sort((a, b) => (priorities.get(a) ?? 0) - (priorities.get(b) ?? 0));
      this.positive = this.sorted.some((callback) => (priorities.get(callback) ?? 0) > 0);
      this.sortedRevision = this.revision;
    }
    return this.sorted;
  }
  /** Whether a live subscription has a positive priority. */
  takeover(): boolean { this.ordered(); return this.positive; }
}
interface Bridge {
  depth: number;
  skip: boolean;
  stamp: number;
  xr?: () => void;
  drawingXR: boolean;
}
const bridges = new WeakMap<Frames, Bridge>();
/** A positive live subscriber owns rendering; negative priorities only order callbacks. */
export function frameTakeover(frames: Frames): boolean {
  if (frames.callbacks instanceof FrameCallbacks) return frames.callbacks.takeover();
  for (const callback of frames.callbacks) if ((priorities.get(callback) ?? 0) > 0) return true;
  return false;
}
/** Subscribe in stable registration order, with a finite ascending numeric priority. */
export function subscribeFrame(frames: Frames, callback: FrameCallback, priority = 0): () => void {
  if (!Number.isFinite(priority)) throw new RangeError('useFrame priority must be finite; use 0 for automatic rendering.');
  priorities.set(callback, priority);
  frames.callbacks.add(callback);
  return () => { frames.callbacks.delete(callback); priorities.delete(callback); };
}
/** Snapshot before dispatch: additions start next frame, removals take effect immediately. */
export function advanceFrames(frames: Frames, engine: Engine, delta: number, desktop = false): boolean {
  frames.elapsed += delta;
  const bridge = bridges.get(frames);
  if (bridge) bridge.depth++;
  try {
    const callbacks = frames.callbacks instanceof FrameCallbacks ? frames.callbacks.ordered() : [...frames.callbacks].sort((a, b) => (priorities.get(a) ?? 0) - (priorities.get(b) ?? 0));
    for (const callback of callbacks) if (frames.callbacks.has(callback)) callback(engine as never, delta);
  } finally {
    if (bridge) bridge.depth--;
  }
  const automatic = !frameTakeover(frames);
  if (bridge && desktop) {
    bridge.skip = !automatic;
    const stamp = ++bridge.stamp;
    queueMicrotask(() => { if (stamp === bridge.stamp) bridge.skip = false; });
  }
  return automatic;
}
/** Adapt public render/onFrame methods for this Canvas. Manual draws remain available inside every native callback. */
export function bridgeFrames(engine: Engine, frames: Frames): () => void {
  const render = engine.render, onFrame = engine.onFrame;
  const renderProperty = Object.getOwnPropertyDescriptor(engine, 'render'), frameProperty = Object.getOwnPropertyDescriptor(engine, 'onFrame');
  const state: Bridge = { depth: 0, skip: false, stamp: 0, drawingXR: false };
  bridges.set(frames, state);
  const draw: Engine['render'] = function (this: Engine, options) {
    if (state.depth && state.xr && !state.drawingXR && !options?.views) {
      state.drawingXR = true;
      try { state.xr(); } finally { state.drawingXR = false; }
      return;
    }
    if (!state.depth && state.skip) {
      state.skip = false;
      if (frameTakeover(frames)) return;
    }
    return render.call(this, options);
  };
  const subscribe: Engine['onFrame'] = function (this: Engine, callback) {
    return onFrame.call(this, (engine, delta) => {
      state.depth++;
      try { callback(engine, delta); } finally { state.depth--; }
    });
  };
  engine.render = draw;
  engine.onFrame = subscribe;
  return () => {
    state.skip = false; state.xr = undefined;
    if (engine.render === draw) {
      if (renderProperty) Object.defineProperty(engine, 'render', renderProperty);
      else Reflect.deleteProperty(engine, 'render');
    }
    if (engine.onFrame === subscribe) {
      if (frameProperty) Object.defineProperty(engine, 'onFrame', frameProperty);
      else Reflect.deleteProperty(engine, 'onFrame');
    }
    if (bridges.get(frames) === state) bridges.delete(frames);
  };
}
/** Route a manual full-scene draw through the XR manager's current eyes, scoped to its frame callback. */
export function xrFrameScope<T>(frames: Frames, draw: () => void, callback: () => T): T {
  const state = bridges.get(frames);
  if (!state) return callback();
  const previous = state.xr;
  state.xr = draw; state.depth++;
  try { return callback(); } finally { state.depth--; state.xr = previous; }
}
