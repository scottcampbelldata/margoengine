//! The MQ arithmetic decoder of T.800 Annex C (C.3), and the raw bit reader of the arithmetic coding bypass (D.6).

/// Qe, the next state after an MPS and after an LPS, and whether an LPS switches the MPS (Table C.2).
pub const STATES: [(u16, u8, u8, bool); 47] = [
    (0x5601, 1, 1, true),
    (0x3401, 2, 6, false),
    (0x1801, 3, 9, false),
    (0x0ac1, 4, 12, false),
    (0x0521, 5, 29, false),
    (0x0221, 38, 33, false),
    (0x5601, 7, 6, true),
    (0x5401, 8, 14, false),
    (0x4801, 9, 14, false),
    (0x3801, 10, 14, false),
    (0x3001, 11, 17, false),
    (0x2401, 12, 18, false),
    (0x1c01, 13, 20, false),
    (0x1601, 29, 21, false),
    (0x5601, 15, 14, true),
    (0x5401, 16, 14, false),
    (0x5101, 17, 15, false),
    (0x4801, 18, 16, false),
    (0x3801, 19, 17, false),
    (0x3401, 20, 18, false),
    (0x3001, 21, 19, false),
    (0x2801, 22, 19, false),
    (0x2401, 23, 20, false),
    (0x2201, 24, 21, false),
    (0x1c01, 25, 22, false),
    (0x1801, 26, 23, false),
    (0x1601, 27, 24, false),
    (0x1401, 28, 25, false),
    (0x1201, 29, 26, false),
    (0x1101, 30, 27, false),
    (0x0ac1, 31, 28, false),
    (0x09c1, 32, 29, false),
    (0x08a1, 33, 30, false),
    (0x0521, 34, 31, false),
    (0x0441, 35, 32, false),
    (0x02a1, 36, 33, false),
    (0x0221, 37, 34, false),
    (0x0141, 38, 35, false),
    (0x0111, 39, 36, false),
    (0x0085, 40, 37, false),
    (0x0049, 41, 38, false),
    (0x0025, 42, 39, false),
    (0x0015, 43, 40, false),
    (0x0009, 44, 41, false),
    (0x0005, 45, 42, false),
    (0x0001, 45, 43, false),
    (0x5601, 46, 46, false),
];

/// One context: its probability state index and its more probable symbol.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub state: u8,
    pub mps: u8,
}

/// The decoder registers of C.3: A (interval), C (code, with Chigh in bits 16 to 31) and the bit counter CT.
pub struct Mq<'a> {
    data: &'a [u8],
    at: usize,
    a: u32,
    c: u32,
    ct: u32,
}

impl<'a> Mq<'a> {
    /// A byte of the segment; past its end the decoder reads 0xFF, which BYTEIN takes as a marker (C.3.4).
    fn byte(&self, i: usize) -> u32 {
        *self.data.get(i).unwrap_or(&0xff) as u32
    }
    /// INITDEC (C.3.5).
    pub fn new(data: &'a [u8]) -> Mq<'a> {
        let mut d = Mq { data, at: 0, a: 0x8000, c: 0, ct: 0 };
        d.c = d.byte(0) << 16;
        d.byte_in();
        d.c <<= 7;
        d.ct -= 7;
        d.a = 0x8000;
        d
    }
    /// BYTEIN (C.3.4): a 0xFF followed by a byte above 0x8F is a marker and feeds 1 bits without advancing.
    fn byte_in(&mut self) {
        if self.byte(self.at) == 0xff {
            let next = self.byte(self.at + 1);
            if next > 0x8f {
                self.c += 0xff00;
                self.ct = 8;
            } else {
                self.at += 1;
                self.c += next << 9;
                self.ct = 7;
            }
        } else {
            self.at += 1;
            self.c += self.byte(self.at) << 8;
            self.ct = 8;
        }
    }
    fn renorm(&mut self) {
        loop {
            if self.ct == 0 {
                self.byte_in();
            }
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.a & 0x8000 != 0 {
                break;
            }
        }
    }
    /// DECODE (C.3.2, Figure C.15) of one decision in context `cx`. C holds the code less the interval's base, so
    /// below Qe is the lower sub-interval (the LPS's unless the exchange gives it to the MPS).
    pub fn decode(&mut self, cx: &mut Context) -> u32 {
        let (qe, nmps, nlps, switch) = STATES[cx.state as usize];
        let qe = qe as u32;
        self.a -= qe;
        let d;
        if (self.c >> 16) < qe {
            // LPS_EXCHANGE (Figure C.17).
            if self.a < qe {
                d = cx.mps;
                cx.state = nmps;
            } else {
                d = 1 - cx.mps;
                if switch {
                    cx.mps = 1 - cx.mps;
                }
                cx.state = nlps;
            }
            self.a = qe;
        } else {
            self.c -= qe << 16;
            if self.a & 0x8000 != 0 {
                return cx.mps as u32;
            }
            // MPS_EXCHANGE (Figure C.16).
            if self.a < qe {
                d = 1 - cx.mps;
                if switch {
                    cx.mps = 1 - cx.mps;
                }
                cx.state = nlps;
            } else {
                d = cx.mps;
                cx.state = nmps;
            }
        }
        self.renorm();
        d as u32
    }
}

/// The raw bits of a bypassed pass (D.6): most significant first, a byte after 0xFF giving only seven; past the
/// segment's end it reads 0xFF.
pub struct Raw<'a> {
    data: &'a [u8],
    at: usize,
    byte: u32,
    left: u32,
}

