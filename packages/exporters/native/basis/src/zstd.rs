//! Zstandard encoder from RFC 8878 sections 3.1 and 4.1, with predefined FSE
//! distributions. No implementation source or external compression crate.
const LL: [i16; 36] = [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
    -1, -1, -1, -1,
];
const ML: [i16; 53] = [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
const OF: [i16; 29] = [
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];
struct Fse {
    log: usize,
    symbols: Vec<usize>,
    bits: Vec<usize>,
    base: Vec<usize>,
}
impl Fse {
    fn new(prob: &[i16], log: usize) -> Self {
        let size = 1 << log;
        let mut symbols = vec![0; size];
        let mut next = vec![0; prob.len()];
        let mut high = size - 1;
        for (s, &p) in prob.iter().enumerate() {
            if p < 0 {
                symbols[high] = s;
                high -= 1;
                next[s] = 1;
            } else {
                next[s] = p as usize;
            }
        }
        let step = size / 2 + size / 8 + 3;
        let mut at = 0;
        for (s, &p) in prob.iter().enumerate() {
            for _ in 0..p {
                symbols[at] = s;
                loop {
                    at = (at + step) & (size - 1);
                    if at <= high {
                        break;
                    }
                }
            }
        }
        assert_eq!(at, 0);
        let mut bits = vec![0; size];
        let mut base = vec![0; size];
        for s in 0..size {
            let n = next[symbols[s]];
            next[symbols[s]] += 1;
            bits[s] = log - (usize::BITS - 1 - n.leading_zeros()) as usize;
            base[s] = (n << bits[s]) - size;
        }
        Self {
            log,
            symbols,
            bits,
            base,
        }
    }
    fn initial(&self, symbol: usize) -> usize {
        self.symbols.iter().position(|&s| s == symbol).unwrap()
    }
    fn previous(&self, symbol: usize, next: usize) -> usize {
        (0..self.symbols.len())
            .find(|&s| {
                self.symbols[s] == symbol
                    && next >= self.base[s]
                    && next - self.base[s] < (1 << self.bits[s])
            })
            .unwrap()
    }
}
#[derive(Default)]
struct Bits {
    bytes: Vec<u8>,
    at: usize,
}
impl Bits {
    fn put(&mut self, value: usize, count: usize) {
        for i in 0..count {
            if self.at / 8 == self.bytes.len() {
                self.bytes.push(0);
            }
            self.bytes[self.at / 8] |= (((value >> i) & 1) as u8) << (self.at & 7);
            self.at += 1;
        }
    }
}
fn lengths(match_length: bool) -> (Vec<usize>, Vec<usize>) {
    let extra = if match_length {
        vec![
            1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        ]
    } else {
        vec![
            1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        ]
    };
    let plain = if match_length { 32 } else { 16 };
    let count = if match_length { 53 } else { 36 };
    let mut base = Vec::new();
    let mut bits = Vec::new();
    let mut n = if match_length { 3 } else { 0 };
    for c in 0..count {
        let b = if c < plain { 0 } else { extra[c - plain] };
        base.push(n);
        bits.push(b);
        n += 1 << b;
    }
    (base, bits)
}
fn code(base: &[usize], value: usize) -> usize {
    base.iter().rposition(|&b| b <= value).unwrap()
}
#[derive(Clone)]
struct Sequence {
    literal: usize,
    length: usize,
    offset: usize,
}
fn hash(bytes: &[u8], at: usize) -> usize {
    (u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()).wrapping_mul(0x9e3779b1) >> 16)
        as usize
}
fn parse(bytes: &[u8]) -> (Vec<u8>, Vec<Sequence>) {
    let mut heads = vec![usize::MAX; 65536];
    let mut previous = vec![usize::MAX; bytes.len()];
    let mut literals = Vec::new();
    let mut sequences = Vec::new();
    let mut at = 0;
    let mut anchor = 0;
    while at + 4 <= bytes.len() {
        let h = hash(bytes, at);
        let mut candidate = heads[h];
        let mut best = 0;
        let mut distance = 0;
        for _ in 0..32 {
            if candidate == usize::MAX {
                break;
            }
            let mut length = 0;
            while at + length < bytes.len() && bytes[candidate + length] == bytes[at + length] {
                length += 1;
            }
            if length > best {
                best = length;
                distance = at - candidate;
            }
            candidate = previous[candidate];
        }
        if best < 4 {
            previous[at] = heads[h];
            heads[h] = at;
            at += 1;
            continue;
        }
        literals.extend_from_slice(&bytes[anchor..at]);
        sequences.push(Sequence {
            literal: at - anchor,
            length: best,
            offset: distance,
        });
        for i in at..at + best {
            if i + 4 <= bytes.len() {
                let key = hash(bytes, i);
                previous[i] = heads[key];
                heads[key] = i;
            }
        }
        at += best;
        anchor = at;
    }
    literals.extend_from_slice(&bytes[anchor..]);
    (literals, sequences)
}

