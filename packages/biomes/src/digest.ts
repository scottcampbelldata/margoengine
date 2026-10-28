// Canonical bytes and SHA-256 digests of biome tiles (spec 3.6, goal G4), an entry of its own: BiomeWorld.digest loads
// it on first use, and determinism checks (tests, cross-GPU runs, exports) import it directly.
import { fault } from '../../shared/errors.js';
import type { RasterLayer } from './layers.js';

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Canonical bytes of a set of layers: per layer in the given order, its name, format, size and little-endian data. */
export function canonicalBytes(layers: readonly RasterLayer[]): Uint8Array {
  const encoder = new TextEncoder(),
    parts: Uint8Array[] = [];
  for (const layer of layers) {
    const head = encoder.encode(`${layer.name}:${layer.format}:${layer.width}x${layer.depth};`);
    parts.push(head);
    const bytes = new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength);
    if (littleEndian || layer.data.BYTES_PER_ELEMENT === 1) parts.push(bytes);
    else {
      const swapped = new Uint8Array(bytes.length),
        size = layer.data.BYTES_PER_ELEMENT;
      for (let i = 0; i < bytes.length; i += size)
        for (let b = 0; b < size; b++) swapped[i + b] = bytes[i + size - 1 - b];
      parts.push(swapped);
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** SHA-256 hex digest through Web Crypto (browsers in a secure context, Node 20+, workers). */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw fault(
      'unsupported',
      'Biome digests need Web Crypto (crypto.subtle); serve the page over https or localhost',
      'biomes',
    );
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 (hex) of a tile's canonical bytes: its layers in the order it lists them. */
export function tileDigest(tile: {
  readonly layers: readonly string[];
  layer(name: string): RasterLayer | undefined;
}): Promise<string> {
  return sha256(canonicalBytes(tile.layers.map((name) => tile.layer(name)!)));
}
