/** True when entity `id` or one of its ancestors is hidden (`visible = false`) in the transform store. */
export function hiddenInTree(store: { parents?: ArrayLike<number>; hidden: ArrayLike<number> }, id: number): boolean;
