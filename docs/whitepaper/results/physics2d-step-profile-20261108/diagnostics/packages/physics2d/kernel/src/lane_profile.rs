// Private, single-thread Wasm diagnostic only. No production feature is added.
use core::cell::UnsafeCell;

pub const PREFLIGHT: usize = 0;
pub const BROAD: usize = 1;
pub const NARROW: usize = 2;
pub const ISLANDS: usize = 3;
pub const SETUP: usize = 4;
pub const PLANNER: usize = 5;
pub const SUBSTEP_PREP: usize = 6;
pub const WARM: usize = 7;
pub const BIASED: usize = 8;
pub const CORRECTION: usize = 9;
pub const INTEGRATION: usize = 10;
pub const RELAX: usize = 11;
pub const OBSERVER: usize = 12;
pub const FINALIZE: usize = 13;
pub const POST_SOLVE_VALIDATION: usize = 14;
pub const SLEEP: usize = 15;
pub const POST_SLEEP_VALIDATION: usize = 16;
pub const PHASES: usize = 17;
pub const COUNTS: usize = 15;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn probe_now() -> f64;
}

struct State {
    elapsed: [f64; PHASES],
    entries: [u64; PHASES],
    counts: [u64; COUNTS],
    last: f64,
    current: usize,
    clock_calls: u64,
    active: bool,
}
struct Cell(UnsafeCell<State>);
// This checker is a single-thread Wasm instance, as its existing Bench storage is.
unsafe impl Sync for Cell {}
static STATE: Cell = Cell(UnsafeCell::new(State {
    elapsed: [0.0; PHASES], entries: [0; PHASES], counts: [0; COUNTS],
    last: 0.0, current: 0, clock_calls: 0, active: false,
}));

pub struct Guard;
pub fn begin() -> Guard {
    let start = unsafe { probe_now() };
    let state = unsafe { &mut *STATE.0.get() };
    *state = State {
        elapsed: [0.0; PHASES], entries: [0; PHASES], counts: [0; COUNTS],
        last: start, current: PREFLIGHT, clock_calls: 1, active: true,
    };
    state.entries[PREFLIGHT] = 1;
    Guard
}

#[inline(never)]
pub fn mark(phase: usize) {
    let state = unsafe { &mut *STATE.0.get() };
    if state.active {
        let now = unsafe { probe_now() };
        state.elapsed[state.current] += now - state.last;
        state.last = now;
        state.current = phase;
        state.entries[phase] += 1;
        state.clock_calls += 1;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let state = unsafe { &mut *STATE.0.get() };
        if state.active {
            let now = unsafe { probe_now() };
            state.elapsed[state.current] += now - state.last;
            state.clock_calls += 1;
            state.active = false;
        }
    }
}

pub fn add_count(i: usize, n: u64) {
    unsafe { (*STATE.0.get()).counts[i] += n; }
}
pub fn phase(i: usize) -> f64 { unsafe { (*STATE.0.get()).elapsed[i] } }
pub fn entries(i: usize) -> u64 { unsafe { (*STATE.0.get()).entries[i] } }
pub fn count(i: usize) -> u64 { unsafe { (*STATE.0.get()).counts[i] } }
pub fn calls() -> u64 { unsafe { (*STATE.0.get()).clock_calls } }

pub fn clock_loop(n: u32) -> f64 {
    let mut sum = 0.0;
    for _ in 0..n { sum += unsafe { probe_now() }; }
    core::hint::black_box(sum)
}
pub fn empty_loop(n: u32) -> f64 {
    let mut sum = 0.0;
    for i in 0..n { sum += core::hint::black_box(i) as f64; }
    core::hint::black_box(sum)
}
