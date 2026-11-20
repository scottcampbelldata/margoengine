/**
 * The elements of `values` (`width` numbers each) at the source vertices `vertexMap` names, in local vertex order, in
 * an array of the same kind; `values` itself when there is no map (a primitive that was not split into parts).
 */
export function vertexValues<T extends ArrayLike<number>>(values: T, width: number, vertexMap?: Uint32Array): T;
