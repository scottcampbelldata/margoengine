/** Components per element, keyed by accessor `type`. */
export const ACCESSOR_WIDTHS: Readonly<Record<string, number>>;
/** Bytes per component, keyed by `componentType`. */
export const COMPONENT_BYTES: Readonly<Record<string, number>>;
/** One little-endian component of `componentType` at byte `at` of `view`. */
export function readComponent(view: DataView, at: number, componentType: number): number;
