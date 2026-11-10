import type { Camera } from '@margoengine/core';
export interface LineTileState {
  matrix: Float32Array;
  fullWidth: number;
  fullHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export const lineTiles = new WeakMap<Camera, LineTileState>();
