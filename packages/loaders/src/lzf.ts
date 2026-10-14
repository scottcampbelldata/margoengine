import {LoaderError} from './types.js';

/**
 * Decompresses LZF data (the liblzf format used by PCD `binary_compressed`) into exactly `outputLength` bytes.
 * Every literal run and back reference is bounds checked.
 */
export function decompressLZF(input: Uint8Array, outputLength: number, format = 'LZF'): Uint8Array {
  if (!Number.isSafeInteger(outputLength) || outputLength < 0) throw new LoaderError(format, 'range', `invalid LZF output length ${outputLength}`);
  const output = new Uint8Array(outputLength);
  let ip = 0, op = 0;
  const end = input.length;
  while (ip < end) {
    let control = input[ip++];
    if (control < 32) {
      control++;
      if (op + control > outputLength) throw new LoaderError(format, 'range', 'LZF literal run overflows the output');
      if (ip + control > end) throw new LoaderError(format, 'truncated', 'LZF literal run overflows the input');
      // Runs are at most 32 bytes, so a loop beats creating a view for each one.
      for (let i = 0; i < control; i++) output[op++] = input[ip++];
    } else {
      let length = control >> 5;
      let reference = op - ((control & 0x1f) << 8) - 1;
      if (length === 7) {
        if (ip >= end) throw new LoaderError(format, 'truncated', 'LZF back reference overflows the input');
        length += input[ip++];
      }
      if (ip >= end) throw new LoaderError(format, 'truncated', 'LZF back reference overflows the input');
      reference -= input[ip++];
      length += 2;
      if (op + length > outputLength) throw new LoaderError(format, 'range', 'LZF back reference overflows the output');
      if (reference < 0) throw new LoaderError(format, 'range', 'LZF back reference points before the output');
      for (let i = 0; i < length; i++) output[op++] = output[reference++];
    }
  }
  if (op !== outputLength) throw new LoaderError(format, 'truncated', `LZF produced ${op} bytes, expected ${outputLength}`);
  return output;
}
