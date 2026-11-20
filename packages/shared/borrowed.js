// Borrowed GPU objects (docs/conventions.md#borrowed-gpu-objects): a GPUTexture, view, sampler or buffer the caller
// made belongs to the device that made it, and WebGPU gives no way to ask an object for its device. A slot keeps the
// device the object was taken under; after a device restore the object is dropped and reported once, and the frame
// goes on drawing. A function `(device) => object` is called once per device, so it comes back by itself.
import { fault } from './errors.js';

/** Puts `value` in `slot`; a plain object belongs to `device` (undefined: the device of its first `lend`). */
export function relend(slot, value, device) {
  slot.value = value;
  slot.device = typeof value === 'function' ? undefined : device;
  slot.made = undefined;
  slot.told = false;
  return slot;
}

/** Fixes the device a plain object given before attach belongs to; owners call it from `setup`. */
export function fix(slot, device) {
  if (typeof slot.value !== 'function') slot.device ??= device;
}

/** A slot for an option that takes a caller's GPU object or `(device) => object`, named for its one report. */
export const borrow = (value, name, setter, device) => relend({ name, setter }, value, device);

/**
 * What to bind on `device`: the function's result (made once per device), the plain object while its device is the
 * one in use, else undefined, reported once through `engine.onError`.
 */
export function lend(slot, device, engine) {
  const { value } = slot;
  if (typeof value === 'function') {
    if (slot.device !== device) slot.made = value((slot.device = device));
    return slot.made;
  }
  if (value == null) return undefined;
  slot.device ??= device;
  if (slot.device === device) return value;
  if (!slot.told) {
    slot.told = true;
    engine?.onError(
      fault('state', `${slot.name} lost with the device; pass a function or call ${slot.setter}`, 'borrowed-lost'),
    );
  }
  return undefined;
}

/**
 * True for an option object the caller wrote (`{ texture, sampler, ... }`: a plain object, from any realm), false for a
 * GPU object or a materials Texture. Those are class instances, and their own fields say nothing about an option's
 * shape: a WebGL2-layer texture keeps its GL texture as `texture`, and its views keep their texture there.
 */
export function isOptionObject(value) {
  if (!value || typeof value !== 'object') return false;
  const p = Object.getPrototypeOf(value);
  return p === null || Object.getPrototypeOf(p) === null;
}
