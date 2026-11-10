import type { Mesh } from '@margoengine/core';
export const tagState = new WeakMap<Mesh, Set<string>>();
export const copyTagState = (source: Mesh, copy: Mesh): void => {
  const state = tagState.get(source);
  if (state) tagState.set(copy, new Set(state));
};
