// One world: a header followed by the columns, all inside one block addressed by offset, so a snapshot is one copy.
use crate::layout::*;
use crate::memory::Arena;

/// Written first in every world; a restore refuses bytes that do not begin with it. It counts the columns, so a snapshot
/// from a build with another layout is refused too.
pub const MAGIC: u32 = 0x4D50_4B00 + COLUMNS as u32;
/// End of a chain of rows.
pub const NONE: u32 = u32::MAX;
/// The kinetic energy per unit of mass of a body sliding at 0.02 m/s: v^2 / 2.
const SLEEP_ENERGY_DEFAULT: f32 = 2e-4;

/// Scalars of the world. Lives at the start of the block, so a snapshot carries it.
#[repr(C)]
pub struct Header {
    pub magic: u32,
    pub bytes: u32,
    pub capacity: [u32; ROW_CLASSES],
    pub offsets: [u32; COLUMNS],
    /// Body rows handed out so far, and the first freed one to hand out again.
    pub rows: u32,
    pub free_body: u32,
    /// The same for colliders.
    pub collider_rows: u32,
    pub free_collider: u32,
    /// Steps taken, and how many substeps split each.
    pub steps: u32,
    pub substeps: u32,
    pub gravity: [f32; 3],
    /// Counts every change of layout, so JS knows to bind its views again.
    pub layout: u32,
    /// Endpoints in each sorted list.
    pub endpoints: u32,
    /// The head of the chain of colliders the next step must look at.
    pub pending: u32,
    /// Pairs alive; rows handed out so far; the first freed one to hand out again.
    pub pairs: u32,
    pub pair_rows: u32,
    pub free_pair: u32,
    /// Set when memory could not hold a new pair.
    pub failed: u32,
    /// Bodies on the awake list, pairs on the active list, islands awake after the last step.
    pub awake: u32,
    pub active_pairs: u32,
    pub islands: u32,
    /// A body sleeps under this kinetic energy per unit of mass, in J/kg, held for this many seconds.
    pub sleep_energy: f32,
    pub sleep_time: f32,
}

const HEADER_BYTES: u32 = ((core::mem::size_of::<Header>() + 15) & !15) as u32;

pub struct World {
    pub arena: Arena,
}

impl World {
    /// A world with room for `bodies` and `colliders`, or None when memory cannot hold it.
    pub fn new(bodies: u32, colliders: u32) -> Option<Self> {
        if !(1..=MAX_BODIES).contains(&bodies) || !(1..=MAX_COLLIDERS).contains(&colliders) {
            return None;
        }
        let mut arena = Arena::new();
        let capacity = capacities(bodies, colliders, colliders.max(16));
        let (offsets, bytes) = offsets(HEADER_BYTES, &capacity)?;
        if !arena.ensure(bytes as usize) {
            return None;
        }
        let world = Self { arena };
        unsafe {
            core::ptr::write_bytes(world.arena.base, 0, bytes as usize);
            world.header_ptr().write(Header {
                magic: MAGIC,
                bytes,
                capacity,
                offsets,
                rows: 0,
                free_body: NONE,
                collider_rows: 0,
                free_collider: NONE,
                steps: 0,
                substeps: 4,
                gravity: [0.0, -9.81, 0.0],
                layout: 0,
                endpoints: 0,
                pending: NONE,
                pairs: 0,
                pair_rows: 0,
                free_pair: NONE,
                failed: 0,
                awake: 0,
                active_pairs: 0,
                islands: 0,
                sleep_energy: SLEEP_ENERGY_DEFAULT,
                sleep_time: 0.5,
            });
        }
        Some(world)
    }

    #[inline(always)]
    fn header_ptr(&self) -> *mut Header {
        self.arena.base.cast()
    }
    #[inline(always)]
    pub fn header(&self) -> &Header {
        unsafe { &*self.header_ptr() }
    }
    #[inline(always)]
    pub fn header_mut(&mut self) -> &mut Header {
        unsafe { &mut *self.header_ptr() }
    }
    /// In test builds, every row access proves it is inside its column.
    #[inline(always)]
    pub fn in_rows(&self, column: usize, at: usize) {
        debug_assert!(at < self.header().capacity[COLUMN_ROWS[column] as usize] as usize, "row {at} of column {column}");
    }
    /// Start of a column of floats.
    #[inline(always)]
    pub fn f(&self, column: usize) -> *mut f32 {
        unsafe { self.arena.base.add(self.header().offsets[column] as usize).cast() }
    }
    /// Start of a column of unsigned integers.
    #[inline(always)]
    pub fn u(&self, column: usize) -> *mut u32 {
        unsafe { self.arena.base.add(self.header().offsets[column] as usize).cast() }
    }

