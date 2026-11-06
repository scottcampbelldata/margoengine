/**
 * The most elements each mode could describe in `length` bytes. A group of 16 attributes needs at least stride / 4 bytes
 * (one 2-bit header per byte lane, each covering 4 groups); a triangle needs a code byte; a sequence index needs a varint
 * byte. An unknown mode has no limit here; the decoder refuses it next.
 */
export function meshoptMostElements(mode: string, length: number, stride: number): number {
  return mode === 'ATTRIBUTES'
    ? 256 * (Math.floor((4 * length) / stride) + 1)
    : mode === 'TRIANGLES'
      ? 3 * length
      : mode === 'INDICES'
        ? length
        : Number.POSITIVE_INFINITY;
}
