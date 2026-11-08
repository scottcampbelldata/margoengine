// A dynamic tree of axis-aligned boxes in N dimensions, and the pairs of overlapping boxes kept from step to step
// (van den Bergen, "Efficient Collision Detection of Complex Deformable Models using AABB Trees", Journal of Graphics
// Tools 2(4), 1997; the insertion cost of Goldsmith and Salmon, "Automatic Creation of Object Hierarchies for Ray
// Tracing", IEEE CG&A 7(5), 1987, as Catto's GDC 2019 talk "Dynamic Bounding Volume Hierarchies" presents it).
//
// Each key's box is fat, as in the sweep (broad.rs): the caller's tight box grown by a margin and refitted only when the
// tight box leaves it. A leaf is placed where it adds the least surface (perimeter in 2D, area in 3D) to the tree: going
// down from the root, a node is the new leaf's sibling when that costs less than the cheapest child could, the cost of a
// choice being the surface of the new parent plus what every ancestor grows by. A moved box is taken out and put back.
//
// Pairs are kept: the set of every two fat boxes that overlap changes only where a box moved, so each step queries the tree
// with just the boxes refitted since the last, drops the kept pairs that hold one of them, and merges in what the queries
// found. The result is the same set the sweep gives (every overlapping pair, sorted by keys), at a cost that follows the
// boxes that moved, where the sweep tests every box against its neighbours along one axis each step: on the 100-row 2D
// pyramid, 497,402 tests a step to find 14,950 pairs, as a 1D sweep sees each column of a pile as one run, where the tree
// tests 15,133 (physics2d/kernel/tests/broad.rs).
use alloc::vec::Vec;

use crate::broad::Bounds;

const NONE: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct Node<const N: usize> {
    bounds: Bounds<N>,
    parent: u32,
    child: [u32; 2],
    /// The key of a leaf; NONE for an inner node.
    key: u32,
}

/// The surface a box adds to the cost: its perimeter over 2 in 2D, its area over 2 in 3D (the sum of its extents' products
/// two at a time), its length in 1D.
#[inline]
fn surface<const N: usize>(b: &Bounds<N>) -> f32 {
    if N == 1 {
        return b.max[0] - b.min[0];
    }
    if N == 2 {
        return (b.max[0] - b.min[0]) + (b.max[1] - b.min[1]);
    }
    let mut s = 0.0;
    for i in 0..N {
        for j in i + 1..N {
            s += (b.max[i] - b.min[i]) * (b.max[j] - b.min[j]);
        }
    }
    s
}

#[inline]
fn union<const N: usize>(a: &Bounds<N>, b: &Bounds<N>) -> Bounds<N> {
    let mut out = *a;
    for k in 0..N {
        out.min[k] = a.min[k].min(b.min[k]);
        out.max[k] = a.max[k].max(b.max[k]);
    }
    out
}

/// The tree, the fat box of each key, and the kept pairs.
pub struct Tree<const N: usize> {
    nodes: Vec<Node<N>>,
    root: u32,
    free: Vec<u32>,
    /// Per key: its fat box and its leaf.
    boxes: Vec<Option<Bounds<N>>>,
    leaf: Vec<u32>,
    /// Keys whose box moved, came or went since the last `pairs`, and a mark per key.
    moved: Vec<u32>,
    marked: Vec<bool>,
    /// Every pair of overlapping fat boxes as of the last `pairs`, sorted.
    kept: Vec<(u32, u32)>,
    found: Vec<(u32, u32)>,
    merged: Vec<(u32, u32)>,
    stack: Vec<u32>,
    /// Work counts: box tests in the last `pairs` (every node a query opened), and fat boxes refitted since the start.
    pub compared: u64,
    pub refits: u64,
}

impl<const N: usize> Default for Tree<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> Tree<N> {
    pub fn new() -> Self {
        Tree {
            nodes: Vec::new(),
            root: NONE,
            free: Vec::new(),
            boxes: Vec::new(),
            leaf: Vec::new(),
            moved: Vec::new(),
            marked: Vec::new(),
            kept: Vec::new(),
            found: Vec::new(),
            merged: Vec::new(),
            stack: Vec::new(),
            compared: 0,
            refits: 0,
        }
    }

    /// The fat box of `key`, if it has one.
    pub fn fat(&self, key: u32) -> Option<&Bounds<N>> {
        self.boxes.get(key as usize).and_then(|b| b.as_ref())
    }

    fn mark(&mut self, key: u32) {
        if !self.marked[key as usize] {
            self.marked[key as usize] = true;
            self.moved.push(key);
        }
    }

