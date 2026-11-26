// Where a world lives. Wasm: a region of the world's memory, which the host's region allocator hands out and grows
// (`region_resize`, the Arena of @margoengine/physics/world): the kernel imports that memory and keeps no allocator. Native
// (tests): one zeroed block, sized up front, so several worlds can run side by side in `cargo test`.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// The host's region of the world, from `base` (0 for none yet) to at least `bytes` long, its bytes kept: its new start,
    /// which moves when the region cannot grow where it is, or 0 when the memory cannot hold it.
    fn region_resize(base: u32, bytes: u32) -> u32;
}

/// The block a world uses. Everything inside it is addressed by offset, so a copy of the bytes is a whole world, and a block
/// that moves takes the world with it.
pub struct Arena {
    pub base: *mut u8,
    size: usize,
    /// False for a view (`Arena::view`), which frees nothing when dropped.
    #[cfg(not(target_arch = "wasm32"))]
    owned: bool,
}

/// Native worlds reserve this much address space; the system commits pages only when they are touched.
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_BYTES: usize = 1 << 30;

impl Arena {
    /// The same block, for a solve on another thread (`World::thread_view`): it grows nothing and frees nothing.
    pub fn view(&self) -> Self {
        Self {
            base: self.base,
            size: self.size,
            #[cfg(not(target_arch = "wasm32"))]
            owned: false,
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn new() -> Self {
        Self { base: core::ptr::null_mut(), size: 0 }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn new() -> Self {
        let layout = std::alloc::Layout::from_size_align(NATIVE_BYTES, 16).unwrap();
        let base = unsafe { std::alloc::alloc_zeroed(layout) };
        assert!(!base.is_null());
        Self { base, size: NATIVE_BYTES, owned: true }
    }

    /// Makes `bytes` from the base usable, moving the block when the host cannot grow it in place (the caller reads `base`
    /// afresh after); false when memory cannot hold it.
    #[cfg(target_arch = "wasm32")]
    pub fn ensure(&mut self, bytes: usize) -> bool {
        if bytes <= self.size {
            return true;
        }
        let Ok(asked) = u32::try_from(bytes) else { return false };
        let at = unsafe { region_resize(self.base as u32, asked) };
        if at == 0 {
            return false;
        }
        self.base = at as *mut u8;
        self.size = bytes;
        true
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn ensure(&mut self, bytes: usize) -> bool {
        bytes <= self.size
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Arena {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        let layout = std::alloc::Layout::from_size_align(self.size, 16).unwrap();
        unsafe { std::alloc::dealloc(self.base, layout) };
    }
}
