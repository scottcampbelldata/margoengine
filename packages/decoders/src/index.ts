// Optional Draco, KTX2 and meshopt decoders for Margo Engine. Nothing here runs at import time, so the package is SSR-safe
// and adds nothing to @margoengine/core.
export {DracoDecoder} from './draco.js';
export type {DracoOptions, DracoDecodeOptions} from './draco.js';
export {KTX2Decoder, getSupportedTranscodeFormat, getBytesPerRow, createKTX2Texture} from './ktx2.js';
export type {KTX2Options, KTX2DecodeOptions, KTX2TextureOptions} from './ktx2.js';
export {meshoptDecodeGltfBuffer as decodeMeshoptBuffer, meshoptDecodeVertexBuffer, meshoptDecodeIndexBuffer, meshoptDecodeIndexSequence, MeshoptDecoder} from './meshopt.js';
export type {DecodedDracoGeometry, DracoAttribute, DracoRequest, KTX2Mip, TranscodeTarget, TranscodedKTX2Result} from './protocol.js';
import type {DracoDecoder} from './draco.js';
import type {KTX2Decoder} from './ktx2.js';
import type {MeshoptDecoder} from './meshopt.js';

/** Decoders for @margoengine/gltf-pro's `decoders` option, e.g. `{draco: new DracoDecoder(), meshopt: MeshoptDecoder, ktx2: new KTX2Decoder({device})}`. */
export interface GLTFDecoderHooks {
  draco?: Pick<DracoDecoder, 'decode'>;
  meshopt?: Pick<typeof MeshoptDecoder, 'decodeGltfBuffer'>;
  ktx2?: Pick<KTX2Decoder, 'transcode'>;
}
