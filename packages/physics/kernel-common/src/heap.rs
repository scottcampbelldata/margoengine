// A memory allocator for a no_std Wasm kernel: blocks in power-of-two size classes, freed blocks kept in one list per
// class and handed out again first, new blocks cut from the top of linear memory, which grows by whole 64 KiB pages.
// Size-class free lists as described by Knuth (TAOCP vol. 1, 2.5) and Wilson, Johnstone, Neely and Boles, "Dynamic
// Storage Allocation: A Survey and Critical Review" (1995): no splitting or merging, so every call is a few loads and
// stores and the same calls give the same addresses on every run. A block of class k (2^k bytes) starts on a multiple
// of min(2^k, 64 KiB), so any alignment up to its size holds; the bytes skipped to reach that start are cut into
// smaller blocks for their own lists, never lost. Memory is never handed back to the host, as Wasm cannot shrink it.
// Generic over where pages come from (`Pages`), so the native tests drive the same code over an ordinary buffer.

use core::alloc::Layout;

/// Smallest block: 16 bytes, room for the free-list link and the alignment of every kernel type.
const MIN_CLASS: u32 = 4;
/// Largest class: 2 GiB blocks, past what a 32-bit Wasm memory can hold.
const CLASSES: usize = 32;
/// A Wasm page; no block is aligned past it.
pub const PAGE: usize = 65_536;

/// Where the heap's memory comes from: the first usable address, and a way to make it reach further.
pub trait Pages {
    /// Makes memory usable up to at least `end` (an address); returns the new end of usable memory, or None.
    fn reach(&mut self, end: usize) -> Option<usize>;
}

/// The heap: the next fresh address, the end of usable memory, and the head of each class's free list (0 = empty).
pub struct Heap<P: Pages> {
    top: usize,
    end: usize,
    free: [usize; CLASSES],
    pages: P,
}

/// The size class of a request: the smallest power of two holding both its size and its alignment, from 16 bytes up.
/// None for alignments past a page or sizes past the largest class.
pub fn class_of(layout: Layout) -> Option<u32> {
    if layout.align() > PAGE {
        return None;
    }
    let need = layout.size().max(layout.align()).max(1 << MIN_CLASS);
    let class = need.checked_next_power_of_two()?.trailing_zeros();
    ((class as usize) < CLASSES).then_some(class)
}

/// Bytes of a class.
#[inline]
fn bytes(class: u32) -> usize {
    1usize << class
}

/// The alignment blocks of a class start on.
#[inline]
fn align_of(class: u32) -> usize {
    bytes(class).min(PAGE)
}

impl<P: Pages> Heap<P> {
    /// A heap over memory from `start` (rounded up to 16 bytes) to `end`, growing through `pages`.
    pub const fn new(start: usize, end: usize, pages: P) -> Self {
        let top = (start + 15) & !15;
        Self { top, end, free: [0; CLASSES], pages }
    }

    /// A block for `layout`, or null when memory cannot grow far enough.
    ///
    /// # Safety
    /// The heap's memory from its start to `end` must be the heap's own, readable and writable.
    pub unsafe fn alloc(&mut self, layout: Layout) -> *mut u8 {
        let Some(class) = class_of(layout) else { return core::ptr::null_mut() };
        let head = self.free[class as usize];
        if head != 0 {
            self.free[class as usize] = unsafe { (head as *const usize).read() };
            return head as *mut u8;
        }
        let align = align_of(class);
        let Some(start) = self.top.checked_add(align - 1).map(|a| a & !(align - 1)) else { return core::ptr::null_mut() };
        let Some(stop) = start.checked_add(bytes(class)) else { return core::ptr::null_mut() };
        if stop > self.end {
            match self.pages.reach(stop) {
                Some(end) if end >= stop => self.end = end,
                _ => return core::ptr::null_mut(),
            }
        }
        // The gap below `start` becomes free blocks, largest first, each on its own class's alignment.
        let mut at = self.top;
        while at < start {
            let mut c = (start - at).ilog2().min(CLASSES as u32 - 1);
            while c > MIN_CLASS && at & (align_of(c) - 1) != 0 {
                c -= 1;
            }
            unsafe { self.push(c, at) };
            at += bytes(c);
        }
        self.top = stop;
        start as *mut u8
    }

    /// Returns a block to its class's list.
    ///
    /// # Safety
    /// `ptr` must come from `alloc` (or `realloc`) of this heap with this `layout`, and not be freed already.
    pub unsafe fn dealloc(&mut self, ptr: *mut u8, layout: Layout) {
        if let Some(class) = class_of(layout) {
            unsafe { self.push(class, ptr as usize) };
        }
    }

    /// Resizes a block: the same block when the new size keeps its class, else a new block with the old bytes copied.
    ///
    /// # Safety
    /// As `dealloc` for `ptr` and `layout`; `size` must not overflow when rounded up to `layout.align()`.
    pub unsafe fn realloc(&mut self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let new = unsafe { Layout::from_size_align_unchecked(size, layout.align()) };
        if class_of(new).is_some() && class_of(new) == class_of(layout) {
            return ptr;
        }
        let fresh = unsafe { self.alloc(new) };
        if !fresh.is_null() {
            unsafe {
                core::ptr::copy_nonoverlapping(ptr, fresh, layout.size().min(size));
                self.dealloc(ptr, layout);
            }
        }
        fresh
    }

    /// Bytes from the heap's start that blocks have been cut from so far.
    pub fn top(&self) -> usize {
        self.top
    }

    unsafe fn push(&mut self, class: u32, at: usize) {
        unsafe { (at as *mut usize).write(self.free[class as usize]) };
        self.free[class as usize] = at;
    }
}

/// Wasm linear memory: from the linker's `__heap_base`, grown with `memory.grow`.
#[cfg(target_arch = "wasm32")]
pub struct LinearMemory;

#[cfg(target_arch = "wasm32")]
impl Pages for LinearMemory {
    fn reach(&mut self, end: usize) -> Option<usize> {
        use core::arch::wasm32::{memory_grow, memory_size};
        let have = memory_size::<0>();
        let want = end.div_ceil(PAGE);
        if want > have && memory_grow::<0>(want - have) == usize::MAX {
            return None;
        }
        want.max(have).checked_mul(PAGE)
    }
}

/// The allocator a no_std Wasm kernel names with `#[global_allocator]`: one heap over linear memory. A Wasm instance
/// without the threads proposal runs one thread, so the heap is never entered twice at once.
#[cfg(target_arch = "wasm32")]
pub struct WasmHeap(core::cell::UnsafeCell<Option<Heap<LinearMemory>>>);

#[cfg(target_arch = "wasm32")]
unsafe impl Sync for WasmHeap {}

#[cfg(target_arch = "wasm32")]
impl WasmHeap {
    pub const fn new() -> Self {
        Self(core::cell::UnsafeCell::new(None))
    }

    #[allow(clippy::mut_from_ref)]
    unsafe fn heap(&self) -> &mut Heap<LinearMemory> {
        unsafe extern "C" {
            static __heap_base: u8;
        }
        let slot = unsafe { &mut *self.0.get() };
        slot.get_or_insert_with(|| {
            let start = core::ptr::addr_of!(__heap_base) as usize;
            Heap::new(start, core::arch::wasm32::memory_size::<0>().saturating_mul(PAGE), LinearMemory)
        })
    }
}

#[cfg(target_arch = "wasm32")]
unsafe impl core::alloc::GlobalAlloc for WasmHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { self.heap().alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { self.heap().dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        unsafe { self.heap().realloc(ptr, layout, size) }
    }
}
