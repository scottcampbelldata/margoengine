import { useEffect, useReducer } from 'react';
import { useScene } from './internal.js';
import { rangeError } from '../../shared/errors.js';

/** What `useViewport` returns: the visible area at the camera's target, in world units and CSS pixels. */
export interface Viewport {
  /** World units across the view at the target distance. */
  width: number;
  /** World units from bottom to top of the view at the target distance. */
  height: number;
  /** Canvas width over height (1 before layout). */
  aspect: number;
  /** Distance from the camera to its target, in world units. */
  distance: number;
  /** CSS pixels per world unit at that distance. */
  factor: number;
  /** Canvas size in CSS pixels. */
  size: { width: number; height: number };
}
/** The view's size in world units at the camera target, or at `distance` from the camera when given. */
export function viewportAt(
  camera: { fov: number; position: readonly number[]; target: readonly number[] },
  size: { width: number; height: number },
  distance = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  ),
): Viewport {
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1,
    // The vertical field of view spans 2 tan(fov / 2) units per unit of distance.
    height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360),
    width = height * aspect;
  return { width, height, aspect, distance, factor: height > 0 ? size.height / height : 0, size: { ...size } };
}
// Re-renders the caller when the canvas changes size.
function useCanvasSize(): { width: number; height: number } {
  const canvas = useScene().engine.canvas as HTMLCanvasElement,
    [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(bump);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}
/**
 * The visible area at the camera target, read at render; the component renders again when the canvas changes size.
 * Read `useEngine().camera` inside `useFrame` for a value that follows a moving camera every frame.
 */
export function useViewport(): Viewport {
  const size = useCanvasSize();
  return viewportAt(useScene().engine.camera as unknown as Parameters<typeof viewportAt>[0], size);
}
/**
 * A `scale` for a `width` by `height` plane that covers the view at the camera target, keeping its aspect (like CSS
 * `background-size: cover`), times `factor` (default 1). Re-renders when the canvas changes size.
 */
export function useAspect(width: number, height: number, factor = 1): [number, number, number] {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    throw rangeError('useAspect: width and height must be positive and finite', 'react-arguments');
  const view = useViewport(),
    scale = view.aspect > width / height ? view.width / width : view.height / height;
  return [width * scale * factor, height * scale * factor, 1];
}
/**
 * Sets the canvas cursor to `over` (default 'pointer') while `hovered` is true and back to `out` (default 'auto') when it
 * turns false or the component unmounts. Pair it with a mesh's onPointerOver and onPointerOut.
 */
export function useCursor(hovered: boolean, over = 'pointer', out = 'auto'): void {
  const canvas = useScene().engine.canvas as HTMLCanvasElement;
  useEffect(() => {
    if (!hovered) return;
    canvas.style.cursor = over;
    return () => {
      canvas.style.cursor = out;
    };
  }, [canvas, hovered, over, out]);
}
