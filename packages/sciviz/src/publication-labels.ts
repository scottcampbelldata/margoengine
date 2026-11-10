// Optional HTML labels share the existing figure overlay/export lifecycle.
const labels = new WeakMap<object, Set<HTMLElement>>();
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
