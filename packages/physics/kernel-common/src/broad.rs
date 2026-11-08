// Sweep and prune over axis-aligned boxes in N dimensions (Baraff, "Dynamic Simulation of Non-Penetrating Rigid Bodies",
// 1992, section 6.2; Cohen, Lin, Manocha, Ponamgi, "I-COLLIDE", 1995). The boxes are kept sorted by their low end on one
// axis; a sweep down that order meets each box's later neighbours until one starts past its high end, and a pair that
// also overlaps on every other axis is reported. Boxes move little between steps, so the order is restored by insertion
// sort, linear on a nearly sorted list (Baraff's coherence argument). The sweep axis is the one along which the box
// centres spread most, as a pile spread over a floor is swept across, not down; another axis takes over only once it
// spreads a quarter wider, so the pick does not flip between steps, and a change of axis sorts afresh.
//
// Each box is fat: the caller's tight box grown by a margin, refitted only when the tight box leaves it, so a resting or
// slow body keeps its box and its pairs from step to step. Pairs come out sorted by (low key, high key), so whatever the
// caller builds from them is in an order that depends on the keys alone.
use alloc::vec::Vec;
use core::cmp::Ordering;

/// A box: low and high corners.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Bounds<const N: usize> {
    pub min: [f32; N],
    pub max: [f32; N],
}

impl<const N: usize> Bounds<N> {
    /// Whether the two boxes share a point; touching faces count.
    #[inline]
    pub fn overlaps(&self, o: &Bounds<N>) -> bool {
        (0..N).all(|k| self.min[k] <= o.max[k] && o.min[k] <= self.max[k])
    }
    /// Whether `o` lies inside this box.
    #[inline]
    pub fn contains(&self, o: &Bounds<N>) -> bool {
        (0..N).all(|k| self.min[k] <= o.min[k] && o.max[k] <= self.max[k])
    }
    /// The box grown by `margin` on every side.
    #[inline]
    pub fn grown(&self, margin: f32) -> Bounds<N> {
        let mut out = *self;
        for k in 0..N {
            out.min[k] -= margin;
            out.max[k] += margin;
        }
        out
    }
}

/// The fat boxes by key, the live keys in order along the sweep axis, and the axis.
pub struct SweepPrune<const N: usize> {
    boxes: Vec<Option<Bounds<N>>>,
    order: Vec<u32>,
    axis: usize,
    /// Work counts: box pairs compared on every axis in the last sweep, and fat boxes refitted since the start.
    pub compared: u64,
    pub refits: u64,
}

impl<const N: usize> Default for SweepPrune<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> SweepPrune<N> {
    pub fn new() -> Self {
        SweepPrune { boxes: Vec::new(), order: Vec::new(), axis: 0, compared: 0, refits: 0 }
    }

    /// The fat box of `key`, if it has one.
    pub fn fat(&self, key: u32) -> Option<&Bounds<N>> {
        self.boxes.get(key as usize).and_then(|b| b.as_ref())
    }

    /// The axis the last sweep ran along.
    pub fn axis(&self) -> usize {
        self.axis
    }

    /// Gives `key` the fat box `tight` grown by `margin`, or, when it has one, refits it only if `tight` left it.
    /// Returns whether the fat box changed.
    pub fn place(&mut self, key: u32, tight: &Bounds<N>, margin: f32) -> bool {
        let i = key as usize;
        if self.boxes.len() <= i {
            self.boxes.resize(i + 1, None);
        }
        match &self.boxes[i] {
            Some(fat) if fat.contains(tight) => false,
            Some(_) => {
                self.boxes[i] = Some(tight.grown(margin));
                self.refits += 1;
                true
            }
            None => {
                self.boxes[i] = Some(tight.grown(margin));
                self.order.push(key);
                true
            }
        }
    }

    /// Takes `key`'s box out.
    pub fn remove(&mut self, key: u32) {
        if let Some(slot) = self.boxes.get_mut(key as usize) {
            if slot.take().is_some() {
                self.order.retain(|&k| k != key);
            }
        }
    }

    #[inline]
    fn low(&self, key: u32) -> f32 {
        self.boxes[key as usize].unwrap().min[self.axis]
    }

    /// Whether `a` comes before `b`: by the low end on the sweep axis, ties by key, so the order is total.
    #[inline]
    fn before(&self, a: u32, b: u32) -> bool {
        let (x, y) = (self.low(a), self.low(b));
        x < y || (x == y && a < b)
    }

    /// Picks the sweep axis, then restores the order along it.
    fn sort(&mut self) {
        let count = self.order.len();
        if count < 2 {
            return;
        }
        // Spread of the centres per axis (n times the variance), in doubles so the pick does not hinge on rounding.
        let mut spread = [0.0f64; N];
        for (k, s) in spread.iter_mut().enumerate() {
            let (mut sum, mut sum2) = (0.0f64, 0.0f64);
            for &key in &self.order {
                let b = self.boxes[key as usize].unwrap();
                let c = 0.5 * (b.min[k] as f64 + b.max[k] as f64);
                sum += c;
                sum2 += c * c;
            }
            *s = sum2 - sum * sum / count as f64;
        }
        let mut axis = self.axis;
        for k in 0..N {
            if spread[k] > 1.25 * spread[axis] {
                axis = k;
            }
        }
        if axis != self.axis {
            self.axis = axis;
            let mut order = core::mem::take(&mut self.order);
            order.sort_unstable_by(|&a, &b| if self.before(a, b) { Ordering::Less } else { Ordering::Greater });
            self.order = order;
            return;
        }
        for i in 1..count {
            let key = self.order[i];
            let mut j = i;
            while j > 0 && self.before(key, self.order[j - 1]) {
                self.order[j] = self.order[j - 1];
                j -= 1;
            }
            self.order[j] = key;
        }
    }

    /// Every pair of overlapping fat boxes that `keep(a, b)` accepts, `a < b`, sorted by (a, b), into `out`.
    pub fn pairs(&mut self, out: &mut Vec<(u32, u32)>, mut keep: impl FnMut(u32, u32) -> bool) {
        out.clear();
        self.sort();
        let axis = self.axis;
        let mut compared = 0u64;
        for i in 0..self.order.len() {
            let a = self.order[i];
            let box_a = self.boxes[a as usize].unwrap();
            for &b in &self.order[i + 1..] {
                let box_b = self.boxes[b as usize].unwrap();
                if box_b.min[axis] > box_a.max[axis] {
                    break;
                }
                compared += 1;
                if box_a.overlaps(&box_b) {
                    let pair = if a < b { (a, b) } else { (b, a) };
                    if keep(pair.0, pair.1) {
                        out.push(pair);
                    }
                }
            }
        }
        self.compared = compared;
        out.sort_unstable();
    }

    /// Every key whose fat box overlaps `query`, in key order, into `out`. Reads the order as the last sweep left it, so
    /// a box placed since is still found: the scan stops at the first box starting past the query only when sorted.
    pub fn query(&self, query: &Bounds<N>, out: &mut Vec<u32>) {
        out.clear();
        let axis = self.axis;
        let sorted = self.order.windows(2).all(|w| self.before(w[0], w[1]));
        for &key in &self.order {
            let b = self.boxes[key as usize].unwrap();
            if sorted && b.min[axis] > query.max[axis] {
                break;
            }
            if b.overlaps(query) {
                out.push(key);
            }
        }
        out.sort_unstable();
    }
}
