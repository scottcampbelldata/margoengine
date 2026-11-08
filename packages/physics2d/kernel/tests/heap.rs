// The Wasm kernels' memory allocator (packages/physics/kernel-common/src/heap.rs), driven natively over an ordinary
// buffer in place of linear memory. The 2D kernel's Wasm build had no allocator (a no_std cdylib cannot link without one)
// and nothing built it for Wasm; `npm run check:rust-kernels` now does, and these tests hold the heap itself: every block
// aligned and apart from every other live block, contents kept, freed blocks reused, nothing lost to alignment, and a
// null pointer, not a wrong one, when memory cannot grow.
use core::alloc::Layout;
use margoengine_physics_kernel_common::heap::{Heap, PAGE, Pages, class_of};

/// `limit` bytes of 64 KiB aligned memory handed out a page at a time.
struct Buffer {
    base: *mut u8,
    limit: usize,
    grown: usize,
}

impl Buffer {
    fn new(limit: usize) -> Self {
        let base = unsafe { std::alloc::alloc_zeroed(Layout::from_size_align(limit, PAGE).unwrap()) };
        assert!(!base.is_null());
        Self { base, limit, grown: 0 }
    }
}

impl Pages for &mut Buffer {
    fn reach(&mut self, end: usize) -> Option<usize> {
        let base = self.base as usize;
        let want = (end - base).div_ceil(PAGE) * PAGE;
        if want > self.limit {
            return None;
        }
        self.grown += 1;
        Some(base + want)
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe { std::alloc::dealloc(self.base, Layout::from_size_align(self.limit, PAGE).unwrap()) };
    }
}

fn heap(buffer: &mut Buffer, start: usize) -> Heap<&mut Buffer> {
    let base = buffer.base as usize;
    Heap::new(base + start, base, buffer)
}

#[test]
fn size_classes_hold_size_and_alignment() {
    let class = |size, align| class_of(Layout::from_size_align(size, align).unwrap());
    assert_eq!(class(0, 1), Some(4), "16 bytes at least");
    assert_eq!(class(16, 4), Some(4));
    assert_eq!(class(17, 4), Some(5));
    assert_eq!(class(8, 64), Some(6), "alignment past the size rounds the class up");
    assert_eq!(class(100_000, 8), Some(17));
    assert_eq!(class(8, 2 * PAGE), None, "no block is aligned past a page");
}

#[test]
fn random_blocks_stay_aligned_apart_and_keep_their_bytes() {
    let mut buffer = Buffer::new(64 << 20);
    let mut heap = heap(&mut buffer, 40);
    let mut live: Vec<(*mut u8, Layout, u8)> = Vec::new();
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for round in 0..4_000u32 {
        let r = next();
        if live.len() > 8 && r % 3 == 0 {
            let (ptr, layout, fill) = live.swap_remove((r >> 8) as usize % live.len());
            let bytes = unsafe { core::slice::from_raw_parts(ptr, layout.size()) };
            assert!(bytes.iter().all(|&b| b == fill), "round {round}: a block's bytes changed while it was live");
            unsafe { heap.dealloc(ptr, layout) };
            continue;
        }
        let size = [1, 7, 16, 24, 100, 1000, 5000, 70_000][(r >> 16) as usize % 8] + (r >> 24) as usize % 64;
        let align = 1usize << ((r >> 32) % 8);
        let layout = Layout::from_size_align(size, align).unwrap();
        let ptr = unsafe { heap.alloc(layout) };
        assert!(!ptr.is_null() && ptr as usize % align == 0, "round {round}: {size} bytes at alignment {align}");
        let (lo, hi) = (ptr as usize, ptr as usize + size);
        for &(other, l, _) in &live {
            assert!(hi <= other as usize || other as usize + l.size() <= lo, "round {round}: two live blocks overlap");
        }
        let fill = round as u8;
        unsafe { core::ptr::write_bytes(ptr, fill, size) };
        live.push((ptr, layout, fill));
    }
}

#[test]
fn a_freed_block_is_handed_out_again_and_a_resize_within_its_class_keeps_it() {
    let mut buffer = Buffer::new(1 << 20);
    let mut heap = heap(&mut buffer, 0);
    let small = Layout::from_size_align(40, 8).unwrap();
    let a = unsafe { heap.alloc(small) };
    unsafe { heap.dealloc(a, small) };
    assert_eq!(unsafe { heap.alloc(small) }, a, "the class's free list comes first");
    assert_eq!(unsafe { heap.realloc(a, small, 64) }, a, "40 and 64 bytes share the 64-byte class");
    unsafe { core::ptr::write_bytes(a, 7, 64) };
    let b = unsafe { heap.realloc(a, Layout::from_size_align(64, 8).unwrap(), 65) };
    assert_ne!(b, a);
    assert!(unsafe { core::slice::from_raw_parts(b, 64) }.iter().all(|&x| x == 7), "the bytes move with the block");
    assert_eq!(unsafe { heap.alloc(Layout::from_size_align(64, 8).unwrap()) }, a, "the old block went back to its list");
}

#[test]
fn bytes_skipped_to_align_a_big_block_become_small_blocks() {
    let mut buffer = Buffer::new(1 << 20);
    let base = buffer.base as usize;
    let mut heap = heap(&mut buffer, 16);
    let big = unsafe { heap.alloc(Layout::from_size_align(4096, 8).unwrap()) } as usize;
    assert_eq!(big, base + 4096, "a 4 KiB block starts on 4 KiB");
    // 16 to 4096 was skipped: 16 + 32 + 64 + ... + 2048 bytes, one block of each class, every one handed out in turn.
    let mut below = 0;
    for class in 4..12 {
        let p = unsafe { heap.alloc(Layout::from_size_align(1 << class, 8).unwrap()) } as usize;
        assert!(p < big && p % (1 << class) == 0, "class {class} comes from the skipped bytes");
        below += 1 << class;
    }
    assert_eq!(below, 4096 - 16);
    assert_eq!(heap.top(), base + 8192, "no fresh memory was cut for them");
}

#[test]
fn memory_that_cannot_grow_gives_null() {
    let mut buffer = Buffer::new(2 * PAGE);
    {
        let mut heap = heap(&mut buffer, 0);
        assert!(!unsafe { heap.alloc(Layout::from_size_align(PAGE, 8).unwrap()) }.is_null());
        assert!(!unsafe { heap.alloc(Layout::from_size_align(PAGE, 8).unwrap()) }.is_null());
        assert!(unsafe { heap.alloc(Layout::from_size_align(16, 8).unwrap()) }.is_null(), "both pages are in use");
    }
    assert_eq!(buffer.grown, 2, "memory grew page by page as blocks needed it");
}
