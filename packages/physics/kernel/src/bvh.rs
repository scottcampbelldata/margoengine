// A bounding volume hierarchy over a mesh's triangles, built top down with the binned surface area heuristic of Wald 2007
// ("On fast Construction of SAH-based Bounding Volume Hierarchies", IEEE Symposium on Interactive Ray Tracing, 33 to 40,
// read in full): at each node the centroids' box is cut into K = 16 bins of equal width along its widest axis, each bin
// counts its triangles and grows the box of their bounds, and of the K - 1 cuts between bins the one with the least
// A_L N_L + A_R N_R wins, A being half a box's surface. The ids are partitioned in place, quicksort style, so a leaf's
// triangles are one run of the id list, and the tree takes at most 2N - 1 nodes, all known before the build (section 3.6).
// The recursion stops at LEAF triangles or when no cut costs less than the leaf would (section 3.8); a centroid box with no
// width is halved by count instead, so duplicates cannot make one large leaf. Kept without allocation: the pending nodes wait on a fixed stack, and a node past MEDIAN_DEPTH is cut at
// its middle id instead, so no input can make the tree deeper than the stack.
use crate::math::*;

/// Bins a node's centroids fall into (Wald 2007, 3.7: 16 are "very close to the optimum").
pub const BINS: usize = 16;
/// A node with this many triangles or fewer is a leaf (Wald 2007, 3.8: "usually 2 or 4").
pub const LEAF: u32 = 2;
/// Below this depth the heuristic chooses the cut; past it a node is halved by count, which bounds the depth by
/// MEDIAN_DEPTH + 32 for any count that fits a u32.
pub const MEDIAN_DEPTH: usize = 48;
pub const STACK: usize = MEDIAN_DEPTH + 40;

/// What the builder reads: each triangle's bounds.
pub trait Prims {
    fn bounds(&self, prim: u32) -> (V3, V3);
}

/// Where the builder writes. Node 0 is the root; an inner node's children are `first` and `first + 1`, and `count` is 0;
/// a leaf holds `count` ids from `first` in the id list.
pub trait Nodes {
    fn set(&mut self, node: u32, min: V3, max: V3, first: u32, count: u32);
}

#[derive(Clone, Copy)]
struct Box3 {
    min: V3,
    max: V3,
}

impl Box3 {
    const EMPTY: Box3 = Box3 { min: V3 { x: f32::INFINITY, y: f32::INFINITY, z: f32::INFINITY }, max: V3 { x: f32::NEG_INFINITY, y: f32::NEG_INFINITY, z: f32::NEG_INFINITY } };
    #[inline(always)]
    fn grow(&mut self, min: V3, max: V3) {
        self.min = v3(self.min.x.min(min.x), self.min.y.min(min.y), self.min.z.min(min.z));
        self.max = v3(self.max.x.max(max.x), self.max.y.max(max.y), self.max.z.max(max.z));
    }
    /// Half the surface area, which is all the heuristic compares.
    #[inline(always)]
    fn half_area(&self) -> f32 {
        let d = self.max.sub(self.min);
        d.x * d.y + d.y * d.z + d.z * d.x
    }
}

#[inline(always)]
fn axis(v: V3, k: usize) -> f32 {
    match k {
        0 => v.x,
        1 => v.y,
        _ => v.z,
    }
}

#[inline(always)]
fn centroid(min: V3, max: V3) -> V3 {
    min.add(max).scale(0.5)
}

/// A node waiting on the stack: its index, its run of ids, its depth, and the boxes of its triangles and of their
/// centroids when its parent's bins already gave them.
#[derive(Clone, Copy)]
struct Pending {
    node: u32,
    begin: u32,
    end: u32,
    depth: u32,
    bounds: Box3,
    centroids: Box3,
    known: bool,
}

