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
}
