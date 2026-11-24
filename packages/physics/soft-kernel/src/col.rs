// A column of rows: a block of zeroed memory that only grows. It stands in for `Vec`, whose growth carries panic messages
// that name the standard library's sources; the blueprint holds no path but this crate's own.
use alloc::alloc::{Layout, alloc_zeroed};
use core::ops::{Deref, DerefMut};

pub struct Col<T: Copy> {
    ptr: *mut T,
    len: usize,
}

impl<T: Copy> Col<T> {
    pub const fn new() -> Self {
        Col { ptr: core::ptr::NonNull::dangling().as_ptr(), len: 0 }
    }

    /// Makes room for `n` rows, keeping what is there; new rows are zero. The old block is left behind.
    pub fn resize(&mut self, n: usize) {
        if n <= self.len {
            return;
        }
        // Grow by doubling, so rows that are added one at a time do not each leave a block behind.
        let n = if n > 2 * self.len { n } else { 2 * self.len };
        let layout = Layout::array::<T>(n).unwrap_or_else(|_| arch_trap());
        let block = unsafe { alloc_zeroed(layout) } as *mut T;
        if block.is_null() {
            arch_trap();
        }
        unsafe { core::ptr::copy_nonoverlapping(self.ptr, block, self.len) };
        self.ptr = block;
        self.len = n;
    }

    pub fn as_mut_ptr(&mut self) -> *mut T {
        self.ptr
    }
}

impl<T: Copy> Default for Col<T> {
    fn default() -> Self {
        Col::new()
    }
}

impl<T: Copy> Deref for Col<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        unsafe { core::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl<T: Copy> DerefMut for Col<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        unsafe { core::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

/// Stops the step: an allocation that cannot be made leaves no world to go on with.
fn arch_trap() -> ! {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::unreachable()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        panic!("out of memory")
    }
}