impl<'a> Raw<'a> {
    pub fn new(data: &'a [u8]) -> Raw<'a> {
        Raw { data, at: 0, byte: 0, left: 0 }
    }
    pub fn bit(&mut self) -> u32 {
        if self.left == 0 {
            let stuffed = self.at > 0 && self.byte == 0xff;
            self.byte = *self.data.get(self.at).unwrap_or(&0xff) as u32;
            self.at += 1;
            self.left = if stuffed { 7 } else { 8 };
        }
        self.left -= 1;
        (self.byte >> self.left) & 1
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The MQ encoder of C.2 (INITENC, CODEMPS, CODELPS, RENORME, BYTEOUT and FLUSH), for tests.
    pub struct Encoder {
        out: Vec<u8>,
        a: u32,
        c: u32,
        ct: u32,
    }
    impl Encoder {
        pub fn new() -> Encoder {
            // out[0] stands for the byte before the segment (BPST - 1).
            Encoder { out: vec![0], a: 0x8000, c: 0, ct: 12 }
        }
        fn byte_out(&mut self) {
            let b = *self.out.last().unwrap();
            if b == 0xff {
                self.out.push((self.c >> 20) as u8);
                self.c &= 0xfffff;
                self.ct = 7;
            } else if self.c < 0x8000000 {
                self.out.push((self.c >> 19) as u8);
                self.c &= 0x7ffff;
                self.ct = 8;
            } else {
                let last = self.out.len() - 1;
                self.out[last] = b + 1;
                if b + 1 == 0xff {
                    self.c &= 0x7ffffff;
                    self.out.push((self.c >> 20) as u8);
                    self.c &= 0xfffff;
                    self.ct = 7;
                } else {
                    self.out.push((self.c >> 19) as u8);
                    self.c &= 0x7ffff;
                    self.ct = 8;
                }
            }
        }
        fn renorm(&mut self) {
            loop {
                self.a <<= 1;
                self.c <<= 1;
                self.ct -= 1;
                if self.ct == 0 {
                    self.byte_out();
                }
                if self.a & 0x8000 != 0 {
                    break;
                }
            }
        }
        pub fn encode(&mut self, cx: &mut Context, d: u32) {
            let (qe, nmps, nlps, switch) = STATES[cx.state as usize];
            let qe = qe as u32;
            if d == cx.mps as u32 {
                self.a -= qe;
                if self.a & 0x8000 == 0 {
                    if self.a < qe {
                        self.a = qe;
                    } else {
                        self.c += qe;
                    }
                    cx.state = nmps;
                    self.renorm();
                } else {
                    self.c += qe;
                }
            } else {
                self.a -= qe;
                if self.a < qe {
                    self.c += qe;
                } else {
                    self.a = qe;
                }
                if switch {
                    cx.mps = 1 - cx.mps;
                }
                cx.state = nlps;
                self.renorm();
            }
        }
        pub fn finish(mut self) -> Vec<u8> {
            let temp = self.c + self.a;
            self.c |= 0xffff;
            if self.c >= temp {
                self.c -= 0x8000;
            }
            self.c <<= self.ct;
            self.byte_out();
            self.c <<= self.ct;
            self.byte_out();
            if self.out.last() == Some(&0xff) {
                self.out.pop();
            }
            self.out.remove(0);
            self.out
        }
    }

    /// A deterministic sequence of (context, bit) with skewed probabilities, for round trips.
    pub fn decisions(n: usize, seed: u32) -> Vec<(usize, u32)> {
        let mut s = seed;
        (0..n)
            .map(|i| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                let cx = (s >> 8) as usize % 5;
                // Context k gives a 1 with probability about k / 8.
                let bit = (((s >> 16) & 7) < cx as u32) as u32 ^ (i as u32 % 97 == 0) as u32;
                (cx, bit)
            })
            .collect()
    }

    #[test]
    fn mq_round_trip() {
        for seed in [1, 7, 99] {
            let seq = decisions(20000, seed);
            let mut enc = Encoder::new();
            let mut cxs = [Context::default(); 5];
            for &(cx, bit) in &seq {
                enc.encode(&mut cxs[cx], bit);
            }
            let bytes = enc.finish();
            let mut dec = Mq::new(&bytes);
            let mut cxs = [Context::default(); 5];
            for (i, &(cx, bit)) in seq.iter().enumerate() {
                assert_eq!(dec.decode(&mut cxs[cx]), bit, "decision {i}");
            }
            // Skewed sources compress.
            assert!(bytes.len() < 20000 / 8);
            // A byte after 0xFF is below 0x90 (the encoder's stuffing keeps markers out of the segment).
            for w in bytes.windows(2) {
                assert!(w[0] != 0xff || w[1] < 0x90);
            }
        }
    }

    #[test]
    fn states_are_well_formed() {
        for (i, &(qe, nmps, nlps, switch)) in STATES.iter().enumerate() {
            assert!(qe > 0 && qe <= 0x5601);
            assert!((nmps as usize) < 47 && (nlps as usize) < 47);
            // Only the three restart states switch.
            assert_eq!(switch, matches!(i, 0 | 6 | 14));
        }
    }

    #[test]
    fn raw_bits_skip_the_stuffed_bit() {
        let mut r = Raw::new(&[0xff, 0x40, 0x80]);
        let bits: Vec<u32> = (0..8 + 7 + 1).map(|_| r.bit()).collect();
        assert_eq!(&bits[..8], &[1; 8]);
        // 0x40 after 0xFF: its top bit is stuffed; the seven left are 1000000.
        assert_eq!(&bits[8..15], &[1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(bits[15], 1);
        assert!((0..7).all(|_| r.bit() == 0));
        // Past the end it reads 1s.
        assert!((0..20).all(|_| r.bit() == 1));
    }
}
