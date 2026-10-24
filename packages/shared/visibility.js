/** True when entity `id` or one of its ancestors is hidden (`visible = false`) in the transform store. */
export function hiddenInTree(store, id) {
  for (let slot = id; slot >= 0; slot = store.parents?.[slot] ?? -1) if (store.hidden[slot]) return true;
  return false;
}