/// Builds the tree over the ids `ids` (any order of the triangles), rearranging them. Returns the nodes written. `bins`
/// holds one word a triangle, by id, for the build to keep each triangle's bin in: the partition reads it back instead of
/// binning again, and the children's boxes are the unions of their bins (section 3.4), so a level reads each triangle once.
pub fn build<P: Prims, N: Nodes>(prims: &P, ids: &mut [u32], bins: &mut [u32], nodes: &mut N) -> u32 {
    let n = ids.len() as u32;
    if n == 0 {
        return 0;
    }
    let root = Pending { node: 0, begin: 0, end: n, depth: 0, bounds: Box3::EMPTY, centroids: Box3::EMPTY, known: false };
    let mut stack = [root; STACK];
    let mut top = 1;
    let mut used = 1u32;
    while top > 0 {
        top -= 1;
        let Pending { node, begin, end, depth, mut bounds, mut centroids, known } = stack[top];
        let run = &mut ids[begin as usize..end as usize];
        if !known {
            for &id in run.iter() {
                let (lo, hi) = prims.bounds(id);
                bounds.grow(lo, hi);
                let c = centroid(lo, hi);
                centroids.grow(c, c);
            }
        }
        let count = end - begin;
        let extent = centroids.max.sub(centroids.min);
        let k = if extent.x >= extent.y && extent.x >= extent.z { 0 } else if extent.y >= extent.z { 1 } else { 2 };
        let (low, width) = (axis(centroids.min, k), axis(extent, k));
        if count <= LEAF {
            nodes.set(node, bounds.min, bounds.max, begin, count);
            continue;
        }
        let first = used;
        let (mid, left, right) = if depth as usize >= MEDIAN_DEPTH || !(width > 0.0) {
            // Halved by count around the middle centroid, ids breaking ties: a selection, so the depth stays bounded and
            // triangles with one centroid (duplicates) still split. The children find their boxes themselves.
            select(prims, run, (count / 2) as usize, k);
            (begin + count / 2, None, None)
        } else {
            // Wald 2007, 3.3: k1 = K (1 - eps) / width keeps a centroid on the right edge in the last bin.
            let k1 = BINS as f32 * (1.0 - 1e-6) / width;
            let mut boxes = [Box3::EMPTY; BINS];
            let mut middles = [Box3::EMPTY; BINS];
            let mut counts = [0u32; BINS];
            for &id in run.iter() {
                let (lo, hi) = prims.bounds(id);
                let c = centroid(lo, hi);
                let b = ((axis(c, k) - low) * k1) as usize;
                let b = if b < BINS { b } else { BINS - 1 };
                bins[id as usize] = b as u32;
                boxes[b].grow(lo, hi);
                middles[b].grow(c, c);
                counts[b] += 1;
            }
            // Section 3.5: a sweep from the left keeps the left sides, a sweep from the right prices each cut.
            let mut left_area = [0.0f32; BINS];
            let mut left_count = [0u32; BINS];
            let mut grown = Box3::EMPTY;
            let mut total = 0;
            for i in 0..BINS - 1 {
                grown.grow(boxes[i].min, boxes[i].max);
                total += counts[i];
                left_area[i] = grown.half_area();
                left_count[i] = total;
            }
            let (mut best, mut best_cost) = (BINS, f32::INFINITY);
            grown = Box3::EMPTY;
            total = 0;
            for i in (1..BINS).rev() {
                grown.grow(boxes[i].min, boxes[i].max);
                total += counts[i];
                let left = left_count[i - 1];
                if left == 0 || total == 0 {
                    continue;
                }
                let cost = left_area[i - 1] * left as f32 + grown.half_area() * total as f32;
                if cost < best_cost {
                    best_cost = cost;
                    best = i;
                }
            }
            // Section 3.8: a cut that costs no less than the leaf's A N is no cut, unless the leaf would be too big to keep.
            if best == BINS || (best_cost >= bounds.half_area() * count as f32 && count <= 4 * LEAF) {
                nodes.set(node, bounds.min, bounds.max, begin, count);
                continue;
            }
            // Section 3.6: the quicksort partition step, with the winning cut as the pivot, on the bins kept above.
            let (mut i, mut j) = (0usize, run.len());
            while i < j {
                if (bins[run[i] as usize] as usize) < best {
                    i += 1;
                } else {
                    j -= 1;
                    run.swap(i, j);
                }
            }
            let (mut l, mut r) = ((Box3::EMPTY, Box3::EMPTY), (Box3::EMPTY, Box3::EMPTY));
            for b in 0..BINS {
                let side = if b < best { &mut l } else { &mut r };
                side.0.grow(boxes[b].min, boxes[b].max);
                side.1.grow(middles[b].min, middles[b].max);
            }
            (begin + i as u32, Some(l), Some(r))
        };
        used += 2;
        nodes.set(node, bounds.min, bounds.max, first, 0);
        let child = |node: u32, begin: u32, end: u32, boxes: Option<(Box3, Box3)>| {
            let (bounds, centroids) = boxes.unwrap_or((Box3::EMPTY, Box3::EMPTY));
            Pending { node, begin, end, depth: depth + 1, bounds, centroids, known: boxes.is_some() }
        };
        // The left child is taken first, so the run of a subtree stays together in the node list too.
        stack[top] = child(first + 1, mid, end, right);
        stack[top + 1] = child(first, begin, mid, left);
        top += 2;
    }
    used
}

