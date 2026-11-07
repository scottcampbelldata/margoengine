// One world: a header followed by the columns, all inside one block addressed by offset, so a snapshot is one copy.
use crate::layout::*;
use crate::memory::Arena;

/// Written first in every world; a restore refuses bytes that do not begin with it.
pub const MAGIC: u32 = 0x4D50_4B31;
/// End of a chain of rows.
pub const NONE: u32 = u32::MAX;

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
        let capacity = [bodies, colliders];
        let (offsets, bytes) = offsets(HEADER_BYTES, &capacity);
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
    /// nothing iterates over a whole column. The new layout is built above the old block, then copied down to the base,
    /// so offsets stay relative to the base and JS rebuilds its views once.
    pub fn reserve(&mut self, bodies: u32, colliders: u32) -> bool {
        let old_capacity = self.header().capacity;
        let capacity = [bodies.max(old_capacity[0]), colliders.max(old_capacity[1])];
        if capacity == old_capacity {
            return true;
        }
        if capacity[0] > MAX_BODIES || capacity[1] > MAX_COLLIDERS {
            return false;
        }
        let (new_offsets, bytes) = offsets(HEADER_BYTES, &capacity);
        let old_bytes = self.header().bytes;
        if !self.arena.ensure(old_bytes as usize + bytes as usize) {
            return false;
        }
        let base = self.arena.base;
        unsafe {
            let staging = base.add(old_bytes as usize);
            core::ptr::write_bytes(staging, 0, bytes as usize);
            let old_offsets = self.header().offsets;
            for column in 0..COLUMNS {
                let rows = old_capacity[COLUMN_ROWS[column] as usize] as usize;
                core::ptr::copy_nonoverlapping(
                    base.add(old_offsets[column] as usize),
                    staging.add(new_offsets[column] as usize),
                    rows * 4,
                );
            }
            let header = HEADER_BYTES as usize;
            core::ptr::copy(staging.add(header), base.add(header), bytes as usize - header);
        }
        let header = self.header_mut();
        header.bytes = bytes;
        header.capacity = capacity;
        header.offsets = new_offsets;
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
            *self.u(FLAGS).add(at) = ALIVE | (kind & KIND);
            *self.u(FIRST_COLLIDER).add(at) = NONE;
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
        let at = body as usize;
        let mut collider = unsafe { *self.u(FIRST_COLLIDER).add(at) };
        while collider != NONE {
            let next = unsafe { *self.u(COLLIDER_NEXT).add(collider as usize) };
            self.free_collider_row(collider);
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

    fn free_collider_row(&mut self, collider: u32) {
        let at = collider as usize;
        unsafe {
            *self.u(COLLIDER_BODY).add(at) = NONE;
            *self.u(COLLIDER_GENERATION).add(at) += 1;
            *self.u(COLLIDER_NEXT).add(at) = self.header().free_collider;
        }
        self.header_mut().free_collider = collider;
    }

    /// Adds a collider to a live body and recomputes its mass. None when the rows are used up or the body is not alive.
    /// A density of zero adds no mass.
    pub fn add_collider(&mut self, body: u32, shape: u32, size: [f32; 3], position: [f32; 3], rotation: [f32; 4], density: f32) -> Option<u32> {
        if !self.body_alive(body) {
            return None;
        }
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
        self.update_mass(body);
        Some(row)
    }

    /// Removes a collider from its body and recomputes the body's mass; false when the row holds no collider.
    pub fn remove_collider(&mut self, collider: u32) -> bool {
        if collider >= self.header().collider_rows {
            return false;
        }
        let at = collider as usize;
        let body = unsafe { *self.u(COLLIDER_BODY).add(at) };
        if body == NONE || !self.body_alive(body) {
            return false;
        }
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
        self.free_collider_row(collider);
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