    /// Gives `key` the fat box `tight` grown by `margin`, or, when it has one, refits it only if `tight` left it.
    /// Returns whether the fat box changed.
    pub fn place(&mut self, key: u32, tight: &Bounds<N>, margin: f32) -> bool {
        let i = key as usize;
        if self.boxes.len() <= i {
            self.boxes.resize(i + 1, None);
            self.leaf.resize(i + 1, NONE);
            self.marked.resize(i + 1, false);
        }
        match &self.boxes[i] {
            Some(fat) if fat.contains(tight) => false,
            Some(_) => {
                let fat = tight.grown(margin);
                self.boxes[i] = Some(fat);
                self.refits += 1;
                self.take_out(self.leaf[i]);
                self.leaf[i] = self.put_in(key, fat);
                self.mark(key);
                true
            }
            None => {
                let fat = tight.grown(margin);
                self.boxes[i] = Some(fat);
                self.leaf[i] = self.put_in(key, fat);
                self.mark(key);
                true
            }
        }
    }

    /// Takes `key`'s box out.
    pub fn remove(&mut self, key: u32) {
        let i = key as usize;
        if self.boxes.get(i).is_some_and(|b| b.is_some()) {
            self.boxes[i] = None;
            self.take_out(self.leaf[i]);
            self.leaf[i] = NONE;
            self.mark(key);
        }
    }

    fn node(&mut self, n: Node<N>) -> u32 {
        if let Some(i) = self.free.pop() {
            self.nodes[i as usize] = n;
            i
        } else {
            self.nodes.push(n);
            self.nodes.len() as u32 - 1
        }
    }

    /// Inserts a leaf for `key` and returns it.
    fn put_in(&mut self, key: u32, b: Bounds<N>) -> u32 {
        let leaf = self.node(Node { bounds: b, parent: NONE, child: [NONE; 2], key });
        if self.root == NONE {
            self.root = leaf;
            return leaf;
        }
        // The sibling, by the cost of the new parent and every ancestor's growth.
        let mut at = self.root;
        while self.nodes[at as usize].key == NONE {
            let node = self.nodes[at as usize];
            let area = surface(&node.bounds);
            let joined = surface(&union(&node.bounds, &b));
            let here = 2.0 * joined;
            let inherited = 2.0 * (joined - area);
            let cost = |c: u32| {
                let child = &self.nodes[c as usize];
                let grown = surface(&union(&child.bounds, &b));
                if child.key != NONE { grown + inherited } else { grown - surface(&child.bounds) + inherited }
            };
            let (c0, c1) = (cost(node.child[0]), cost(node.child[1]));
            if here < c0 && here < c1 {
                break;
            }
            at = if c0 <= c1 { node.child[0] } else { node.child[1] };
        }
        let sibling = at;
        let old_parent = self.nodes[sibling as usize].parent;
        let joined = union(&self.nodes[sibling as usize].bounds, &b);
        let parent = self.node(Node { bounds: joined, parent: old_parent, child: [sibling, leaf], key: NONE });
        self.nodes[sibling as usize].parent = parent;
        self.nodes[leaf as usize].parent = parent;
        if old_parent == NONE {
            self.root = parent;
        } else {
            let p = &mut self.nodes[old_parent as usize];
            if p.child[0] == sibling { p.child[0] = parent } else { p.child[1] = parent }
        }
        self.refit_from(old_parent);
        leaf
    }

    /// Grows each ancestor from `at` up to hold its children, turning each where a rotation shrinks it.
    fn refit_from(&mut self, mut at: u32) {
        while at != NONE {
            let [a, b] = self.nodes[at as usize].child;
            self.nodes[at as usize].bounds = union(&self.nodes[a as usize].bounds, &self.nodes[b as usize].bounds);
            self.rotate(at);
            at = self.nodes[at as usize].parent;
        }
    }

