// Counter-based random numbers (K02 of docs/physics-solvers.md): Philox 4x32 with ten rounds, from Salmon, Moraes, Dror and
// Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC 2011, section 3.3. A number is a pure function of its key and its
// counter, so what an element draws never depends on the order the elements are visited in, on how many threads visit them, or on
// what was drawn before: a solver asks for the numbers of (seed, solver, tick, element, stream) and gets the same bits at any
// thread count (docs/physics-framework.md, section 7, rule 5). Integer work only, so native and Wasm builds agree bit for bit.

/// The round multipliers and key increments of Philox 4x32 (Salmon et al. 2011, Table 2 and section 3.3).
const M0: u32 = 0xD251_1F53;
const M1: u32 = 0xCD9E_8D57;
const W0: u32 = 0x9E37_79B9;
const W1: u32 = 0xBB67_AE85;

/// One bijection of Philox 4x32 with ten rounds: four words of counter and two of key in, four random words out.
#[inline]
pub fn philox4x32(counter: [u32; 4], key: [u32; 2]) -> [u32; 4] {
    let (mut c, mut k) = (counter, key);
    for round in 0..10 {
        let (p0, p1) = (M0 as u64 * c[0] as u64, M1 as u64 * c[2] as u64);
        let (hi0, lo0, hi1, lo1) = ((p0 >> 32) as u32, p0 as u32, (p1 >> 32) as u32, p1 as u32);
        c = [hi1 ^ c[1] ^ k[0], lo1, hi0 ^ c[3] ^ k[1], lo0];
        if round < 9 {
            k = [k[0].wrapping_add(W0), k[1].wrapping_add(W1)];
        }
    }
    c
}

/// The numbers of one (seed, solver, tick, element) and its streams. The key is the world's seed and the solver's number, each a
/// whole 32-bit word (a solver's number is the full FNV-1a hash of its id, so a hundred solvers collide in 32 bits about once
/// in 900,000 worlds, where 16 bits would give about one in twelve); the counter is the element, the stream, and the tick's two words,
/// so a film of any length never repeats a number, and a stream is a whole word too.
#[derive(Clone, Copy, Debug)]
pub struct Random {
    key: [u32; 2],
    tick: [u32; 2],
    element: u32,
}

impl Random {
    pub fn new(seed: u32, solver: u32, tick: u64, element: u32) -> Self {
        Random { key: [seed, solver], tick: [tick as u32, (tick >> 32) as u32], element }
    }

    /// Four random words of `stream`, the same whenever it is asked.
    #[inline]
    pub fn block(&self, stream: u32) -> [u32; 4] {
        philox4x32([self.element, stream, self.tick[0], self.tick[1]], self.key)
    }

    /// Four numbers of [0, 1) of `stream`: 24 random bits each, scaled by a power of two, so every one is exact in f32.
    #[inline]
    pub fn unit_f32(&self, stream: u32) -> [f32; 4] {
        self.block(stream).map(|x| (x >> 8) as f32 * (1.0 / 16_777_216.0))
    }

    /// Two numbers of [0, 1) of `stream`: 53 random bits each, scaled by a power of two, so every one is exact in f64.
    #[inline]
    pub fn unit_f64(&self, stream: u32) -> [f64; 2] {
        let b = self.block(stream);
        let make = |hi: u32, lo: u32| ((hi as u64) << 21 | (lo >> 11) as u64) as f64 * (1.0 / 9_007_199_254_740_992.0);
        [make(b[0], b[1]), make(b[2], b[3])]
    }

    /// Four integers of [0, n) of `stream` by the multiply-shift of Lemire (2019, "Fast random integer generation in an
    /// interval"), without his rejection step: the share of each value differs from 1/n by less than n / 2^32, below any
    /// count a solver draws among, and no draw ever loops, so the number of draws never depends on the numbers drawn.
    #[inline]
    pub fn below(&self, stream: u32, n: u32) -> [u32; 4] {
        self.block(stream).map(|x| ((x as u64 * n as u64) >> 32) as u32)
    }
}