    /// Grows to at least these rows. Rows keep their index and every value, and no later step can depend on capacity:
    /// nothing iterates over a whole column.
    pub fn reserve(&mut self, bodies: u32, colliders: u32) -> bool {
        let old = self.header().capacity;
        if bodies > MAX_BODIES || colliders > MAX_COLLIDERS {
            return false;
        }
        self.grow(capacities(bodies.max(old[0]), colliders.max(old[1]), old[3]))
    }

    /// Moves every column up to its place in the larger layout, last column first, so nothing is overwritten before it
    /// moves and no second copy of the world is needed. Offsets stay relative to the base; JS binds its views again.
    pub fn grow(&mut self, capacity: [u32; ROW_CLASSES]) -> bool {
        let old_capacity = self.header().capacity;
        if capacity == old_capacity {
            return true;
        }
        let Some((new_offsets, bytes)) = offsets(HEADER_BYTES, &capacity) else { return false };
        if !self.arena.ensure(bytes as usize) {
            return false;
        }
        let base = self.arena.base;
        let old_offsets = self.header().offsets;
        for column in (0..COLUMNS).rev() {
            let class = COLUMN_ROWS[column] as usize;
            let (rows, new_rows) = (old_capacity[class] as usize, padded(capacity[class]) as usize);
            unsafe {
                let to = base.add(new_offsets[column] as usize);
                core::ptr::copy(base.add(old_offsets[column] as usize), to, rows * 4);
                core::ptr::write_bytes(to.add(rows * 4), 0, (new_rows - rows) * 4);
            }
        }
        let header = self.header_mut();
        header.bytes = bytes;
        header.capacity = capacity;
        header.offsets = new_offsets;
        header.layout = header.layout.wrapping_add(1);
        true
    }

    /// Zeroes one row of every column of a class but `keep`, which counts reuse.
    fn clear_row(&mut self, class: Rows, at: usize, keep: usize) {
        for column in 0..COLUMNS {
            if COLUMN_ROWS[column] as usize == class as usize && column != keep {
                unsafe { *self.u(column).add(at) = 0 };
            }
        }
    }

    /// Hands out a row: the last one freed, else the next new one. None when the rows are used up, so the caller reserves
    /// more and asks again. Freed rows come back last in, first out, a pure function of the calls made, so replays match.
    pub fn add_body(&mut self, kind: u32) -> Option<u32> {
        let header = self.header();
        let (free, rows, capacity) = (header.free_body, header.rows, header.capacity[0]);
        let row = if free != NONE {
            self.header_mut().free_body = unsafe { *self.u(NEXT_FREE).add(free as usize) };
            free
        } else if rows < capacity {
            self.header_mut().rows = rows + 1;
            rows
        } else {
            return None;
        };
        let at = row as usize;
        self.clear_row(Rows::Body, at, GENERATION);
        unsafe {
            for column in [ROTATION_W, PREVIOUS_ROTATION_W, INERTIA_FRAME_W, TARGET_ROTATION_W, GRAVITY_SCALE] {
                *self.f(column).add(at) = 1.0;
            }
            *self.u(FLAGS).add(at) = ALIVE | CAN_SLEEP | (kind & KIND);
            *self.u(FIRST_COLLIDER).add(at) = NONE;
            *self.u(AWAKE_SLOT).add(at) = NONE;
            *self.u(ISLAND_NEXT).add(at) = NONE;
        }
        if kind & KIND != FIXED {
            self.list_awake(row);
        }
        Some(row)
    }

    /// True when `body` is a live row.
    #[inline(always)]
    pub fn body_alive(&self, body: u32) -> bool {
        body < self.header().rows && unsafe { *self.u(FLAGS).add(body as usize) } & ALIVE != 0
    }

