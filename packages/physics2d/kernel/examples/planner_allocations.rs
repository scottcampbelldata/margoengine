//! Diagnostic native allocation counts for the unchanged 100-row scene, frames 60 through 99.
//! Run alone: cargo run --locked --release --example planner_allocations
//! Use the repository process-tree runner with a hard 180-second limit.
//! ALLOC_FRAME/TOTAL columns: allocations, reallocations, deallocations, requested bytes, freed bytes.
//! A realloc counts its full new size as requested and old size as freed. These are traffic requests,
//! not peak/net resident bytes, copied bytes, compiler instructions or timing measurements.
//! WORK_FRAME columns: constraints, block visits, colours, overflow, awake bodies.
//! All printing and diagnostic storage happen outside the enabled single-thread measurement interval.
//! No allocation count or wall-clock threshold is a correctness assertion.
extern crate alloc;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
#[allow(dead_code)]
#[path = "../tests/support/bits_scenes.rs"]
mod scenes;
struct Counter;
static ENABLED: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static REALLOCS: AtomicU64 = AtomicU64::new(0);
static DEALLOCS: AtomicU64 = AtomicU64::new(0);
static REQUESTED: AtomicU64 = AtomicU64::new(0);
static FREED: AtomicU64 = AtomicU64::new(0);
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if ENABLED.load(Relaxed) { ALLOCS.fetch_add(1, Relaxed); REQUESTED.fetch_add(layout.size() as u64, Relaxed); }
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if ENABLED.load(Relaxed) { ALLOCS.fetch_add(1, Relaxed); REQUESTED.fetch_add(layout.size() as u64, Relaxed); }
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if ENABLED.load(Relaxed) { REALLOCS.fetch_add(1, Relaxed); REQUESTED.fetch_add(size as u64, Relaxed); FREED.fetch_add(layout.size() as u64, Relaxed); }
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if ENABLED.load(Relaxed) { DEALLOCS.fetch_add(1, Relaxed); FREED.fetch_add(layout.size() as u64, Relaxed); }
        unsafe { System.dealloc(ptr, layout) }
    }
}
#[global_allocator]
static GLOBAL: Counter = Counter;
fn main() {
    let mut world = scenes::pyramid(100);
    let mut records = Vec::with_capacity(40);
    let mut work = Vec::with_capacity(40);
    for frame in 0..100 {
        for c in [&ALLOCS, &REALLOCS, &DEALLOCS, &REQUESTED, &FREED] { c.store(0, Relaxed); }
        ENABLED.store(frame >= 60, Relaxed);
        world.step(scenes::DT).unwrap();
        ENABLED.store(false, Relaxed);
        if frame >= 60 {
            records.push([ALLOCS.load(Relaxed), REALLOCS.load(Relaxed), DEALLOCS.load(Relaxed), REQUESTED.load(Relaxed), FREED.load(Relaxed)]);
            let c = &world.counts;
            work.push([c.constraints, c.block, c.colours, c.overflow, c.awake_bodies]);
        }
    }
    let mut total = [0u64; 5];
    for (i, row) in records.iter().enumerate() {
        println!("ALLOC_FRAME {} {} {} {} {} {}", i + 60, row[0], row[1], row[2], row[3], row[4]);
        let c = work[i];
        println!("WORK_FRAME {} {} {} {} {} {}", i + 60, c[0], c[1], c[2], c[3], c[4]);
        for k in 0..5 { total[k] += row[k]; }
    }
    println!("ALLOC_TOTAL {} {} {} {} {}", total[0], total[1], total[2], total[3], total[4]);
    let bodies = world.bodies.iter().map(|b| [b.xf.p.x.to_bits(), b.xf.p.y.to_bits(), b.xf.q.c.to_bits(), b.xf.q.s.to_bits(), b.linear_velocity.x.to_bits(), b.linear_velocity.y.to_bits(), b.angular_velocity.to_bits()]);
    let mut hash = 0xcbf29ce484222325u64;
    for state in bodies { for bits in state { hash = (hash ^ bits as u64).wrapping_mul(0x100000001b3); } }
    println!("STATE {hash:016x} {:?}", world.counts);
}