// RFC 8878 4.1.1: forward little-endian probability description.
fn describe_fse(prob: &[i16], log: usize) -> Vec<u8> {
    let mut out = Bits::default();
    out.put(log - 5, 4);
    let mut remaining = (1 << log) + 1;
    let mut threshold = 1 << log;
    let mut width = log + 1;
    for &p in prob {
        let value = (p + 1) as usize;
        let cutoff = 2 * threshold - 1 - remaining;
        if value < cutoff {
            out.put(value, width - 1);
        } else {
            out.put(
                if value < threshold {
                    value
                } else {
                    value + cutoff
                },
                width,
            );
        }
        remaining -= p.unsigned_abs() as usize;
        if p == 0 {
            out.put(0, 2);
        }
        if remaining == 1 {
            break;
        }
        while remaining < threshold {
            threshold >>= 1;
            width -= 1;
        }
    }
    assert_eq!(remaining, 1);
    out.bytes
}

// RFC 8878 4.2.1.2: two reverse states, ending with the final two symbols.
fn packed_weights(weights: &[usize]) -> Vec<u8> {
    let mut freq = [0usize; 12];
    for &w in weights {
        freq[w] += 1;
    }
    if freq.iter().filter(|&&n| n > 0).count() == 1 {
        let dummy = usize::from(freq[0] > 0);
        freq[dummy] = 1;
    }
    let last = freq.iter().rposition(|&n| n > 0).unwrap();
    let mut prob: Vec<i16> = freq[..=last].iter().map(|&n| i16::from(n > 0)).collect();
    for _ in prob.iter().map(|&p| p as usize).sum::<usize>()..32 {
        let symbol = (0..=last)
            .filter(|&i| freq[i] > 0)
            .max_by(|&a, &b| {
                (freq[a] * (prob[b] as usize + 1)).cmp(&(freq[b] * (prob[a] as usize + 1)))
            })
            .unwrap();
        prob[symbol] += 1;
    }
    let table = Fse::new(&prob, 5);
    let n = weights.len();
    let mut states = [0; 2];
    for i in n - 2..n {
        states[i & 1] = (0..32)
            .find(|&s| table.symbols[s] == weights[i] && table.bits[s] > 0)
            .unwrap();
    }
    let mut stream = Bits::default();
    for i in (0..n - 2).rev() {
        let old = states[i & 1];
        let state = table.previous(weights[i], old);
        stream.put(old - table.base[state], table.bits[state]);
        states[i & 1] = state;
    }
    stream.put(states[1], 5);
    stream.put(states[0], 5);
    stream.put(1, 1);
    let mut out = describe_fse(&prob, 5);
    out.extend(stream.bytes);
    out
}

