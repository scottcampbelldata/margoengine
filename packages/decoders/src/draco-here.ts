// The decode half of dracoHere (node-thread.ts), in its own module so the decode functions of draco-codec.ts reach a
// page only through the worker and Node reaches them only through this file, which node-thread.ts loads with import().
import { decodeDraco, decodeDracoPoints } from './draco-codec.js';
import type { DracoPointsRequest, DracoRequest } from './protocol.js';
import type { DracoModule } from './vendor-codecs.js';

/** Decode `bytes` with an already loaded Draco module, as the worker does. */
export function decodeHere<T>(
  module: DracoModule,
  bytes: ArrayBuffer,
  request: DracoRequest | DracoPointsRequest,
  points: boolean,
): T {
  return (
    points
      ? decodeDracoPoints(module, new Uint8Array(bytes), request as DracoPointsRequest)
      : decodeDraco(module, new Uint8Array(bytes), request as DracoRequest)
  ) as T;
}
