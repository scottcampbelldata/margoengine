/** A frame view as upscalers read it; a frame `PassContext['view']` satisfies this. */
type SizedView = {
  count: number;
  target?: unknown;
  viewport?: readonly number[];
  scissor?: readonly number[];
};
/**
 * The full-canvas `view` resized to `size`, undefined for no view; any other view throws MargoError `'unsupported'` with
 * `message`, or gives null without one.
 */
export function renderSizeView<V extends SizedView>(
  view: V | undefined,
  canvas: readonly [number, number],
  size: readonly [number, number],
  message: string,
): V | undefined;
export function renderSizeView<V extends SizedView>(
  view: V | undefined,
  canvas: readonly [number, number],
  size: readonly [number, number],
): V | undefined | null;
