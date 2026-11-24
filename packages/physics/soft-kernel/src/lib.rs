// Soft bodies: particles joined by constraints, solved position-based with small steps, and what they touch.
//
// Clean room, from the papers: Macklin, Mueller, Chentanez, "XPBD: Position-Based Simulation of Compliant Constrained
// Dynamics" (MIG 2016) for the compliant constraints and their damping; Macklin, Mueller, Chentanez, "Small Steps in
// Physics Simulation" (SCA 2019) for many substeps of one iteration; Mueller et al., "Position Based Dynamics" (2007) for
// the particle model, and Macklin et al., "Unified Particle Physics for Real-Time Applications" (2014) for friction
// against a collider as a bounded displacement. A softness is a natural frequency and a damping ratio, as in Catto's soft
// constraints, so it does not depend on the masses: a constraint with effective mass m behaves as a spring k = m w^2 with
// damping c = 2 z m w, which in XPBD terms is alpha = w_eff / (w^2) per second squared and gamma = 2 z / (w h).
//
// Only + - * / sqrt, compares and integer operations are used on the step path, so a step gives the same bits in every
// engine. Rows are plain vectors of f32 and u32; JavaScript reads them as typed arrays over the Wasm memory.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod api;
mod col;
pub mod attach;
mod rigid;
pub mod collide;
mod volume;
pub mod fem;
mod fem_api;
#[cfg(target_arch = "wasm32")]
mod heap;
mod math;
mod shape;
mod world;
pub use world::*;
