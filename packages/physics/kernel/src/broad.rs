// Broad phase: sweep and prune (Cohen, Lin, Manocha, Ponamgi, I-COLLIDE, 1995). Each axis keeps the ends of every fat box
// in one sorted list. From one step to the next few ends move far, so sorting is a short walk, and an overlap can only
// start or stop where a min end and a max end change places.
//
// One step: every moved box is written first, so a crossing can test the boxes' final overlap. Then each moved end walks
// to its place, one end at a time, and the list stays sorted throughout. Every crossing sets the pair by the final boxes,
// so a pair that crosses twice ends up right, and a pair whose overlap changed crossed at least once.
//
// A pair keeps its row for life. Lookup is by open addressing, and nothing that decides an order reads the table, so
// results do not depend on its size.
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

/// How far a fat box reaches past what the step can reach, in metres: boxes stay put until a body has moved this far, and
/// the narrow phase sees a pair before it touches.
pub const MARGIN: f32 = 0.04;
/// A fat box more than this many times what it needs on an axis is fitted again, so a burst of speed leaves no big box.
const REFIT: f32 = 4.0;

/// True when the first end sorts before the second: by value, a min end before a max end at the same value, so boxes that
/// just touch count as overlapping.
#[inline(always)]
fn before(value: f32, id: u32, other: f32, other_id: u32) -> bool {
    value < other || (value == other && id & 1 == 0 && other_id & 1 == 1)
}

#[inline(always)]
fn pair_hash(a: u32, b: u32) -> u32 {
    let hash = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA6B);
    hash ^ (hash >> 15)
}

impl World {
    #[inline(always)]
    pub fn uu(&self, column: usize, at: usize) -> u32 {
        self.in_rows(column, at);
        unsafe { *self.u(column).add(at) }
    }
    #[inline(always)]
    pub fn set_u(&mut self, column: usize, at: usize, value: u32) {
        self.in_rows(column, at);
        unsafe { *self.u(column).add(at) = value }
    }

    /// The value of a box's end on an axis.
    #[inline(always)]
    fn end(&self, axis: usize, id: u32) -> f32 {
        self.s(FAT_MIN_X + axis + 3 * (id & 1) as usize, (id >> 1) as usize)
    }

