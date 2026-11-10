// Optional HTML labels share the existing figure overlay/export lifecycle.
const labels = new WeakMap<object, Set<HTMLElement>>();
const cleanups = new WeakMap<object, Set<() => void>>();
const figures = new WeakMap<HTMLCanvasElement, object>();
/** @internal Optional tools discover only a canvas's current figure. */
export function trackFigureCanvas(figure: object, canvas: HTMLCanvasElement): void {
  figures.set(canvas, figure);
  registerFigureCleanup(figure, () => {
    if (figures.get(canvas) === figure) figures.delete(canvas);
  });
}
/** @internal Weak lookup, without loading an optional entry from the root. */
export function figureAtCanvas(canvas: HTMLCanvasElement): object | undefined {
  return figures.get(canvas);
}
/** @internal Own an optional tool's listeners/resources without exporting its UI as publication labels. */
export function registerFigureCleanup(figure: object, cleanup: () => void): () => void {
  let set = cleanups.get(figure);
  if (!set) cleanups.set(figure, (set = new Set()));
  set.add(cleanup);
  return () => {
    set.delete(cleanup);
  };
}
export function publicationLabels(figure: object): HTMLElement[] {
  return [...(labels.get(figure) ?? [])];
}
export function registerPublicationLabel(figure: object, element: HTMLElement): () => void {
  let set = labels.get(figure);
  if (!set) labels.set(figure, (set = new Set()));
  set.add(element);
  return () => {
    set.delete(element);
    element.remove();
  };
}
export function disposePublicationLabels(figure: object): void {
  for (const cleanup of cleanups.get(figure) ?? []) cleanup();
  cleanups.delete(figure);
  for (const element of labels.get(figure) ?? []) element.remove();
  labels.delete(figure);
  for (const overlay of publicationOverlays(figure)) overlay.dispose();
  overlays.delete(figure);
}

/** Internal vector/raster overlay contract, shared by optional publication tools. */
export interface PublicationOverlay {
  svg(width: number, height: number): string;
  paint(context: OffscreenCanvasRenderingContext2D, width: number, height: number): void;
  dispose(): void;
}
const overlays = new WeakMap<object, Set<PublicationOverlay>>();
export function publicationOverlays(figure: object): PublicationOverlay[] {
  return [...(overlays.get(figure) ?? [])];
}
export function registerPublicationOverlay(figure: object, overlay: PublicationOverlay): () => void {
  let set = overlays.get(figure);
  if (!set) overlays.set(figure, (set = new Set()));
  set.add(overlay);
  return () => {
    set.delete(overlay);
  };
}
