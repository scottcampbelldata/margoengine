// Where a world lives. Wasm: linear memory from `__heap_base` up, grown with `memory.grow`; one world per instance.
// Native (tests): one zeroed block, sized up front, so several worlds can run side by side in `cargo test`.

#[cfg(target_arch = "wasm32")]
unsafe extern "C" {
    static __heap_base: u8;
}

/// The block a world uses. Everything inside it is addressed by offset, so a copy of the bytes is a whole world.
pub struct Arena {
    pub base: *mut u8,
    #[cfg(not(target_arch = "wasm32"))]
    size: usize,
}

/// Native worlds reserve this much address space; the system commits pages only when they are touched.
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_BYTES: usize = 1 << 30;

impl Arena {
    #[cfg(target_arch = "wasm32")]
    pub fn new() -> Self {
        let start = (core::ptr::addr_of!(__heap_base) as usize + 15) & !15;
        Self { base: start as *mut u8 }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn new() -> Self {
        let layout = std::alloc::Layout::from_size_align(NATIVE_BYTES, 16).unwrap();
        let base = unsafe { std::alloc::alloc_zeroed(layout) };
        assert!(!base.is_null());
        Self { base, size: NATIVE_BYTES }
    }

    /// Makes `bytes` from the base usable; false when memory cannot grow that far.
    #[cfg(target_arch = "wasm32")]
    pub fn ensure(&mut self, bytes: usize) -> bool {
        use core::arch::wasm32::*;
        let Some(end) = (self.base as usize).checked_add(bytes) else { return false };
        let required = end.div_ceil(65536);
        let current = memory_size::<0>();
        required <= current || memory_grow::<0>(required - current) != usize::MAX
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn ensure(&mut self, bytes: usize) -> bool {
        bytes <= self.size
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Arena {
    fn drop(&mut self) {
        let layout = std::alloc::Layout::from_size_align(self.size, 16).unwrap();
        unsafe { std::alloc::dealloc(self.base, layout) };
    }
}
