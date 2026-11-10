// Internal ownership shared by Figure, Timeline and the optional accessibility view.
// Suspension leaves the caller's playback promise, options and cancellation intact.
export const reducedMotionFigures = new WeakSet<object>();
export const timelineFigures = new WeakMap<object, object>();