    /// The box of a collider's shape at its body's pose, stretched over what the coming step can reach: its velocity and
    /// acceleration, and a turn of its centre about the body's. Macklin et al. 2019 predict the frame's motion this way,
    /// so that detection once a frame serves every substep.
    fn reach(&self, c: usize, dt: f32) -> (V3, V3) {
        let at = self.uu(COLLIDER_BODY, c) as usize;
        let flags = self.flags(at);
        let rotation = self.q(ROTATION_X, at);
        let mut center = self.v(POSITION_X, at).add(rotation.rotate(self.v(COLLIDER_X, c)));
        let turn = rotation.mul(self.q(COLLIDER_ROTATION_X, c));
        let (a, b, d) = (self.s(COLLIDER_A, c), self.s(COLLIDER_B, c), self.s(COLLIDER_C, c));
        let (extent, radius) = match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_BALL => (v3(a, a, a), a),
            SHAPE_BOX => {
                let x = turn.rotate(v3(a, 0.0, 0.0)).abs();
                let y = turn.rotate(v3(0.0, b, 0.0)).abs();
                let z = turn.rotate(v3(0.0, 0.0, d)).abs();
                (x.add(y).add(z), sqrt(a * a + b * b + d * d))
            }
            SHAPE_HULL => {
                let hull = self.uu(COLLIDER_HULL, c) as usize;
                let half = self.v(HULL_HALF_X, hull);
                let x = turn.rotate(v3(half.x, 0.0, 0.0)).abs();
                let y = turn.rotate(v3(0.0, half.y, 0.0)).abs();
                let z = turn.rotate(v3(0.0, 0.0, half.z)).abs();
                center = center.add(turn.rotate(self.v(HULL_BOX_X, hull)));
                (x.add(y).add(z), self.s(HULL_RADIUS, hull))
            }
            SHAPE_TRIMESH => {
                let mesh = self.uu(COLLIDER_HULL, c) as usize;
                let half = self.v(MESH_HALF_X, mesh);
                let x = turn.rotate(v3(half.x, 0.0, 0.0)).abs();
                let y = turn.rotate(v3(0.0, half.y, 0.0)).abs();
                let z = turn.rotate(v3(0.0, 0.0, half.z)).abs();
                center = center.add(turn.rotate(self.v(MESH_BOX_X, mesh)));
                (x.add(y).add(z), self.s(MESH_RADIUS, mesh))
            }
            _ => {
                let core = turn.rotate(v3(0.0, b, 0.0)).abs();
                (core.add(v3(a, a, a)), a + b)
            }
        };
        let (mut low, mut high) = (center.sub(extent), center.add(extent));
        let kind = flags & KIND;
        if kind != FIXED {
            let mut motion = self.v(LINEAR_X, at).scale(dt);
            let inverse_mass = self.s(INVERSE_MASS, at);
            if kind == DYNAMIC && inverse_mass > 0.0 {
                // Substeps of semi-implicit Euler reach a dt^2 (n + 1) / 2n, never more than a dt^2.
                let g = self.header().gravity;
                let pull = v3(g[0], g[1], g[2]).scale(self.s(GRAVITY_SCALE, at)).add(self.v(FORCE_X, at).scale(inverse_mass));
                motion = motion.add(pull.scale(dt * dt));
            }
            low = low.min(low.add(motion));
            high = high.max(high.add(motion));
            let w = self.v(ANGULAR_X, at);
            let spin = sqrt(w.dot(w)) * dt;
            if spin > 0.0 {
                let arm = center.sub(self.v(CENTER_X, at));
                // A turn moves a point by a chord: at most the arc, and at most the circle's width.
                let chord = if spin < 2.0 { spin } else { 2.0 };
                let pad = chord * (sqrt(arm.dot(arm)) + radius);
                let pad = v3(pad, pad, pad);
                low = low.sub(pad);
                high = high.add(pad);
            }
        }
        (low, high)
    }

    /// Writes a collider's fat box when what the step can reach has left it, or it has grown far too big. True when it did.
    fn refresh(&mut self, c: usize, dt: f32) -> bool {
        let (low, high) = self.reach(c, dt);
        let (fat_low, fat_high) = (self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
        let inside = low.x >= fat_low.x
            && low.y >= fat_low.y
            && low.z >= fat_low.z
            && high.x <= fat_high.x
            && high.y <= fat_high.y
            && high.z <= fat_high.z;
        if inside {
            let need = high.sub(low).add(v3(2.0 * MARGIN, 2.0 * MARGIN, 2.0 * MARGIN)).scale(REFIT);
            let size = fat_high.sub(fat_low);
            if size.x <= need.x && size.y <= need.y && size.z <= need.z {
                return false;
            }
        }
        self.fit(c, low, high);
        true
    }

    #[inline(always)]
    fn fit(&mut self, c: usize, low: V3, high: V3) {
        let margin = v3(MARGIN, MARGIN, MARGIN);
        self.set_v(FAT_MIN_X, c, low.sub(margin));
        self.set_v(FAT_MAX_X, c, high.add(margin));
    }

    /// True when two fat boxes overlap; touching counts.
    #[inline(always)]
    pub fn boxes_overlap(&self, a: usize, b: usize) -> bool {
        let (a_low, a_high, b_low, b_high) = (self.v(FAT_MIN_X, a), self.v(FAT_MAX_X, a), self.v(FAT_MIN_X, b), self.v(FAT_MAX_X, b));
        a_low.x <= b_high.x
            && b_low.x <= a_high.x
            && a_low.y <= b_high.y
            && b_low.y <= a_high.y
            && a_low.z <= b_high.z
            && b_low.z <= a_high.z
    }

    /// Finds the world's pairs for this step: removed colliders go, moved boxes walk, new colliders join.
    pub fn broad_update(&mut self, dt: f32) {
        let mut fresh = 0usize;
        let mut moved = 0usize;
        let mut gone = NONE;
        let mut dropped = false;
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
                    dropped = true;
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
        if dropped {
            self.compact();
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
        for i in 0..moved {
            let id = self.uu(LIST_MOVED, i) << 1;
            for axis in 0..3 {
                self.walk(axis, id | 1);
                self.walk(axis, id);
            }
        }
        if fresh > 0 {
            self.join(fresh, dt);
        }
    }

    /// One end walks from where it sat to where its value belongs. Each min end and max end it passes is a crossing.
    fn walk(&mut self, axis: usize, id: u32) {
        let rank_column = RANK_MIN_X + axis + 3 * (id & 1) as usize;
        let c = (id >> 1) as usize;
        let value = self.end(axis, id);
        let mut at = self.uu(rank_column, c) as usize;
        let count = self.header().endpoints as usize;
        let (values, ids) = (ENDPOINT_VALUE_X + axis, ENDPOINT_ID_X + axis);
        while at > 0 {
            let (other, other_id) = (self.s(values, at - 1), self.uu(ids, at - 1));
            if !before(value, id, other, other_id) {
                break;
            }
            self.shift(axis, at, other, other_id);
            self.crossing(id, other_id);
            at -= 1;
        }
        while at + 1 < count {
            let (other, other_id) = (self.s(values, at + 1), self.uu(ids, at + 1));
            if !before(other, other_id, value, id) {
                break;
            }
            self.shift(axis, at, other, other_id);
            self.crossing(id, other_id);
            at += 1;
        }
        self.set_s(values, at, value);
        self.set_u(ids, at, id);
        self.set_u(rank_column, c, at as u32);
    }

    /// Puts an end at `at` in a list and records its rank.
    #[inline(always)]
    fn shift(&mut self, axis: usize, at: usize, value: f32, id: u32) {
        self.set_s(ENDPOINT_VALUE_X + axis, at, value);
        self.set_u(ENDPOINT_ID_X + axis, at, id);
        self.set_u(RANK_MIN_X + axis + 3 * (id & 1) as usize, (id >> 1) as usize, at as u32);
    }

    /// Two ends passed each other. Only a min and a max of two boxes matter; the final boxes decide the pair.
    #[inline(always)]
    fn crossing(&mut self, id: u32, other: u32) {
        if (id ^ other) & 1 == 0 || id >> 1 == other >> 1 {
            return;
        }
        let (a, b) = (id >> 1, other >> 1);
        if self.boxes_overlap(a as usize, b as usize) {
            self.add_pair(a, b);
        } else {
            let row = self.find_pair(a, b);
            if row != NONE {
                self.remove_pair(row);
            }
        }
    }

    /// Drops the ends of every removed collider from the lists, in one pass.
    fn compact(&mut self) {
        let count = self.header().endpoints as usize;
        let mut kept = 0;
        for axis in 0..3 {
            kept = 0;
            for at in 0..count {
                let id = self.uu(ENDPOINT_ID_X + axis, at);
                if self.uu(COLLIDER_STATE, (id >> 1) as usize) & REMOVED == 0 {
                    self.shift(axis, kept, self.s(ENDPOINT_VALUE_X + axis, at), id);
                    kept += 1;
                }
            }
        }
        self.header_mut().endpoints = kept as u32;
    }

    /// Adds new colliders in one go: sorts their ends, merges them into each list, then one sweep along the widest axis
    /// finds every pair with a new collider in it.
    fn join(&mut self, fresh: usize, dt: f32) {
        for i in 0..fresh {
            let c = self.uu(LIST_NEW, i) as usize;
            let (low, high) = self.reach(c, dt);
            self.fit(c, low, high);
            let state = self.uu(COLLIDER_STATE, c);
            self.set_u(COLLIDER_STATE, c, state | IN_BROAD | JOINING);
        }
        for axis in 0..3 {
            self.merge_new(axis, fresh);
        }
        self.header_mut().endpoints += 2 * fresh as u32;
        self.sweep(fresh);
    }

    /// Stable bottom-up merge sort of the new ends, then a merge from the top of the list down, so nothing moves twice.
    fn merge_new(&mut self, axis: usize, fresh: usize) {
        let new = 2 * fresh;
        for i in 0..fresh {
            let id = self.uu(LIST_NEW, i) << 1;
            self.set_u(SCRATCH_A, 2 * i, id);
            self.set_u(SCRATCH_A, 2 * i + 1, id | 1);
        }
        let (mut from, mut to) = (SCRATCH_A, SCRATCH_B);
        let mut width = 1;
        while width < new {
            let mut start = 0;
            while start < new {
                let (middle, end) = ((start + width).min(new), (start + 2 * width).min(new));
                let (mut left, mut right) = (start, middle);
                for out in start..end {
                    let take_right = left >= middle || (right < end && {
                        let (r, l) = (self.uu(from, right), self.uu(from, left));
                        before(self.end(axis, r), r, self.end(axis, l), l)
                    });
                    let source = if take_right { &mut right } else { &mut left };
                    self.set_u(to, out, self.uu(from, *source));
                    *source += 1;
                }
                start = end;
            }
            core::mem::swap(&mut from, &mut to);
            width *= 2;
        }
        let (values, ids) = (ENDPOINT_VALUE_X + axis, ENDPOINT_ID_X + axis);
        let mut old = self.header().endpoints as usize;
        let mut incoming = new;
        while incoming > 0 {
            let id = self.uu(from, incoming - 1);
            let value = self.end(axis, id);
            let out = old + incoming - 1;
            // At equal keys the list's own end stays first.
            if old > 0 && before(value, id, self.s(values, old - 1), self.uu(ids, old - 1)) {
                self.shift(axis, out, self.s(values, old - 1), self.uu(ids, old - 1));
                old -= 1;
            } else {
                self.shift(axis, out, value, id);
                incoming -= 1;
            }
        }
    }

    /// Walks the widest axis once, keeping the boxes open at each point in two lists, so old boxes are never compared with
    /// each other. A box's min end starts it; it meets every box already open.
    fn sweep(&mut self, fresh: usize) {
        let count = self.header().endpoints as usize;
        let mut axis = 0;
        let mut widest = -1.0f32;
        for candidate in 0..3 {
            let values = ENDPOINT_VALUE_X + candidate;
            let width = self.s(values, count - 1) - self.s(values, 0);
            if width > widest {
                widest = width;
                axis = candidate;
            }
        }
        // SCRATCH_A holds the open new boxes from 0 and the open old ones from the middle; SCRATCH_B a box's place.
        let middle = self.header().capacity[1] as usize;
        let (mut open_new, mut open_old) = (0usize, 0usize);
        let mut left = fresh;
        for at in 0..count {
            let id = self.uu(ENDPOINT_ID_X + axis, at);
            let c = id >> 1;
            let joining = self.uu(COLLIDER_STATE, c as usize) & JOINING != 0;
            if id & 1 == 0 {
                for i in 0..open_new {
                    let other = self.uu(SCRATCH_A, i);
                    if self.boxes_overlap(c as usize, other as usize) {
                        self.add_pair(c, other);
                    }
                }
                if joining {
                    for i in 0..open_old {
                        let other = self.uu(SCRATCH_A, middle + i);
                        if self.boxes_overlap(c as usize, other as usize) {
                            self.add_pair(c, other);
                        }
                    }
                    self.set_u(SCRATCH_A, open_new, c);
                    self.set_u(SCRATCH_B, c as usize, open_new as u32);
                    open_new += 1;
                } else {
                    self.set_u(SCRATCH_A, middle + open_old, c);
                    self.set_u(SCRATCH_B, c as usize, open_old as u32);
                    open_old += 1;
                }
            } else {
                let (base, open) = if joining { (0, &mut open_new) } else { (middle, &mut open_old) };
                *open -= 1;
                let hole = self.uu(SCRATCH_B, c as usize) as usize;
                let last = self.uu(SCRATCH_A, base + *open);
                self.set_u(SCRATCH_A, base + hole, last);
                self.set_u(SCRATCH_B, last as usize, hole as u32);
                if joining {
                    left -= 1;
                    if left == 0 {
                        break;
                    }
                }
            }
        }
        for i in 0..fresh {
            let c = self.uu(LIST_NEW, i) as usize;
            let state = self.uu(COLLIDER_STATE, c);
            self.set_u(COLLIDER_STATE, c, state & !JOINING);
        }
    }

    /// The row of a pair, or NONE.
    pub fn find_pair(&self, a: u32, b: u32) -> u32 {
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let mask = self.header().capacity[4] - 1;
        let mut slot = pair_hash(a, b) & mask;
        loop {
            let entry = self.uu(PAIR_TABLE, slot as usize);
            if entry == 0 {
                return NONE;
            }
            let row = (entry - 1) as usize;
            if self.uu(PAIR_A, row) == a && self.uu(PAIR_B, row) == b {
                return row as u32;
            }
            slot = (slot + 1) & mask;
        }
    }

    /// Writes a row into the table's first empty slot after the pair's hash.
    fn table_insert(&mut self, row: u32) {
        let at = row as usize;
        let mask = self.header().capacity[4] - 1;
        let mut slot = pair_hash(self.uu(PAIR_A, at), self.uu(PAIR_B, at)) & mask;
        while self.uu(PAIR_TABLE, slot as usize) != 0 {
            slot = (slot + 1) & mask;
        }
        self.set_u(PAIR_TABLE, slot as usize, row + 1);
    }

    /// Doubles the pair rows and the table, then fills the table again. False when memory cannot.
    fn grow_pairs(&mut self) -> bool {
        let capacity = self.header().capacity;
        let rows = capacity[3] * 2;
        let hulls = [capacity[7], capacity[8], capacity[9], capacity[10]];
        if rows > MAX_PAIRS || !self.grow(capacities(capacity[0], capacity[1], rows, hulls, capacity[11], mesh_capacity(&capacity))) {
            return false;
        }
        for slot in 0..self.header().capacity[4] as usize {
            self.set_u(PAIR_TABLE, slot, 0);
        }
        for row in 0..self.header().pair_rows {
            if self.uu(PAIR_A, row as usize) != NONE && self.uu(PAIR_FLAGS, row as usize) & PAIR_IS_PART == 0 {
                self.table_insert(row);
            }
        }
        true
    }

    /// Adds a pair unless it exists, or its colliders can never touch: one body's own, or two fixed bodies'.
    pub fn add_pair(&mut self, a: u32, b: u32) {
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let (body_a, body_b) = (self.uu(COLLIDER_BODY, a as usize), self.uu(COLLIDER_BODY, b as usize));
        if body_a == body_b
            || (self.flags(body_a as usize) & KIND == FIXED && self.flags(body_b as usize) & KIND == FIXED)
            || self.find_pair(a, b) != NONE
        {
            return;
        }
        let Some(row) = self.take_pair_row() else { return };
        let at = row as usize;
        self.set_u(PAIR_PART, at, NONE);
        self.set_u(PAIR_CHILD, at, NONE);
        let (first_a, first_b) = (self.uu(COLLIDER_PAIRS, a as usize), self.uu(COLLIDER_PAIRS, b as usize));
        self.set_u(PAIR_A, at, a);
        self.set_u(PAIR_B, at, b);
        self.set_u(PAIR_FLAGS, at, 0);
        self.set_u(PAIR_CONTACTS, at, 0);
        self.set_u(PAIR_FEATURE, at, 0);
        self.set_u(PAIR_NEXT_A, at, first_a);
        self.set_u(PAIR_PREVIOUS_A, at, NONE);
        self.set_u(PAIR_NEXT_B, at, first_b);
        self.set_u(PAIR_PREVIOUS_B, at, NONE);
        self.set_previous(first_a, a, row);
        self.set_previous(first_b, b, row);
        self.set_u(COLLIDER_PAIRS, a as usize, row);
        self.set_u(COLLIDER_PAIRS, b as usize, row);
        self.table_insert(row);
        self.header_mut().pairs += 1;
        self.set_u(PAIR_SLOT, at, NONE);
        let (body_a, body_b) = (body_a as usize, body_b as usize);
        if self.uu(AWAKE_SLOT, body_a) != NONE || self.uu(AWAKE_SLOT, body_b) != NONE {
            self.activate_pair(row);
        }
    }

    /// A pair row: the last one freed, else the next new one, growing the rows when they are used up. None when memory
    /// cannot, which the world records.
    pub fn take_pair_row(&mut self) -> Option<u32> {
        let free = self.header().free_pair;
        if free != NONE {
            self.header_mut().free_pair = self.uu(PAIR_NEXT_A, free as usize);
            return Some(free);
        }
        if self.header().pair_rows == self.header().capacity[3] && !self.grow_pairs() {
            self.header_mut().failed = 1;
            return None;
        }
        let row = self.header().pair_rows;
        self.header_mut().pair_rows = row + 1;
        Some(row)
    }

    /// Sets `row`'s link back along `collider`'s list to `previous`.
    #[inline(always)]
    fn set_previous(&mut self, row: u32, collider: u32, previous: u32) {
        if row != NONE {
            let side = if self.uu(PAIR_A, row as usize) == collider { PAIR_PREVIOUS_A } else { PAIR_PREVIOUS_B };
            self.set_u(side, row as usize, previous);
        }
    }

    /// The next pair after `row` on `collider`'s list.
    #[inline(always)]
    pub fn next_pair(&self, row: u32, collider: u32) -> u32 {
        let side = if self.uu(PAIR_A, row as usize) == collider { PAIR_NEXT_A } else { PAIR_NEXT_B };
        self.uu(side, row as usize)
    }

    /// Takes `row` off `collider`'s list.
    fn unlink(&mut self, row: u32, collider: u32, next_column: usize, previous_column: usize) {
        let at = row as usize;
        let (next, previous) = (self.uu(next_column, at), self.uu(previous_column, at));
        self.set_previous(next, collider, previous);
        if previous == NONE {
            self.set_u(COLLIDER_PAIRS, collider as usize, next);
        } else {
            let side = if self.uu(PAIR_A, previous as usize) == collider { PAIR_NEXT_A } else { PAIR_NEXT_B };
            self.set_u(side, previous as usize, next);
        }
    }

    /// Removes a pair. The table closes the gap by moving back any entry the gap would cut off from its hash.
    pub fn remove_pair(&mut self, row: u32) {
        self.pair_leaves(row as usize);
        self.free_parts(row as usize);
        self.deactivate_pair(row);
        let at = row as usize;
        let (a, b) = (self.uu(PAIR_A, at), self.uu(PAIR_B, at));
        self.unlink(row, a, PAIR_NEXT_A, PAIR_PREVIOUS_A);
        self.unlink(row, b, PAIR_NEXT_B, PAIR_PREVIOUS_B);
        let mask = self.header().capacity[4] - 1;
        let mut hole = pair_hash(a, b) & mask;
        while self.uu(PAIR_TABLE, hole as usize) != row + 1 {
            hole = (hole + 1) & mask;
        }
        let mut slot = hole;
        loop {
            slot = (slot + 1) & mask;
            let entry = self.uu(PAIR_TABLE, slot as usize);
            if entry == 0 {
                break;
            }
            let other = (entry - 1) as usize;
            let home = pair_hash(self.uu(PAIR_A, other), self.uu(PAIR_B, other)) & mask;
            // The entry stays when its home lies after the hole, on the way round to its slot.
            let stays = if hole <= slot { hole < home && home <= slot } else { hole < home || home <= slot };
            if !stays {
                self.set_u(PAIR_TABLE, hole as usize, entry);
                hole = slot;
            }
        }
        self.set_u(PAIR_TABLE, hole as usize, 0);
        self.set_u(PAIR_A, at, NONE);
        self.set_u(PAIR_NEXT_A, at, self.header().free_pair);
        let header = self.header_mut();
        header.free_pair = row;
        header.pairs -= 1;
    }

    /// Removes every pair of a collider.
    fn drop_pairs(&mut self, collider: u32) {
        let mut row = self.uu(COLLIDER_PAIRS, collider as usize);
        while row != NONE {
            let next = self.next_pair(row, collider);
            self.remove_pair(row);
            row = next;
        }
    }
}
