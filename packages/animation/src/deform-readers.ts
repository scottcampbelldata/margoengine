/**
 * @internal Models whose deformed vertices something besides the model's own draw reads (`DeformedPoints`), with the
 * number of readers: `Animation` keeps deforming such a model while its nodes are hidden.
 */
export const deformReaders = new WeakMap<object, number>();
