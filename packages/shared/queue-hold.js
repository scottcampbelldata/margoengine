// The key of the WebGL2 layer's link hold on its queue (KB-QUALITY-WARMSERIAL1). The layer puts a function there only
// when its programs link on the driver's own threads (KHR_parallel_shader_compile): `hold(true)` makes each later
// submit that may use a program still linking wait in the queue, in order with the work after it, until all of them
// have linked and can draw, so the links of a whole frame run side by side; `hold(false)` turns that off. Kept here so
// @margoengine/quality/warm finds it without importing the layer. Core never imports this file.

/** The queue property holding the layer's `(on: boolean) => void` link hold, when there is one. */
export const HOLDS_LINKS = Symbol.for('margoengine.queue.holdsLinks');