// Huffman's merge construction, smoothing rare counts only when necessary to
// meet Zstandard's normative eleven-bit limit. No source pixels change.
fn huffman_lengths(freq: &[usize; 256]) -> [usize; 256] {
    let mut counts = *freq;
    loop {
        let mut nodes: Vec<(usize, Vec<usize>)> = counts
            .iter()
            .enumerate()
            .filter(|&(_, &n)| n > 0)
            .map(|(s, &n)| (n, vec![s]))
            .collect();
        let mut lengths = [0usize; 256];
        while nodes.len() > 1 {
            nodes.sort_by(|a, b| a.0.cmp(&b.0).then(a.1[0].cmp(&b.1[0])));
            let (a, mut symbols) = nodes.remove(0);
            let (b, more) = nodes.remove(0);
            symbols.extend(more);
            for &s in &symbols {
                lengths[s] += 1;
            }
            nodes.push((a + b, symbols));
        }
        if *lengths.iter().max().unwrap() <= 11 {
            return lengths;
        }
        for n in &mut counts {
            *n = n.div_ceil(2);
        }
    }
}

fn huffman_literals(input: &[u8]) -> Option<Vec<u8>> {
    if input.len() < 16 {
        return None;
    }
    let mut freq = [0usize; 256];
    for &b in input {
        freq[b as usize] += 1;
    }
    if freq.iter().filter(|&&n| n > 0).count() < 2 {
        return None;
    }
    let lengths = huffman_lengths(&freq);
    let depth = *lengths.iter().max().unwrap();
    let last = freq.iter().rposition(|&n| n > 0).unwrap();
    let weights: Vec<usize> = lengths[..last]
        .iter()
        .map(|&n| if n == 0 { 0 } else { depth + 1 - n })
        .collect();
    let mut tree = Vec::new();
    if last <= 128 {
        tree.push((127 + last) as u8);
        for pair in weights.chunks(2) {
            tree.push(((pair[0] << 4) | pair.get(1).copied().unwrap_or(0)) as u8);
        }
    } else {
        let packed = packed_weights(&weights);
        if packed.len() >= 128 {
            return None;
        }
        tree.push(packed.len() as u8);
        tree.extend(packed);
    }
    let mut codes = [0usize; 256];
    let mut next = 0;
    for n in (1..=depth).rev() {
        for s in 0..=last {
            if lengths[s] == n {
                codes[s] = next >> (depth - n);
                next += 1 << (depth - n);
            }
        }
    }
    assert_eq!(next, 1 << depth);
    let streams = if input.len() < 1024 { 1 } else { 4 };
    let mut data = Vec::new();
    let mut sizes = Vec::new();
    for part in input.chunks(input.len().div_ceil(streams)) {
        let mut bits = Bits::default();
        for &b in part.iter().rev() {
            bits.put(codes[b as usize], lengths[b as usize]);
        }
        bits.put(1, 1);
        sizes.push(bits.bytes.len());
        data.extend(bits.bytes);
    }
    if streams == 4 {
        for &n in &sizes[..3] {
            tree.extend_from_slice(&(n as u16).to_le_bytes());
        }
    }
    tree.extend(data);
    let n = input.len();
    let c = tree.len();
    let (format, width, bytes) = if n < 1024 && c < 1024 {
        (0, 10, 3)
    } else if n < 16384 && c < 16384 {
        (2, 14, 4)
    } else {
        (3, 18, 5)
    };
    // Single stream must use size-format 0; otherwise four streams are present.
    if streams == 1 && format != 0 {
        return None;
    }
    let header = 2u64 | (format << 2) | ((n as u64) << 4) | ((c as u64) << (4 + width));
    let mut out = header.to_le_bytes()[..bytes].to_vec();
    out.extend(tree);
    Some(out)
}

fn literal_section(input: &[u8]) -> Vec<u8> {
    let n = input.len();
    let mut raw = if n < 32 {
        vec![(n << 3) as u8]
    } else if n < 4096 {
        ((n << 4 | 4) as u16).to_le_bytes().to_vec()
    } else {
        ((n << 4 | 12) as u32).to_le_bytes()[..3].to_vec()
    };
    raw.extend_from_slice(input);
    if let Some(packed) = huffman_literals(input) {
        if packed.len() < raw.len() {
            return packed;
        }
    }
    raw
}