    /// Frees a body and its colliders; false when the row is not alive.
    pub fn remove_body(&mut self, body: u32) -> bool {
        if !self.body_alive(body) {
            return false;
        }
        // Its neighbours may have rested on it.
        self.wake(body);
        let at = body as usize;
        if unsafe { *self.u(AWAKE_SLOT).add(at) } != NONE {
            self.unlist_awake(body);
        }
        let mut collider = unsafe { *self.u(FIRST_COLLIDER).add(at) };
        while collider != NONE {
            let next = unsafe { *self.u(COLLIDER_NEXT).add(collider as usize) };
            self.retire_collider(collider);
            collider = next;
        }
        unsafe {
            *self.u(FLAGS).add(at) = 0;
            *self.u(FIRST_COLLIDER).add(at) = NONE;
            *self.u(GENERATION).add(at) += 1;
            *self.u(NEXT_FREE).add(at) = self.header().free_body;
        }
        self.header_mut().free_body = body;
        true
    }

    /// A collider leaves its body now; the next step drops it from the broad phase and frees its row, so removing many
    /// costs one pass over the lists.
    fn retire_collider(&mut self, collider: u32) {
        let at = collider as usize;
        unsafe {
            *self.u(COLLIDER_BODY).add(at) = NONE;
            *self.u(COLLIDER_GENERATION).add(at) += 1;
            *self.u(COLLIDER_STATE).add(at) |= REMOVED;
        }
        self.mark_pending(collider);
    }

    /// Puts a collider on the chain the next step looks at, once.
    pub fn mark_pending(&mut self, collider: u32) {
        let at = collider as usize;
        unsafe {
            let state = self.u(COLLIDER_STATE).add(at);
            if *state & PENDING == 0 {
                *state |= PENDING;
                *self.u(COLLIDER_PENDING).add(at) = self.header().pending;
                self.header_mut().pending = collider;
            }
        }
    }

    /// Says a body's pose was written by hand: a sleeping body wakes and a fixed body's box is looked at again.
    pub fn touch_body(&mut self, body: u32) {
        if !self.body_alive(body) {
            return;
        }
        self.wake(body);
        self.mark_moved(body);
    }

    /// Puts a body's colliders on the chain the next step looks at.
    pub fn mark_moved(&mut self, body: u32) {
        let mut collider = unsafe { *self.u(FIRST_COLLIDER).add(body as usize) };
        while collider != NONE {
            self.mark_pending(collider);
            collider = unsafe { *self.u(COLLIDER_NEXT).add(collider as usize) };
        }
    }

    /// Adds a collider to a live body and recomputes its mass. None when the rows are used up or the body is not alive.
    /// A density of zero adds no mass.
    pub fn add_collider(&mut self, body: u32, shape: u32, size: [f32; 3], position: [f32; 3], rotation: [f32; 4], density: f32) -> Option<u32> {
        if !self.body_alive(body) {
            return None;
        }
        self.wake(body);
        let header = self.header();
        let (free, rows, capacity) = (header.free_collider, header.collider_rows, header.capacity[1]);
        let row = if free != NONE {
            self.header_mut().free_collider = unsafe { *self.u(COLLIDER_NEXT).add(free as usize) };
            free
        } else if rows < capacity {
            self.header_mut().collider_rows = rows + 1;
            rows
        } else {
            return None;
        };
        let at = row as usize;
        self.clear_row(Rows::Collider, at, COLLIDER_GENERATION);
        unsafe {
            *self.u(COLLIDER_BODY).add(at) = body;
            *self.u(COLLIDER_SHAPE).add(at) = shape;
            for k in 0..3 {
                *self.f(COLLIDER_A + k).add(at) = size[k];
                *self.f(COLLIDER_X + k).add(at) = position[k];
            }
            for k in 0..4 {
                *self.f(COLLIDER_ROTATION_X + k).add(at) = rotation[k];
            }
            *self.f(COLLIDER_DENSITY).add(at) = density;
            *self.u(COLLIDER_PAIRS).add(at) = NONE;
            // At the end of the body's chain, so colliders add up in the order they were given.
            *self.u(COLLIDER_NEXT).add(at) = NONE;
            let first = self.u(FIRST_COLLIDER).add(body as usize);
            if *first == NONE {
                *first = row;
            } else {
                let mut last = *first;
                while *self.u(COLLIDER_NEXT).add(last as usize) != NONE {
                    last = *self.u(COLLIDER_NEXT).add(last as usize);
                }
                *self.u(COLLIDER_NEXT).add(last as usize) = row;
            }
        }
        self.mark_pending(row);
        self.update_mass(body);
        Some(row)
    }

