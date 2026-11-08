// Graph colouring of a solver's constraints, so that no two constraints of one colour write the same body: the
// constraints of a colour are independent of each other, and a solver may visit them in any order, or several at once in
// SIMD lanes, with the same result as one at a time (Catto, "Solver2D", 2024, and "SIMD Matters", 2024, as descriptions).
// Greedy first fit (Welsh and Powell, "An upper bound for the chromatic number of a graph and its application to
// timetabling problems", The Computer Journal 10, 1967, as the description of greedy colouring): each constraint takes the
// first colour where neither body it writes is taken yet. A body set in no colour (a static or kinematic body, which a
// constraint only reads) never blocks. What fits in no colour goes to the overflow, which the solver visits last, one at
// a time.
//
// The constraints are coloured in the order of a key the solver gives, lowest first, ties in constraint order (a stable
// radix sort), and the solver visits the colours from the last to the first, key order inside a colour. The 2D solver's
// key is the height along gravity, top first: measured on pyramids of 10 to 40 rows built top down and bottom up, that
// order rests stiffest and sleeps soonest of the orders tried, and it does not depend on the order a scene was built in
// (perf history entry 86). Integer work only; dimension free.
use alloc::vec::Vec;

/// Colours before the overflow.
pub const COLOURS: usize = 16;
/// The body index that stands for "writes no body".
pub const NONE: u32 = u32::MAX;

/// A colouring kept between steps so building one allocates nothing once the world has settled in size.
#[derive(Default)]
pub struct Colouring {
    /// Per colour, one bit per body: whether a constraint of the colour writes it.
    bits: Vec<u64>,
    /// Key and constraint index pairs, `key << 32 | index`, and the radix sort's second buffer.
    sorted: Vec<u64>,
    spare: Vec<u64>,
    colour: Vec<u8>,
    /// The constraints in visiting order: colour by colour from the last colour to the first, key order inside a colour,
    /// the overflow last.
    pub order: Vec<u32>,
    /// `order[starts[k]..starts[k + 1]]` holds the `k`th colour visited; `starts[COLOURS]..` is the overflow.
    pub starts: [u32; COLOURS + 2],
}

/// A key that orders floats as `<` does: the sign bit flipped for positive numbers, every bit for negative ones.
#[inline]
pub fn float_key(x: f32) -> u32 {
    let bits = x.to_bits();
    if bits >> 31 == 1 { !bits } else { bits | 1 << 31 }
}

impl Colouring {
    /// Colours constraints given by the two bodies each writes (`NONE` for a body it only reads) and their keys, of
    /// `bodies` bodies.
    pub fn build(&mut self, bodies: usize, writes: &[[u32; 2]], keys: &[u32]) {
        debug_assert_eq!(writes.len(), keys.len());
        self.sorted.clear();
        self.sorted.extend(keys.iter().enumerate().map(|(i, &k)| (k as u64) << 32 | i as u64));
        radix_sort(&mut self.sorted, &mut self.spare);

        let words = bodies.div_ceil(64);
        self.bits.clear();
        self.bits.resize(words * COLOURS, 0);
        self.colour.clear();
        self.colour.resize(writes.len(), 0);
        let mut sizes = [0u32; COLOURS + 1];
        for &entry in &self.sorted {
            let i = entry as u32 as usize;
            let [a, b] = writes[i];
            let mut chosen = COLOURS;
            for c in 0..COLOURS {
                let set = &mut self.bits[c * words..(c + 1) * words];
                let free = |x: u32, set: &[u64]| x == NONE || set[(x / 64) as usize] & (1 << (x % 64)) == 0;
                if free(a, set) && free(b, set) {
                    for x in [a, b] {
                        if x != NONE {
                            set[(x / 64) as usize] |= 1 << (x % 64);
                        }
                    }
                    chosen = c;
                    break;
                }
            }
            self.colour[i] = chosen as u8;
            sizes[chosen] += 1;
        }
        // Visit k holds colour COLOURS - 1 - k; the overflow stays last.
        let place = |c: usize| if c == COLOURS { COLOURS } else { COLOURS - 1 - c };
        self.starts[0] = 0;
        for k in 0..=COLOURS {
            let c = if k == COLOURS { COLOURS } else { COLOURS - 1 - k };
            self.starts[k + 1] = self.starts[k] + sizes[c];
        }
        let mut next = self.starts;
        self.order.clear();
        self.order.resize(writes.len(), 0);
        for &entry in &self.sorted {
            let i = entry as u32;
            let k = place(self.colour[i as usize] as usize);
            self.order[next[k] as usize] = i;
            next[k] += 1;
        }
    }

    /// Colours that hold a constraint, the overflow not counted.
    pub fn used(&self) -> u32 {
        (0..COLOURS).filter(|&k| self.starts[k + 1] > self.starts[k]).count() as u32
    }

    /// Constraints in the overflow.
    pub fn overflow(&self) -> u32 {
        self.starts[COLOURS + 1] - self.starts[COLOURS]
    }
}

/// Sorts `key << 32 | index` entries by key, stable (least significant digit first, a byte a pass, over the key's four
/// bytes; a pass whose byte is the same in every entry is skipped).
fn radix_sort(items: &mut Vec<u64>, spare: &mut Vec<u64>) {
    spare.clear();
    spare.resize(items.len(), 0);
    for byte in 4..8 {
        let shift = byte * 8;
        let mut count = [0u32; 256];
        for &x in items.iter() {
            count[(x >> shift) as usize & 255] += 1;
        }
        if count.iter().any(|&n| n as usize == items.len()) {
            continue;
        }
        let mut at = 0u32;
        for n in count.iter_mut() {
            let here = *n;
            *n = at;
            at += here;
        }
        for &x in items.iter() {
            let d = (x >> shift) as usize & 255;
            spare[count[d] as usize] = x;
            count[d] += 1;
        }
        core::mem::swap(items, spare);
    }
}
