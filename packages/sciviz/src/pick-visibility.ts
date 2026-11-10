import type { Layer } from './figure.js';
// Uses the owning link renderer's existing protocol; the optional picker does not import that renderer.
const LINKED_DRAW: unique symbol = Symbol.for('@margoengine/sciviz/linked-draw') as never;

/** @internal Logical source visibility, including a replacement that suppressed the original draw. */
export function pickVisible(layer: Layer): boolean {
  const source = ('cloud' in layer ? layer.cloud : 'line' in layer ? layer.line : layer) as {
    visible?: boolean; [LINKED_DRAW]?: { readonly visible: boolean };
  };
  return (source[LINKED_DRAW] ?? source).visible !== false;
}