    /// Tree rotations (Kopta, Ize, Spjut, Brunvand, Davis, Kensler, "Fast, Effective BVH Updates for Animated Scenes",
    /// I3D 2012): a child of `at` trades places with a grandchild on the other side when that shrinks the surface of the
    /// node the grandchild left. `at` keeps the same leaves, so its box does not change. Without them, boxes put in in
    /// order along a row (a pile built row by row) grow a tree as deep as the row is long, and a query opened 1,175
    /// nodes on the 100-row pyramid.
    fn rotate(&mut self, at: u32) {
        let [b, c] = self.nodes[at as usize].child;
        // (cost change, the child that moves, the grandchild it trades with, the node between them)
        let mut best = (0.0f32, NONE, NONE, NONE);
        for (stay, inner) in [(b, c), (c, b)] {
            let node = self.nodes[inner as usize];
            if node.key != NONE {
                continue;
            }
            let [f, g] = node.child;
            let before = surface(&node.bounds);
            for (out, keep) in [(f, g), (g, f)] {
                let after = surface(&union(&self.nodes[stay as usize].bounds, &self.nodes[keep as usize].bounds));
                if after - before < best.0 {
                    best = (after - before, stay, out, inner);
                }
            }
        }
        let (_, stay, out, inner) = best;
        if stay == NONE {
            return;
        }
        // `stay` moves under `inner` in `out`'s place; `out` takes `stay`'s place under `at`.
        let a = &mut self.nodes[at as usize];
        if a.child[0] == stay { a.child[0] = out } else { a.child[1] = out }
        let n = &mut self.nodes[inner as usize];
        if n.child[0] == out { n.child[0] = stay } else { n.child[1] = stay }
        self.nodes[out as usize].parent = at;
        self.nodes[stay as usize].parent = inner;
        let [x, y] = self.nodes[inner as usize].child;
        self.nodes[inner as usize].bounds = union(&self.nodes[x as usize].bounds, &self.nodes[y as usize].bounds);
    }

    /// Removes a leaf: its sibling takes its parent's place.
    fn take_out(&mut self, leaf: u32) {
        let parent = self.nodes[leaf as usize].parent;
        self.free.push(leaf);
        if parent == NONE {
            self.root = NONE;
            return;
        }
        let p = self.nodes[parent as usize];
        let sibling = if p.child[0] == leaf { p.child[1] } else { p.child[0] };
        self.nodes[sibling as usize].parent = p.parent;
        if p.parent == NONE {
            self.root = sibling;
        } else {
            let g = &mut self.nodes[p.parent as usize];
            if g.child[0] == parent { g.child[0] = sibling } else { g.child[1] = sibling }
            self.refit_from(p.parent);
        }
        self.free.push(parent);
    }

    /// Every key but `skip` whose fat box overlaps `query`, unordered, into `out`; returns the boxes tested.
    fn visit(&mut self, query: &Bounds<N>, skip: u32, mut found: impl FnMut(u32)) -> u64 {
        let mut tested = 0u64;
        if self.root == NONE {
            return 0;
        }
        self.stack.clear();
        self.stack.push(self.root);
        while let Some(at) = self.stack.pop() {
            let node = &self.nodes[at as usize];
            tested += 1;
            if !node.bounds.overlaps(query) {
                continue;
            }
            if node.key != NONE {
                if node.key != skip {
                    found(node.key);
                }
            } else {
                self.stack.push(node.child[1]);
                self.stack.push(node.child[0]);
            }
        }
        tested
    }

    /// Every pair of overlapping fat boxes that `keep(a, b)` accepts, `a < b`, sorted by (a, b), into `out`.
    pub fn pairs(&mut self, out: &mut Vec<(u32, u32)>, mut keep: impl FnMut(u32, u32) -> bool) {
        let mut found = core::mem::take(&mut self.found);
        found.clear();
        let mut compared = 0u64;
        let moved = core::mem::take(&mut self.moved);
        for &key in &moved {
            if let Some(fat) = self.boxes[key as usize] {
                compared += self.visit(&fat, key, |other| found.push(if key < other { (key, other) } else { (other, key) }));
            }
        }
        found.sort_unstable();
        found.dedup();
        // The kept pairs that hold no moved key still overlap; merge them with what the moved keys found.
        let mut merged = core::mem::take(&mut self.merged);
        merged.clear();
        let (mut i, mut j) = (0, 0);
        let kept = &self.kept;
        let marked = &self.marked;
        loop {
            while i < kept.len() && (marked[kept[i].0 as usize] || marked[kept[i].1 as usize]) {
                i += 1;
            }
            match (i < kept.len(), j < found.len()) {
                (false, false) => break,
                (true, false) => {
                    merged.push(kept[i]);
                    i += 1;
                }
                (false, true) => {
                    merged.push(found[j]);
                    j += 1;
                }
                (true, true) => {
                    if kept[i] < found[j] {
                        merged.push(kept[i]);
                        i += 1;
                    } else {
                        merged.push(found[j]);
                        j += 1;
                    }
                }
            }
        }
        for &key in &moved {
            self.marked[key as usize] = false;
        }
        self.moved = moved;
        self.moved.clear();
        self.merged = core::mem::replace(&mut self.kept, merged);
        self.found = found;
        self.compared = compared;
        out.clear();
        out.extend(self.kept.iter().copied().filter(|&(a, b)| keep(a, b)));
    }

    /// Every key whose fat box overlaps `query`, in key order, into `out`.
    pub fn query(&mut self, query: &Bounds<N>, out: &mut Vec<u32>) {
        out.clear();
        self.visit(query, NONE, |key| out.push(key));
        out.sort_unstable();
    }
}