fn compressed(bytes: &[u8], ll: &Fse, ml: &Fse, of: &Fse) -> Vec<u8> {
    let (literals, sequences) = parse(bytes);
    let mut out = literal_section(&literals);
    let count = sequences.len();
    if count < 128 {
        out.push(count as u8);
    } else if count < 0x7f00 {
        out.push(((count >> 8) + 128) as u8);
        out.push(count as u8);
    } else {
        out.push(255);
        out.extend_from_slice(&((count - 0x7f00) as u16).to_le_bytes());
    }
    if count == 0 {
        return out;
    }
    out.push(0); // All three predefined FSE distributions.
    let (lb, lbits) = lengths(false);
    let (mb, mbits) = lengths(true);
    let codes: Vec<[usize; 3]> = sequences
        .iter()
        .map(|s| {
            [
                code(&lb, s.literal),
                code(&mb, s.length),
                (usize::BITS - 1 - (s.offset + 3).leading_zeros()) as usize,
            ]
        })
        .collect();
    let last = codes[count - 1];
    let mut states = [
        ll.initial(last[0]),
        ml.initial(last[1]),
        of.initial(last[2]),
    ];
    let mut stream = Bits::default();
    for i in (0..count).rev() {
        let [lc, mc, oc] = codes[i];
        if i + 1 < count {
            let old = states;
            states = [
                ll.previous(lc, old[0]),
                ml.previous(mc, old[1]),
                of.previous(oc, old[2]),
            ];
            stream.put(old[2] - of.base[states[2]], of.bits[states[2]]);
            stream.put(old[1] - ml.base[states[1]], ml.bits[states[1]]);
            stream.put(old[0] - ll.base[states[0]], ll.bits[states[0]]);
        }
        stream.put(sequences[i].literal - lb[lc], lbits[lc]);
        stream.put(sequences[i].length - mb[mc], mbits[mc]);
        stream.put(sequences[i].offset + 3 - (1 << oc), oc);
    }
    stream.put(states[1], ml.log);
    stream.put(states[2], of.log);
    stream.put(states[0], ll.log);
    stream.put(1, 1);
    out.extend_from_slice(&stream.bytes);
    out
}
pub fn encode(bytes: &[u8]) -> Vec<u8> {
    let ll = Fse::new(&LL, 6);
    let ml = Fse::new(&ML, 6);
    let of = Fse::new(&OF, 5);
    let mut out = vec![0x28, 0xb5, 0x2f, 0xfd, 0xa0];
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    let chunks = bytes.chunks(131072);
    let count = chunks.len();
    for (i, chunk) in chunks.enumerate() {
        let packed = compressed(chunk, &ll, &ml, &of);
        let use_compressed = packed.len() < chunk.len();
        let size = if use_compressed {
            packed.len()
        } else {
            chunk.len()
        };
        let header = (size << 3) | if use_compressed { 4 } else { 0 } | usize::from(i + 1 == count);
        out.extend_from_slice(&(header as u32).to_le_bytes()[..3]);
        out.extend_from_slice(if use_compressed { &packed } else { chunk });
    }
    if bytes.is_empty() {
        out.extend_from_slice(&[1, 0, 0]);
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_fse_transition_has_one_inverse() {
        for table in [Fse::new(&LL, 6), Fse::new(&ML, 6), Fse::new(&OF, 5)] {
            for symbol in 0..=*table.symbols.iter().max().unwrap() {
                for next in 0..table.symbols.len() {
                    let state = table.previous(symbol, next);
                    assert_eq!(table.symbols[state], symbol);
                    assert!(
                        next >= table.base[state]
                            && next < table.base[state] + (1 << table.bits[state])
                    );
                }
            }
        }
    }
    #[test]
    fn repeated_data_uses_sequences_and_fewer_bytes() {
        let input = vec![42; 10000];
        assert!(encode(&input).len() < 50);
        let (literals, s) = parse(&input);
        assert_eq!(literals.len(), 1);
        assert_eq!(s[0].length, 9999);
        assert_eq!(s[0].offset, 1);
    }
}
