#![cfg_attr(feature = "shared-modes", no_std)]

#[cfg(not(feature = "shared-modes"))]
mod fft;
mod modes;

#[cfg(not(feature = "shared-modes"))]
use fft::WakeFft2;
#[cfg(not(feature = "shared-modes"))]
use std::cell::RefCell;

#[cfg(feature = "shared-modes")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// Each instance owns one plan and its own memory. The wake copies across the bridge once in each direction.
#[cfg(not(feature = "shared-modes"))]
struct Plan {
    fft: WakeFft2,
    words: Vec<f64>,
}

#[cfg(not(feature = "shared-modes"))]
thread_local! {
    static PLAN: RefCell<Option<Plan>> = const { RefCell::new(None) };
    static MODES: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
}

#[cfg(not(feature = "shared-modes"))]
#[unsafe(no_mangle)]
pub extern "C" fn wake_fft_init(nx: usize, nz: usize) -> i32 {
    if !(4..=4096).contains(&nx) || !(4..=4096).contains(&nz) {
        return -1;
    }
    let Some(fft) = WakeFft2::new(nx, nz) else {
        return -1;
    };
    PLAN.with(|plan| {
        *plan.borrow_mut() = Some(Plan {
            fft,
            words: vec![0.0; (nx + 2) * nz],
        });
    });
    0
}

#[cfg(not(feature = "shared-modes"))]
#[unsafe(no_mangle)]
pub extern "C" fn wake_fft_buffer() -> *mut f64 {
    PLAN.with(|plan| {
        let mut plan = plan.borrow_mut();
        let Some(plan) = plan.as_mut() else {
            return std::ptr::null_mut();
        };
        plan.words.as_mut_ptr()
    })
}

#[cfg(not(feature = "shared-modes"))]
#[unsafe(no_mangle)]
pub extern "C" fn wake_fft_transform(inverse: bool) -> i32 {
    PLAN.with(|plan| {
        let mut plan = plan.borrow_mut();
        let Some(plan) = plan.as_mut() else { return -1 };
        if inverse {
            plan.fft.inverse(&mut plan.words);
        } else {
            plan.fft.forward(&mut plan.words);
        }
        0
    })
}

#[cfg(not(feature = "shared-modes"))]
#[unsafe(no_mangle)]
pub extern "C" fn wake_mode_buffer(words: usize) -> *mut f64 {
    MODES.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        let additional = words.saturating_sub(buffer.len());
        if buffer.try_reserve_exact(additional).is_err() {
            return std::ptr::null_mut();
        }
        buffer.resize(words, 0.0);
        buffer.as_mut_ptr()
    })
}
