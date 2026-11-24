// Wasm only: memory from `__heap_base` up, handed out in order and never freed. Rows grow by doubling and a world holds its
// rows for its life, so what a growth leaves behind is bounded by the last size.
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{memory_grow, memory_size};
use core::cell::UnsafeCell;

unsafe extern "C" {
    static __heap_base: u8;
}

struct Bump {
    next: UnsafeCell<usize>,
}

unsafe impl Sync for Bump {}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let next = unsafe { &mut *self.next.get() };
        if *next == 0 {
            *next = core::ptr::addr_of!(__heap_base) as usize;
        }
        let start = (*next + layout.align() - 1) & !(layout.align() - 1);
        let end = start + layout.size();
        let required = end.div_ceil(65536);
        let current = memory_size::<0>();
        if required > current && memory_grow::<0>(required - current) == usize::MAX {
            return core::ptr::null_mut();
        }
        *next = end;
        start as *mut u8
    }

    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}

#[global_allocator]
static HEAP: Bump = Bump { next: UnsafeCell::new(0) };

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
