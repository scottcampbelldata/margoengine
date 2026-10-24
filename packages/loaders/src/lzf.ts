import { LoaderError } from './types.js';

/**
 * Decompresses LZF data (the format PCL writes for PCD `DATA binary_compressed`) into exactly `outputLength` bytes.
 * `format` names the calling format in errors (default 'LZF'). Every literal run and back reference is bounds checked.
 *
 * The stream is a sequence of items, each led by a control byte. Below 32 it is a literal run of control + 1 bytes.
 * Otherwise the top 3 bits are a length field (7 means one more length byte follows), the low 5 bits are the high
 * part of a 13-bit distance whose low byte comes next; the match copies length field + 2 bytes from distance + 1
 * bytes back. There is no header or end marker: the stream ends with the input.
 *
 * @throws LoaderError with code `'range'` for a bad `outputLength` or a run or reference outside the output, and
 * `'truncated'` when the input ends inside an item or before `outputLength` bytes were produced.
 */
export function decompressLZF(input: Uint8Array, outputLength: number, format = 'LZF'): Uint8Array {
  if (!Number.isSafeInteger(outputLength) || outputLength < 0)
    throw new LoaderError(format, 'range', `invalid LZF output length ${outputLength}`);
  const out = new Uint8Array(outputLength);
  const end = input.length;
  let read = 0;
  let write = 0;
  while (read < end) {
    const control = input[read++];
    if (control < 32) {
      // Literal run of 1 to 32 bytes.
      const run = control + 1;
      if (write + run > outputLength) throw new LoaderError(format, 'range', 'LZF literal run overflows the output');
      if (read + run > end) throw new LoaderError(format, 'truncated', 'LZF literal run overflows the input');
      out.set(input.subarray(read, read + run), write);
      read += run;
      write += run;
      continue;
    }
    // Back reference: 3-bit length field (7 = extended), 13-bit distance.
    let field = control >> 5;
    const needed = field === 7 ? 2 : 1;
    if (read + needed > end) throw new LoaderError(format, 'truncated', 'LZF back reference overflows the input');
    if (field === 7) field += input[read++];
    const distance = ((control & 31) << 8) + input[read++] + 1;
    const length = field + 2;
    if (write + length > outputLength)
      throw new LoaderError(format, 'range', 'LZF back reference overflows the output');
    let from = write - distance;
    if (from < 0) throw new LoaderError(format, 'range', 'LZF back reference points before the output');
    // Byte by byte, front to back, so a distance shorter than the length repeats the most recent bytes.
    for (const stop = write + length; write < stop; ) out[write++] = out[from++];
  }
  if (write !== outputLength)
    throw new LoaderError(format, 'truncated', `LZF produced ${write} bytes, expected ${outputLength}`);
  return out;
}
