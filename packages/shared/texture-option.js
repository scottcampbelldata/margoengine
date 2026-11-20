// One texture option of a pass (docs/conventions.md, "Borrowed GPU objects"): a function is a per-frame getter (rule 6)
// and is read every frame; a plain texture is the caller's and belongs to the device it was given on. After a device
// restore `get` returns undefined and reports it once through `engine.onError` (`'state'`, help `borrowed-lost`) until
// `set` hands in a new one.
import { borrow, fix, lend, relend } from './borrowed.js';

export class TextureOption {
  constructor(value, name, setter) {
    this.value = value;
    this.slot = borrow(typeof value === 'function' ? undefined : value, name, setter);
  }
  /** A new value; a plain texture belongs to `device` (the engine's at this moment). */
  set(value, device) {
    this.value = value;
    relend(this.slot, typeof value === 'function' ? undefined : value, device);
  }
  /** Ties a texture given before attach to the device the pass is set up on. */
  fix(device) {
    if (device) fix(this.slot, device);
  }
  /** The texture to use on `device` this frame, or undefined (none given, or lost with its device). */
  get(device, engine) {
    const value = this.value;
    return typeof value === 'function' ? value() : lend(this.slot, device, engine);
  }
}
