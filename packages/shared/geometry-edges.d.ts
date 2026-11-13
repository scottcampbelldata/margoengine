import type { Geometry } from '@margoengine/core/extension';

/** Index pairs of the edges whose faces meet above `angle` degrees, plus open boundaries. */
export function geometryEdges(geometry: Geometry, angle: number): Uint32Array;
