mod fft;

use fft::WakeFft2;
use std::cell::RefCell;

// Each instance owns one plan and its own memory. The wake copies across the bridge once in each direction.
struct Plan {
    fft: WakeFft2,
    words: Vec<f64>,
}

thread_local! {
    static PLAN: RefCell<Option<Plan>> = const { RefCell::new(None) };
}

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
