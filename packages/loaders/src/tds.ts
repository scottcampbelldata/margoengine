// A .tds file is the same 3D Studio format under another extension, so this entry is the 3DS reader's other name.
export { parse3DS as parseTDS } from './3ds.js';
export type {
  ThreeDSCamera,
  ThreeDSGroup,
  ThreeDSKey,
  ThreeDSKeyframes,
  ThreeDSLight,
  ThreeDSMaterial,
  ThreeDSNode,
  ThreeDSOptions,
  ThreeDSResult,
  ThreeDSTrack,
} from './3ds.js';
