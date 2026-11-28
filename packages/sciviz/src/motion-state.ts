// Internal ownership shared by Figure, Timeline and the optional accessibility view.
// Suspension leaves the caller's playback promise, options and cancellation intact.
export const reducedMotionFigures = new WeakSet<object>();
// Each Figure's redraw for while it is suspended: the loop is off, so the figure draws its changes itself.
export const stillRedraws = new WeakMap<object, () => void>();
export const timelineFigures = new WeakMap<object, object>();
