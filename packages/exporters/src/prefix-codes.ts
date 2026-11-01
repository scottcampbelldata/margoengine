// Canonical prefix codes for the WebP encoder.

// Huffman code lengths of at most `limit` bits. An over-long tree is rebuilt with every count raised to a doubled
// floor, which levels the tree until it fits.
export function codeLengths(counts: Uint32Array, limit: number): Uint8Array {
  const lengths = new Uint8Array(counts.length),
    used: number[] = [];
  for (let s = 0; s < counts.length; s++) if (counts[s]) used.push(s);
  for (let floor = 1; ; floor *= 2) {
    const leaves = used
        .map((symbol) => ({ symbol, count: Math.max(counts[symbol], floor) }))
        .sort((a, b) => a.count - b.count || a.symbol - b.symbol),
      weight = leaves.map((leaf) => leaf.count),
      parent: number[] = [];
    let leaf = 0,
      node = leaves.length;
    // Two queues: the leaves in order, and the merged nodes, which are created in order.
    for (let made = leaves.length; made < 2 * leaves.length - 1; made++) {
      let sum = 0;
      for (let pick = 0; pick < 2; pick++) {
        const take = leaf < leaves.length && (node >= made || weight[leaf] <= weight[node]) ? leaf++ : node++;
        parent[take] = made;
        sum += weight[take];
      }
      weight[made] = sum;
    }
    const depth = new Array<number>(weight.length).fill(0);
    let deepest = 0;
    for (let i = weight.length - 2; i >= 0; i--) {
      depth[i] = depth[parent[i]] + 1;
      deepest = Math.max(deepest, depth[i]);
    }
    if (deepest <= limit) {
      leaves.forEach((entry, i) => (lengths[entry.symbol] = depth[i]));
      return lengths;
    }
  }
}

// Canonical codes with their bits reversed: the stream packs codes most significant bit first into an LSB-first writer.
export function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const next = new Uint32Array(17),
    codes = new Uint16Array(lengths.length);
  for (const length of lengths) if (length) next[length + 1]++;
  for (let bits = 1; bits < 16; bits++) next[bits + 1] = (next[bits] + next[bits + 1]) << 1;
  for (let s = 0; s < lengths.length; s++) {
    const length = lengths[s];
    if (!length) continue;
    let code = next[length]++,
      reversed = 0;
    for (let bit = 0; bit < length; bit++, code >>= 1) reversed = (reversed << 1) | (code & 1);
    codes[s] = reversed;
  }
  return codes;
}
