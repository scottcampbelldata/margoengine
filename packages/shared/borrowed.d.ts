/** A caller's GPU object, or a function that makes one for a device. */
export type Borrowable<T> = T | ((device: GPUDevice) => T);

/** State kept for one borrowed option; owners do not read its fields. */
export interface BorrowSlot<T, V = Borrowable<T>> {
  value: V | null | undefined;
  device: GPUDevice | null | undefined;
  made: T | undefined;
  told: boolean;
  readonly name: string;
  readonly setter: string;
}

/** Puts `value` in `slot`; a plain object belongs to `device` (undefined: the device of its first `lend`). */
export function relend<T, V = Borrowable<T>>(
  slot: BorrowSlot<T, V>,
  value: V | null | undefined,
  device?: GPUDevice | null,
): BorrowSlot<T, V>;

/** Fixes the device a plain object given before attach belongs to; owners call it from `setup`. */
export function fix<T, V>(slot: BorrowSlot<T, V>, device: GPUDevice | null): void;

/** A slot for an option that takes a caller's GPU object or `(device) => object`, named for its one report. */
export function borrow<T, V = Borrowable<T>>(
  value: V | null | undefined,
  name: string,
  setter: string,
  device?: GPUDevice | null,
): BorrowSlot<T, V>;

/**
 * What to bind on `device`: the function's result (made once per device), the plain object while its device is the
 * one in use, else undefined, reported once through `engine.onError` as a `'state'` MargoError linking to
 * margoengine.com/errors#borrowed-lost.
 */
export function lend<T, V>(
  slot: BorrowSlot<T, V>,
  device: GPUDevice,
  engine?: { onError(error: unknown): void },
): T | undefined;

/** True for an option object the caller wrote (a plain object), false for a GPU object or any class instance. */
export function isOptionObject(value: unknown): value is Record<string, unknown>;
