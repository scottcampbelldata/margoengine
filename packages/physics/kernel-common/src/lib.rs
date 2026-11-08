// Margo Engine physics kernel parts shared by the 2D and 3D kernels, written from papers (docs/clean-room.md, PK38).
// Generic over the dimension `N`; no dependencies beyond `alloc`; the same determinism rule as the kernels: only
// + - * / sqrt, compares and integer operations reach the state, so native and Wasm builds agree bit for bit.
#![no_std]
extern crate alloc;

pub mod broad;
pub mod island;
pub mod tree;