    /// Removes a collider from its body and recomputes the body's mass; false when the row holds no collider. Its row
    /// comes back after the next step.
    pub fn remove_collider(&mut self, collider: u32) -> bool {
        if collider >= self.header().collider_rows {
            return false;
        }
        let at = collider as usize;
        let body = unsafe { *self.u(COLLIDER_BODY).add(at) };
        if body == NONE || !self.body_alive(body) {
            return false;
        }
        self.wake(body);
        unsafe {
            let next = *self.u(COLLIDER_NEXT).add(at);
            let first = self.u(FIRST_COLLIDER).add(body as usize);
            if *first == collider {
                *first = next;
            } else {
                let mut row = *first;
                while *self.u(COLLIDER_NEXT).add(row as usize) != collider {
                    row = *self.u(COLLIDER_NEXT).add(row as usize);
                }
                *self.u(COLLIDER_NEXT).add(row as usize) = next;
            }
        }
        self.retire_collider(collider);
        self.update_mass(body);
        true
    }

    /// FNV-1a over the world's 32-bit words, the replay proof's fingerprint: everything a step can change is inside.
    pub fn hash(&self) -> u32 {
        let words = (self.header().bytes / 4) as usize;
        let data: *const u32 = self.arena.base.cast();
        let mut hash = 0x811C_9DC5u32;
        for word in 0..words {
            hash = (hash ^ unsafe { *data.add(word) }).wrapping_mul(0x0100_0193);
        }
        hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_start_on_16_bytes_and_stay_in_the_block() {
        for bodies in [1, 2, 3, 4, 5, 1000, 1023] {
            let world = World::new(bodies, bodies).unwrap();
            let header = world.header();
            for column in 0..COLUMNS {
                assert_eq!(header.offsets[column] % 16, 0, "column {column} with {bodies} bodies");
                assert!(header.offsets[column] >= HEADER_BYTES);
                assert!(header.offsets[column] + bodies * 4 <= header.bytes);
            }
        }
    }

    #[test]
    fn reserve_keeps_every_row_at_its_index() {
        let mut world = World::new(5, 5).unwrap();
        for row in 0..5 {
            for column in 0..COLUMNS {
                unsafe { *world.u(column).add(row) = (column * 100 + row) as u32 };
            }
        }
        assert!(world.reserve(1000, 1000));
        assert_eq!(world.header().capacity[0], 1000);
        for row in 0..5 {
            for column in 0..COLUMNS {
                assert_eq!(unsafe { *world.u(column).add(row) }, (column * 100 + row) as u32);
            }
        }
        for column in 0..COLUMNS {
            assert_eq!(unsafe { *world.u(column).add(5) }, 0, "new rows start at zero");
        }
    }

    #[test]
    fn a_capacity_outside_the_limits_is_refused() {
        assert!(World::new(0, 1).is_none());
        assert!(World::new(1, 0).is_none());
        assert!(World::new(MAX_BODIES + 1, 1).is_none());
        let mut world = World::new(4, 4).unwrap();
        assert!(!world.reserve(MAX_BODIES + 1, 4));
        assert!(world.reserve(2, 2), "a smaller request is already met");
        assert_eq!(world.header().capacity[0], 4);
    }

    #[test]
    fn the_hash_sees_one_changed_bit() {
        let world = World::new(4, 4).unwrap();
        let before = world.hash();
        unsafe { *world.u(FLAGS).add(3) ^= 1 };
        assert_ne!(world.hash(), before);
        unsafe { *world.u(FLAGS).add(3) ^= 1 };
        assert_eq!(world.hash(), before);
    }
}
