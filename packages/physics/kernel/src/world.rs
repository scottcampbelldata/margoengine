// One world: a header followed by the columns, all inside one block addressed by offset, so a snapshot is one copy.
use crate::layout::*;
use crate::memory::Arena;

/// Written first in every world; a restore refuses bytes that do not begin with it.
pub const MAGIC: u32 = 0x4D50_4B31;

/// Scalars of the world. Lives at the start of the block, so a snapshot carries it.
#[repr(C)]
pub struct Header {
    pub magic: u32,
    pub bytes: u32,
    pub capacity: [u32; ROW_CLASSES],
    pub offsets: [u32; COLUMNS],
}

const HEADER_BYTES: u32 = ((core::mem::size_of::<Header>() + 15) & !15) as u32;

pub struct World {
    pub arena: Arena,
}

impl World {
    /// A world with room for `bodies`, or None when memory cannot hold it.
    pub fn new(bodies: u32) -> Option<Self> {
        if !(1..=MAX_BODIES).contains(&bodies) {
            return None;
        }
        let mut arena = Arena::new();
        let capacity = [bodies];
        let (offsets, bytes) = offsets(HEADER_BYTES, &capacity);
        if !arena.ensure(bytes as usize) {
            return None;
        }
        let world = Self { arena };
        unsafe {
            core::ptr::write_bytes(world.arena.base, 0, bytes as usize);
            world.header_ptr().write(Header { magic: MAGIC, bytes, capacity, offsets });
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

    /// Grows to at least `bodies` rows. Rows keep their index and every value, and no later step can depend on capacity:
    /// nothing iterates over a whole column. The new layout is built above the old block, then copied down to the base,
    /// so offsets stay relative to the base and JS rebuilds its views once.
    pub fn reserve(&mut self, bodies: u32) -> bool {
        let old_capacity = self.header().capacity;
        if bodies <= old_capacity[0] {
            return true;
        }
        if bodies > MAX_BODIES {
            return false;
        }
        let capacity = [bodies];
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
            let world = World::new(bodies).unwrap();
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
        let mut world = World::new(5).unwrap();
        for row in 0..5 {
            for column in 0..COLUMNS {
                unsafe { *world.u(column).add(row) = (column * 100 + row) as u32 };
            }
        }
        assert!(world.reserve(1000));
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
        assert!(World::new(0).is_none());
        assert!(World::new(MAX_BODIES + 1).is_none());
        let mut world = World::new(4).unwrap();
        assert!(!world.reserve(MAX_BODIES + 1));
        assert!(world.reserve(2), "a smaller request is already met");
        assert_eq!(world.header().capacity[0], 4);
    }

    #[test]
    fn the_hash_sees_one_changed_bit() {
        let world = World::new(4).unwrap();
        let before = world.hash();
        unsafe { *world.u(FLAGS).add(3) ^= 1 };
        assert_ne!(world.hash(), before);
        unsafe { *world.u(FLAGS).add(3) ^= 1 };
        assert_eq!(world.hash(), before);
    }
}
