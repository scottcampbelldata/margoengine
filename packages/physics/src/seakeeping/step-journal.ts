import { hullError } from './errors.js';

interface SavedWords {
  offset: number;
  length: number;
  values: Float64Array;
}

/** Retain the words a hull update will overwrite, including only the current slot of each long history. */
export class HullStepJournal {
  private readonly saved: SavedWords[] = [];
  private count = 0;

  capture(memory: WebAssembly.Memory, offset: number, length: number): void {
    let words = this.saved[this.count];
    if (!words || words.values.length < length) {
      words = { offset, length, values: new Float64Array(length) };
      this.saved[this.count] = words;
    }
    words.offset = offset;
    words.length = length;
    words.values.set(new Float64Array(memory.buffer, offset, length));
    this.count++;
  }

  accept(memory: WebAssembly.Memory): void {
    for (let i = 0; i < this.count; i++) {
      const { offset, length } = this.saved[i]!;
      const words = new Float64Array(memory.buffer, offset, length);
      if (!words.every(Number.isFinite))
        throw hullError('failed', 'A hull history or port overflowed. Reduce the scale, pressure or speed.');
    }
    this.count = 0;
  }

  reject(memory: WebAssembly.Memory): void {
    while (this.count > 0) {
      const { offset, length, values } = this.saved[--this.count]!;
      new Float64Array(memory.buffer, offset, length).set(values.subarray(0, length));
    }
  }
}
