// The tree broad phase: a dynamic tree of the colliders' fat boxes (van den Bergen, "Efficient Collision Detection of Complex
// Deformable Models using AABB Trees", J. Graphics Tools 2(4), 1997; the insertion cost of Goldsmith and Salmon, "Automatic Creation of
// Object Hierarchies for Ray Tracing", IEEE CG&A 7(5), 1987, as Catto's GDC 2019 "Dynamic Bounding Volume Hierarchies" sets it out).
// It finds the pairs the sweep (broad.rs) finds, over the same fat boxes and into the same pair table: a collider whose box moved is
// taken out of the tree and put back, loses the pairs whose boxes no longer meet its own, and meets the tree for the ones that do.
//
// A leaf goes where it adds the least surface (the sum of the box's face areas) to the tree. Three more things can be chosen:
//   build   how a batch of colliders that join together is made into a tree before it is hung on the one there is: one at a time;
//           top down by the binned surface area heuristic (Wald, "On fast Construction of SAH-based Bounding Volume Hierarchies",
//           IEEE Symposium on Interactive Ray Tracing 2007); or in Morton order by locally ordered clustering (Meister and Bittner,
//           "Parallel Locally-Ordered Clustering for Bounding Volume Hierarchy Construction", IEEE TVCG 24(3), 2018);
//   optimize  whether a move also rotates nodes on the way up, when a grandchild swapped with its uncle makes the two boxes smaller
//           (Kopta, Ize, Spjut, Brunvand, David and Kensler, "Fast, Effective BVH Updates for Animated Scenes", I3D 2012);
//   adaptive  whether a collider's margin is an eighth of its smallest side (capped at the world's prediction distance) in place of
//           that distance, so a large shape keeps its pairs over a larger move (see `World::fit`).
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

/// Depth of the stack a query or a descent keeps; a tree this deep has gone wrong, and a query past it leaves the rest.
const STACK: usize = 256;
/// Bins of the binned build, and the neighbours the clustering looks at each way.
const BINS: usize = 16;
const NEIGHBOURS: usize = 25;

impl World {
    #[inline(always)]
    fn node_box(&self, n: usize) -> (V3, V3) {
        (self.v(TREE_MIN_X, n), self.v(TREE_MAX_X, n))
    }

    #[inline(always)]
    fn set_node_box(&mut self, n: usize, low: V3, high: V3) {
        self.set_v(TREE_MIN_X, n, low);
        self.set_v(TREE_MAX_X, n, high);
    }

    #[inline(always)]
    fn is_leaf(&self, n: usize) -> bool {
        self.uu(TREE_LEFT, n) == NONE
    }

    /// The area of a box's six faces, half of it: the cost a node adds to a query that meets it.
    #[inline(always)]
    fn area(low: V3, high: V3) -> f32 {
        let d = high.sub(low);
        d.x * d.y + d.y * d.z + d.z * d.x
    }

    #[inline(always)]
    fn union_area(a: (V3, V3), b: (V3, V3)) -> f32 {
        Self::area(a.0.min(b.0), a.1.max(b.1))
    }

    /// A node row: the last one freed, else the next new one. NONE when the rows are used up (there are two for each collider).
    fn take_node(&mut self) -> u32 {
        let free = self.header().tree_free;
        if free != NONE {
            self.header_mut().tree_free = self.uu(TREE_PARENT, free as usize);
            return free;
        }
        let used = self.header().tree_used;
        if used >= self.header().capacity[Rows::BroadNode as usize] {
            return NONE;
        }
        self.header_mut().tree_used = used + 1;
        used
    }

    fn free_node(&mut self, n: u32) {
        self.set_u(TREE_PARENT, n as usize, self.header().tree_free);
        self.header_mut().tree_free = n;
    }