/// Puts the id whose centroid ranks `nth` along axis `k` at `nth`, smaller ones before it and larger after (Hoare's
/// selection, by the median of three, with the ids as the tie break so equal centroids still split).
fn select<P: Prims>(prims: &P, run: &mut [u32], nth: usize, k: usize) {
    let key = |id: u32| {
        let (lo, hi) = prims.bounds(id);
        (axis(centroid(lo, hi), k), id)
    };
    let less = |a: (f32, u32), b: (f32, u32)| a.0 < b.0 || (a.0 == b.0 && a.1 < b.1);
    let (mut lo, mut hi) = (0usize, run.len());
    while hi - lo > 1 {
        let m = lo + (hi - lo) / 2;
        let (a, b, c) = (key(run[lo]), key(run[m]), key(run[hi - 1]));
        let pivot = if less(a, b) == less(b, c) { b } else if less(b, a) == less(a, c) { a } else { c };
        // Three way split of [lo, hi): below the pivot, equal, above.
        let (mut lt, mut i, mut gt) = (lo, lo, hi);
        while i < gt {
            let x = key(run[i]);
            if less(x, pivot) {
                run.swap(lt, i);
                lt += 1;
                i += 1;
            } else if less(pivot, x) {
                gt -= 1;
                run.swap(i, gt);
            } else {
                i += 1;
            }
        }
        if nth < lt {
            hi = lt;
        } else if nth >= gt {
            lo = gt;
        } else {
            return;
        }
    }
}

/// Calls `hit` with every leaf id whose node box overlaps the box `min`..`max`, walking the tree from node 0. `node_box`
/// and `node_link` read the nodes `build` wrote; `hit` returns false to stop.
pub fn overlaps(
    min: V3,
    max: V3,
    node_box: impl Fn(u32) -> (V3, V3),
    node_link: impl Fn(u32) -> (u32, u32),
    ids: &[u32],
    mut hit: impl FnMut(u32) -> bool,
) {
    if ids.is_empty() {
        return;
    }
    let mut stack = [0u32; STACK + 1];
    let mut top = 1;
    while top > 0 {
        top -= 1;
        let node = stack[top];
        let (lo, hi) = node_box(node);
        if lo.x > max.x || lo.y > max.y || lo.z > max.z || hi.x < min.x || hi.y < min.y || hi.z < min.z {
            continue;
        }
        let (first, count) = node_link(node);
        if count == 0 {
            stack[top] = first + 1;
            stack[top + 1] = first;
            top += 2;
        } else {
            for &id in &ids[first as usize..(first + count) as usize] {
                if !hit(id) {
                    return;
                }
            }
        }
    }
}
