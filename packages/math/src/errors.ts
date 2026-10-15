// The shared error convention (HANDOFF 1h.h, docs/conventions.md). Argument errors use the built-in classes (TypeError for a
// wrong type or shape, RangeError for a value outside its range); everything else throws a MargoError with a code.

/**
 * Why a {@link MargoError} was thrown. Stable across releases: branch on `code`, not on message text.
 * - `disposed`: the object was used after `dispose()`; create a new one.
 * - `attached`: the object is already attached to (or owned by) another engine, plugin or renderer.
 * - `state`: the call is not valid right now (re-entrant call from a callback, missing prerequisite, stale handle).
 * - `unsupported`: the browser or device lacks something the feature needs (WebGPU, OffscreenCanvas, a shader hook).
 * - `failed`: the operation ran and could not produce a result (no solution within the budget, a failed request).
 */
export type MargoErrorCode = 'disposed' | 'attached' | 'state' | 'unsupported' | 'failed';

/**
 * A Margo error that is not an argument error. The message names the subject, what went wrong and the fix
 * (`'Input is disposed; create a new Input'`). Each package bundles its own copy of this class, so `instanceof`
 * matches any Margo package's instance by name; do not subclass it.
 */
export class MargoError extends Error {
  /** Machine-readable reason; see {@link MargoErrorCode}. */
  declare readonly code: MargoErrorCode;
  /** @param code Why it was thrown. @param message Subject, problem and fix, in one sentence. */
  constructor(code: MargoErrorCode, message: string) {
    super(message);
    this.name = 'MargoError';
    this.code = code;
  }
  /** True for a MargoError thrown by any package's bundled copy (they share the name, not the class object). */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'MargoError';
  }
}
