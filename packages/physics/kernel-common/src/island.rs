// Islands and sleep. Bodies joined by touching contacts (or joints) form islands, found each step with a disjoint set
// forest: union by size and path halving (Tarjan, "Efficiency of a Good But Not Linear Set Union Algorithm", JACM 1975;
// Tarjan and van Leeuwen, "Worst-Case Analysis of Set Union Algorithms", JACM 1984), near linear in the links. An island
// sleeps as one once every body in it has been slow for the sleep time, and wakes as one (Catto, "Iterative Dynamics with
// Temporal Coherence", GDC 2005, on sleeping islands). Ties in the union go to the lower index, so the roots depend on the
// links alone and every build gives the same islands.
use alloc::vec::Vec;

/// A disjoint set forest over `0..n`.
#[derive(Default)]
pub struct UnionFind {
    parent: Vec<u32>,
    size: Vec<u32>,
}

impl UnionFind {
    pub fn new() -> Self {
        UnionFind { parent: Vec::new(), size: Vec::new() }
    }

    /// Every element its own set again, `n` of them.
    pub fn reset(&mut self, n: usize) {
        self.parent.clear();
        self.parent.extend(0..n as u32);
        self.size.clear();
        self.size.resize(n, 1);
    }

    pub fn len(&self) -> usize {
        self.parent.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    /// The root of `x`'s set, halving the path on the way.
    pub fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            let grand = self.parent[self.parent[x as usize] as usize];
            self.parent[x as usize] = grand;
            x = grand;
        }
        x
    }

    /// Joins the sets of `a` and `b`; the larger set's root stays, and of two the same size the lower one.
    pub fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        let (sa, sb) = (self.size[ra as usize], self.size[rb as usize]);
        let (keep, join) = if sa > sb || (sa == sb && ra < rb) { (ra, rb) } else { (rb, ra) };
        self.parent[join as usize] = keep;
        self.size[keep as usize] = sa + sb;
    }

    /// Island numbers from 0, in order of each island's lowest element, for every element, into `out`; returns the count.
    pub fn islands(&mut self, out: &mut Vec<u32>) -> usize {
        let n = self.parent.len();
        out.clear();
        out.resize(n, u32::MAX);
        // The root's slot holds its island's number once its lowest element has been seen.
        let mut number = Vec::new();
        number.resize(n, u32::MAX);
        let mut count = 0u32;
        for x in 0..n as u32 {
            let root = self.find(x);
            if number[root as usize] == u32::MAX {
                number[root as usize] = count;
                count += 1;
            }
            out[x as usize] = number[root as usize];
        }
        count as usize
    }
}

/// One body's sleep timer after a step of length `dt`: back to 0 while it moves faster than `threshold`, else it adds up.
#[inline]
pub fn sleep_tick(timer: f32, speed: f32, threshold: f32, dt: f32) -> f32 {
    if speed > threshold { 0.0 } else { timer + dt }
}