    /// Makes a leaf for collider `c` at its fat box and hangs it on the tree.
    fn tree_add(&mut self, c: usize) {
        let leaf = self.take_node();
        if leaf == NONE {
            self.header_mut().failed = 1;
            return;
        }
        let at = leaf as usize;
        self.set_node_box(at, self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
        self.set_u(TREE_LEFT, at, NONE);
        self.set_u(TREE_RIGHT, at, NONE);
        self.set_u(TREE_COLLIDER, at, c as u32);
        self.set_u(COLLIDER_LEAF, c, leaf);
        self.hang(leaf);
    }

    /// Hangs a node (a leaf, or the root of a built subtree) where it adds the least surface to the tree.
    fn hang(&mut self, node: u32) {
        let n = node as usize;
        self.set_u(TREE_PARENT, n, NONE);
        let root = self.header().tree_root;
        if root == NONE {
            self.header_mut().tree_root = node;
            return;
        }
        let new_box = self.node_box(n);
        let mut at = root as usize;
        while !self.is_leaf(at) {
            let (left, right) = (self.uu(TREE_LEFT, at) as usize, self.uu(TREE_RIGHT, at) as usize);
            let here = self.node_box(at);
            let (low, high) = (here.0.min(new_box.0), here.1.max(new_box.1));
            let combined = Self::area(low, high);
            // Making the node a sibling of the new one costs a parent of the union; going down costs the growth of every box on the way.
            let parent_cost = 2.0 * combined;
            let inherited = 2.0 * (combined - Self::area(here.0, here.1));
            let cost = |child: usize| {
                let b = self.node_box(child);
                let grown = Self::union_area(b, new_box);
                if self.is_leaf(child) { grown + inherited } else { grown - Self::area(b.0, b.1) + inherited }
            };
            let (cost_left, cost_right) = (cost(left), cost(right));
            if parent_cost < cost_left && parent_cost < cost_right {
                break;
            }
            at = if cost_left < cost_right { left } else { right };
        }
        let sibling = at;
        let old_parent = self.uu(TREE_PARENT, sibling);
        let parent = self.take_node();
        if parent == NONE {
            self.header_mut().failed = 1;
            return;
        }
        let p = parent as usize;
        let (sb, nb) = (self.node_box(sibling), self.node_box(n));
        self.set_node_box(p, sb.0.min(nb.0), sb.1.max(nb.1));
        self.set_u(TREE_PARENT, p, old_parent);
        self.set_u(TREE_COLLIDER, p, NONE);
        self.set_u(TREE_LEFT, p, sibling as u32);
        self.set_u(TREE_RIGHT, p, node);
        self.set_u(TREE_PARENT, sibling, parent);
        self.set_u(TREE_PARENT, n, parent);
        if old_parent == NONE {
            self.header_mut().tree_root = parent;
        } else if self.uu(TREE_LEFT, old_parent as usize) == sibling as u32 {
            self.set_u(TREE_LEFT, old_parent as usize, parent);
        } else {
            self.set_u(TREE_RIGHT, old_parent as usize, parent);
        }
        self.refit_up(old_parent);
    }

    /// Fits every box from `from` to the root to its children, rotating on the way when the world asks.
    fn refit_up(&mut self, from: u32) {
        let optimize = self.header().tree_optimize != 0;
        let mut at = from;
        while at != NONE {
            let n = at as usize;
            if optimize {
                self.rotate_node(n);
            }
            let (l, r) = (self.node_box(self.uu(TREE_LEFT, n) as usize), self.node_box(self.uu(TREE_RIGHT, n) as usize));
            self.set_node_box(n, l.0.min(r.0), l.1.max(r.1));
            at = self.uu(TREE_PARENT, n);
        }
    }

    /// Swaps a grandchild with the child on the other side when that makes the two inner boxes smaller (Kopta et al. 2012).
    fn rotate_node(&mut self, n: usize) {
        let (l, r) = (self.uu(TREE_LEFT, n) as usize, self.uu(TREE_RIGHT, n) as usize);
        let area = |s: &Self, a: usize| {
            let b = s.node_box(a);
            Self::area(b.0, b.1)
        };
        // (inner node, its child to move, the other child of n): the moved child takes the other's place.
        let mut best = (0.0f32, NONE as usize, NONE as usize, NONE as usize);
        for (inner, other) in [(l, r), (r, l)] {
            if self.is_leaf(inner) {
                continue;
            }
            let (ic0, ic1) = (self.uu(TREE_LEFT, inner) as usize, self.uu(TREE_RIGHT, inner) as usize);
            for (moved, kept) in [(ic0, ic1), (ic1, ic0)] {
                // The inner node would hold `kept` and `other`; `moved` goes up beside it.
                let (kb, ob) = (self.node_box(kept), self.node_box(other));
                let rebuilt = Self::union_area(kb, ob);
                let gain = area(self, inner) - rebuilt;
                if gain > best.0 + 1e-9 {
                    best = (gain, inner, moved, other);
                }
            }
        }
        let (_, inner, moved, other) = best;
        if inner == NONE as usize {
            return;
        }
        // `other` goes into `inner` where `moved` was, and `moved` takes `other`'s place under n.
        let on_left = self.uu(TREE_LEFT, inner) as usize == moved;
        if on_left {
            self.set_u(TREE_LEFT, inner, other as u32);
        } else {
            self.set_u(TREE_RIGHT, inner, other as u32);
        }
        if self.uu(TREE_LEFT, n) as usize == other {
            self.set_u(TREE_LEFT, n, moved as u32);
        } else {
            self.set_u(TREE_RIGHT, n, moved as u32);
        }
        self.set_u(TREE_PARENT, other, inner as u32);
        self.set_u(TREE_PARENT, moved, n as u32);
        let (a, b) = (self.node_box(self.uu(TREE_LEFT, inner) as usize), self.node_box(self.uu(TREE_RIGHT, inner) as usize));
        self.set_node_box(inner, a.0.min(b.0), a.1.max(b.1));
    }

    /// Takes a collider's leaf out of the tree.
    fn tree_remove(&mut self, c: usize) {
        let leaf = self.uu(COLLIDER_LEAF, c);
        if leaf == NONE {
            return;
        }
        self.set_u(COLLIDER_LEAF, c, NONE);
        let parent = self.uu(TREE_PARENT, leaf as usize);
        self.free_node(leaf);
        if parent == NONE {
            self.header_mut().tree_root = NONE;
            return;
        }
        let p = parent as usize;
        let sibling = if self.uu(TREE_LEFT, p) == leaf { self.uu(TREE_RIGHT, p) } else { self.uu(TREE_LEFT, p) };
        let grand = self.uu(TREE_PARENT, p);
        self.set_u(TREE_PARENT, sibling as usize, grand);
        if grand == NONE {
            self.header_mut().tree_root = sibling;
        } else {
            if self.uu(TREE_LEFT, grand as usize) == parent {
                self.set_u(TREE_LEFT, grand as usize, sibling);
            } else {
                self.set_u(TREE_RIGHT, grand as usize, sibling);
            }
            self.refit_up(grand);
        }
        self.free_node(parent);
    }

    /// Adds a pair with every collider whose fat box meets collider `c`'s.
    fn tree_meet(&mut self, c: usize) {
        let root = self.header().tree_root;
        if root == NONE {
            return;
        }
        let (low, high) = (self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
        let mut stack = [0u32; STACK];
        stack[0] = root;
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let n = stack[top] as usize;
            let (nl, nh) = self.node_box(n);
            if nl.x > high.x || nl.y > high.y || nl.z > high.z || nh.x < low.x || nh.y < low.y || nh.z < low.z {
                continue;
            }
            if self.is_leaf(n) {
                let other = self.uu(TREE_COLLIDER, n);
                if other as usize != c {
                    self.add_pair(c as u32, other);
                }
            } else if top + 2 <= STACK {
                stack[top] = self.uu(TREE_LEFT, n);
                stack[top + 1] = self.uu(TREE_RIGHT, n);
                top += 2;
            }
        }
    }

    /// Drops the pairs of collider `c` whose boxes no longer meet.
    fn drop_apart(&mut self, c: usize) {
        let mut row = self.uu(COLLIDER_PAIRS, c);
        while row != NONE {
            let next = self.next_pair(row, c as u32);
            let (a, b) = (self.uu(PAIR_A, row as usize), self.uu(PAIR_B, row as usize));
            if !self.boxes_overlap(a as usize, b as usize) {
                self.remove_pair(row);
            }
            row = next;
        }
    }

    /// `World::broad_update` with the tree: removed colliders go, moved boxes leave and come back and meet what they now touch, new
    /// colliders join as a batch.
    pub fn tree_update(&mut self, dt: f32) {
        let mut fresh = 0usize;
        let mut moved = 0usize;
        let mut gone = NONE;
        let mut c = self.header().pending;
        self.header_mut().pending = NONE;
        while c != NONE {
            let at = c as usize;
            let next = self.uu(COLLIDER_PENDING, at);
            let state = self.uu(COLLIDER_STATE, at) & !PENDING;
            self.set_u(COLLIDER_STATE, at, state);
            if state & REMOVED != 0 {
                if state & IN_BROAD != 0 {
                    self.drop_pairs(c);
                    self.tree_remove(at);
                }
                self.set_u(COLLIDER_PENDING, at, gone);
                gone = c;
            } else if state & IN_BROAD == 0 {
                self.set_u(LIST_NEW, fresh, c);
                fresh += 1;
            } else if self.refresh(at, dt) {
                self.set_u(LIST_MOVED, moved, c);
                moved += 1;
            }
            c = next;
        }
        while gone != NONE {
            let at = gone as usize;
            let next = self.uu(COLLIDER_PENDING, at);
            self.set_u(COLLIDER_STATE, at, 0);
            self.set_u(COLLIDER_NEXT, at, self.header().free_collider);
            self.header_mut().free_collider = gone;
            gone = next;
        }
        for slot in 0..self.header().awake as usize {
            let mut c = self.uu(FIRST_COLLIDER, self.uu(AWAKE, slot) as usize);
            while c != NONE {
                let at = c as usize;
                if self.uu(COLLIDER_STATE, at) & IN_BROAD != 0 && self.refresh(at, dt) {
                    self.set_u(LIST_MOVED, moved, c);
                    moved += 1;
                }
                c = self.uu(COLLIDER_NEXT, at);
            }
        }
        // Every moved leaf comes out first and goes back at its new box, so each then meets the final boxes.
        for i in 0..moved {
            self.tree_remove(self.uu(LIST_MOVED, i) as usize);
        }
        for i in 0..moved {
            self.tree_add(self.uu(LIST_MOVED, i) as usize);
        }
        for i in 0..moved {
            let c = self.uu(LIST_MOVED, i) as usize;
            self.drop_apart(c);
            self.tree_meet(c);
        }
        if fresh > 0 {
            self.tree_join(fresh, dt);
        }
        self.header_mut().refit = 0;
    }

    /// Fits the new colliders' boxes, builds them into the tree and finds the pairs they make.
    fn tree_join(&mut self, fresh: usize, dt: f32) {
        for i in 0..fresh {
            let c = self.uu(LIST_NEW, i) as usize;
            let (low, high) = self.reach_fitting(c, dt);
            self.fit(c, low, high);
            let state = self.uu(COLLIDER_STATE, c);
            self.set_u(COLLIDER_STATE, c, state | IN_BROAD);
        }
        match self.header().tree_build {
            1 if fresh > 1 => self.build_binned(fresh),
            2 if fresh > 1 => self.build_clustered(fresh),
            _ => {
                for i in 0..fresh {
                    self.tree_add(self.uu(LIST_NEW, i) as usize);
                }
            }
        }
        for i in 0..fresh {
            let c = self.uu(LIST_NEW, i) as usize;
            // A collider that joins again (after a change of broad phase) may have a box that no longer meets what it had.
            self.drop_apart(c);
            self.tree_meet(c);
        }
    }

    /// A leaf for each of the first `count` colliders of `LIST_NEW`, as a list in SCRATCH_A; the node of each in order.
    fn make_leaves(&mut self, count: usize) {
        for i in 0..count {
            let c = self.uu(LIST_NEW, i) as usize;
            let leaf = self.take_node();
            if leaf == NONE {
                self.header_mut().failed = 1;
                return;
            }
            let at = leaf as usize;
            self.set_node_box(at, self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
            self.set_u(TREE_LEFT, at, NONE);
            self.set_u(TREE_RIGHT, at, NONE);
            self.set_u(TREE_COLLIDER, at, c as u32);
            self.set_u(COLLIDER_LEAF, c, leaf);
            self.set_u(SCRATCH_A, i, leaf);
        }
    }

    /// Makes an inner node of two nodes.
    fn join_nodes(&mut self, a: u32, b: u32) -> u32 {
        let node = self.take_node();
        if node == NONE {
            self.header_mut().failed = 1;
            return a;
        }
        let n = node as usize;
        let (ba, bb) = (self.node_box(a as usize), self.node_box(b as usize));
        self.set_node_box(n, ba.0.min(bb.0), ba.1.max(bb.1));
        self.set_u(TREE_COLLIDER, n, NONE);
        self.set_u(TREE_LEFT, n, a);
        self.set_u(TREE_RIGHT, n, b);
        self.set_u(TREE_PARENT, a as usize, node);
        self.set_u(TREE_PARENT, b as usize, node);
        node
    }

    /// Top down: split the nodes of a range of SCRATCH_A on the widest axis of their centres at the cheapest of `BINS - 1` bin edges
    /// by the surface area heuristic, till one is left; the tree built is hung on the world's by one insertion. The ranges wait on a
    /// stack in SCRATCH_B, and each inner node is made when both of its halves are done, so the build needs no recursion.
    fn build_binned(&mut self, count: usize) {
        self.make_leaves(count);
        // A stack of work: a range of SCRATCH_A to split (kind 0), or the two last results to join under a node (kind 1), post order.
        let mut done = [NONE; STACK];
        let mut produced = 0usize;
        let mut todo = [(0u8, 0usize, 0usize); STACK];
        todo[0] = (0, 0, count);
        let mut pending = 1usize;
        while pending > 0 {
            pending -= 1;
            let (kind, start, end) = todo[pending];
            if kind == 1 {
                let (b, a) = (done[produced - 1], done[produced - 2]);
                produced -= 2;
                done[produced] = self.join_nodes(a, b);
                produced += 1;
                continue;
            }
            if end - start == 1 {
                done[produced] = self.uu(SCRATCH_A, start);
                produced += 1;
                continue;
            }
            // The centres' box and the widest axis.
            let (mut low, mut high) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(-f32::MAX, -f32::MAX, -f32::MAX));
            for i in start..end {
                let b = self.node_box(self.uu(SCRATCH_A, i) as usize);
                let centre = b.0.add(b.1).scale(0.5);
                low = low.min(centre);
                high = high.max(centre);
            }
            let span = high.sub(low);
            let axis = if span.x >= span.y && span.x >= span.z { 0 } else if span.y >= span.z { 1 } else { 2 };
            let (lo, extent) = match axis {
                0 => (low.x, span.x),
                1 => (low.y, span.y),
                _ => (low.z, span.z),
            };
            let centre_of = |s: &Self, node: u32| {
                let b = s.node_box(node as usize);
                let c = b.0.add(b.1).scale(0.5);
                match axis {
                    0 => c.x,
                    1 => c.y,
                    _ => c.z,
                }
            };
            let mid = if extent <= 0.0 {
                // Every centre alike: split the range in half by place.
                start + (end - start) / 2
            } else {
                let mut count_in = [0usize; BINS];
                let mut bin_low = [v3(f32::MAX, f32::MAX, f32::MAX); BINS];
                let mut bin_high = [v3(-f32::MAX, -f32::MAX, -f32::MAX); BINS];
                let bin_of = |c: f32| {
                    let k = ((c - lo) / extent * BINS as f32) as usize;
                    if k >= BINS { BINS - 1 } else { k }
                };
                for i in start..end {
                    let node = self.uu(SCRATCH_A, i);
                    let k = bin_of(centre_of(self, node));
                    let b = self.node_box(node as usize);
                    count_in[k] += 1;
                    bin_low[k] = bin_low[k].min(b.0);
                    bin_high[k] = bin_high[k].max(b.1);
                }
                // The cost of cutting after bin k: the left's area times its count plus the right's times its.
                let (mut best_cost, mut best_cut) = (f32::MAX, BINS / 2);
                for cut in 0..BINS - 1 {
                    let (mut ll, mut lh, mut ln) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(-f32::MAX, -f32::MAX, -f32::MAX), 0usize);
                    for k in 0..=cut {
                        if count_in[k] > 0 {
                            ll = ll.min(bin_low[k]);
                            lh = lh.max(bin_high[k]);
                            ln += count_in[k];
                        }
                    }
                    let (mut rl, mut rh, mut rn) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(-f32::MAX, -f32::MAX, -f32::MAX), 0usize);
                    for k in cut + 1..BINS {
                        if count_in[k] > 0 {
                            rl = rl.min(bin_low[k]);
                            rh = rh.max(bin_high[k]);
                            rn += count_in[k];
                        }
                    }
                    if ln == 0 || rn == 0 {
                        continue;
                    }
                    let cost = Self::area(ll, lh) * ln as f32 + Self::area(rl, rh) * rn as f32;
                    if cost < best_cost {
                        best_cost = cost;
                        best_cut = cut;
                    }
                }
                // Partition by the cut, in place.
                let mut left = start;
                for i in start..end {
                    let node = self.uu(SCRATCH_A, i);
                    if bin_of(centre_of(self, node)) <= best_cut {
                        let other = self.uu(SCRATCH_A, left);
                        self.set_u(SCRATCH_A, left, node);
                        self.set_u(SCRATCH_A, i, other);
                        left += 1;
                    }
                }
                if left == start || left == end { start + (end - start) / 2 } else { left }
            };
            if pending + 3 > STACK || produced + 2 > STACK {
                // Too deep to go on splitting: hang what is left one at a time.
                for i in start..end {
                    self.hang(self.uu(SCRATCH_A, i));
                }
                continue;
            }
            todo[pending] = (1, 0, 0);
            todo[pending + 1] = (0, mid, end);
            todo[pending + 2] = (0, start, mid);
            pending += 3;
        }
        for i in 0..produced {
            self.hang(done[i]);
        }
    }

    /// Bottom up in Morton order, by locally ordered clustering: each round every cluster finds, among the `NEIGHBOURS` on either side
    /// of it in order, the one it makes the smallest box with, and mutual choices merge, till one is left.
    fn build_clustered(&mut self, count: usize) {
        self.make_leaves(count);
        // The scene's centre box and each leaf's Morton code in LIST_MOVED, sorted with SCRATCH_A by a merge sort on the codes.
        let (mut low, mut high) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(-f32::MAX, -f32::MAX, -f32::MAX));
        for i in 0..count {
            let b = self.node_box(self.uu(SCRATCH_A, i) as usize);
            let centre = b.0.add(b.1).scale(0.5);
            low = low.min(centre);
            high = high.max(centre);
        }
        let span = high.sub(low);
        let scale = |extent: f32, value: f32| if extent > 0.0 { ((value / extent) * 1023.0) as u32 } else { 0 };
        let spread = |mut x: u32| {
            x &= 0x3ff;
            x = (x | (x << 16)) & 0x0300_00ff;
            x = (x | (x << 8)) & 0x0300_f00f;
            x = (x | (x << 4)) & 0x030c_30c3;
            (x | (x << 2)) & 0x0924_9249
        };
        for i in 0..count {
            let leaf = self.uu(SCRATCH_A, i) as usize;
            let b = self.node_box(leaf);
            let c = b.0.add(b.1).scale(0.5).sub(low);
            let code = spread(scale(span.x, c.x)) | (spread(scale(span.y, c.y)) << 1) | (spread(scale(span.z, c.z)) << 2);
            self.set_u(LIST_MOVED, i, code);
        }
        // Merge sort of (code, node) in place over SCRATCH_A with SCRATCH_B and TREE_SCRATCH as the partners.
        self.sort_by_code(count);
        // Clusters in SCRATCH_A[0..n]; each round fills SCRATCH_B with each one's nearest and compacts into SCRATCH_A.
        let mut n = count;
        while n > 1 {
            for i in 0..n {
                let a = self.uu(SCRATCH_A, i) as usize;
                let ba = self.node_box(a);
                let (mut best, mut best_area) = (NONE, f32::MAX);
                let (from, to) = (i.saturating_sub(NEIGHBOURS), (i + NEIGHBOURS + 1).min(n));
                for j in from..to {
                    if j == i {
                        continue;
                    }
                    let other = self.uu(SCRATCH_A, j) as usize;
                    let area = Self::union_area(ba, self.node_box(other));
                    if area < best_area {
                        best_area = area;
                        best = j as u32;
                    }
                }
                self.set_u(SCRATCH_B, i, best);
            }
            // Merge mutual nearest pairs (the lower index makes the node), keep the rest, in order.
            let mut kept = 0usize;
            for i in 0..n {
                let j = self.uu(SCRATCH_B, i);
                let mutual = j != NONE && self.uu(SCRATCH_B, j as usize) == i as u32;
                if mutual && (j as usize) < i {
                    continue;
                }
                let node = if mutual { self.join_nodes(self.uu(SCRATCH_A, i), self.uu(SCRATCH_A, j as usize)) } else { self.uu(SCRATCH_A, i) };
                // `kept <= i` always: the write never passes the read.
                self.set_u(TREE_SCRATCH, kept, node);
                kept += 1;
            }
            // A round that merged nothing (every choice one-sided) joins the closest in order to go on.
            if kept == n {
                let node = self.join_nodes(self.uu(SCRATCH_A, 0), self.uu(SCRATCH_A, 1));
                self.set_u(TREE_SCRATCH, 0, node);
                for i in 2..n {
                    let v = self.uu(SCRATCH_A, i);
                    self.set_u(TREE_SCRATCH, i - 1, v);
                }
                kept = n - 1;
            }
            for i in 0..kept {
                let v = self.uu(TREE_SCRATCH, i);
                self.set_u(SCRATCH_A, i, v);
            }
            n = kept;
        }
        let root = self.uu(SCRATCH_A, 0);
        self.hang(root);
    }

    /// Sorts the nodes in SCRATCH_A[0..count] by the codes in LIST_MOVED (both reordered together), a bottom-up merge sort.
    fn sort_by_code(&mut self, count: usize) {
        // Partners: the codes' copy in SCRATCH_B and the nodes' in TREE_SCRATCH, swapped each width.
        let (mut codes, mut nodes) = (LIST_MOVED, SCRATCH_A);
        let (mut codes_to, mut nodes_to) = (SCRATCH_B, TREE_SCRATCH);
        let mut width = 1;
        while width < count {
            let mut start = 0;
            while start < count {
                let (middle, end) = ((start + width).min(count), (start + 2 * width).min(count));
                let (mut left, mut right) = (start, middle);
                for out in start..end {
                    let take_right = left >= middle || (right < end && self.uu(codes, right) < self.uu(codes, left));
                    let source = if take_right { &mut right } else { &mut left };
                    self.set_u(codes_to, out, self.uu(codes, *source));
                    self.set_u(nodes_to, out, self.uu(nodes, *source));
                    *source += 1;
                }
                start = end;
            }
            core::mem::swap(&mut codes, &mut codes_to);
            core::mem::swap(&mut nodes, &mut nodes_to);
            width *= 2;
        }
        // The result is in `nodes`; SCRATCH_A is where the caller reads it.
        if nodes != SCRATCH_A {
            for i in 0..count {
                let v = self.uu(nodes, i);
                self.set_u(SCRATCH_A, i, v);
            }
        }
    }

    /// Switches the broad phase between the sweep and the tree: every collider in the broad phase goes through the new one's join
    /// again, as a batch, and the pairs it already has stay.
    pub fn switch_broad_phase(&mut self) {
        self.header_mut().endpoints = 0;
        self.header_mut().tree_root = NONE;
        self.header_mut().tree_free = NONE;
        self.header_mut().tree_used = 0;
        for c in 0..self.header().collider_rows as usize {
            self.set_u(COLLIDER_LEAF, c, NONE);
            let state = self.uu(COLLIDER_STATE, c);
            if state & IN_BROAD != 0 && state & REMOVED == 0 {
                self.set_u(COLLIDER_STATE, c, state & !IN_BROAD);
                self.mark_pending(c as u32);
            }
        }
    }
}
