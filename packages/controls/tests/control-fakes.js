// Small DOM stand-ins shared by the trackball, fly and first-person tests.
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';

export class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  dispatch(type, props = {}) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...props,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
}
export class FakeElement extends FakeTarget {
  constructor(width = 800, height = 600) {
    super();
    this.clientWidth = width;
    this.clientHeight = height;
    this.style = { touchAction: 'auto' };
    this.captured = new Set();
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
}
export const pointer = (el, type, x, y, extra = {}) =>
  el.dispatch(type, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse', ...extra });
export const key = (target, type, code, extra = {}) => target.dispatch(type, { code, ...extra });
export const close = (actual, expected, tolerance, message = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} expected ${expected}, got ${actual}`);
export const closeVec = (a, b, tolerance, message = '') =>
  b.forEach((v, i) => close(a[i], v, tolerance, `${message}[${i}]`));
export const camera = (options = {}) => new Camera({ position: [0, 0, 10], target: [0, 0, 0], ...options });
export const run = (control, seconds, fps = 60) => {
  let changed = false;
  for (let i = 0, n = Math.round(seconds * fps); i < n; i++) changed = control.update(1 / fps) || changed;
  return changed;
};
