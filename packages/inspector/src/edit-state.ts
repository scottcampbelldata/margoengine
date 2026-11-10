import type { Mesh } from '@margoengine/core/extension';

// Reversible deletion retains the original handles until their history entry expires.
// The optional editor owns mutations; the inspector only consults this weak membership.
export const editorDeleted = new WeakSet<Mesh>();
export const editorRetained = new WeakMap<Mesh, number>();
