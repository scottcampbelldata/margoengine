//! Margo-authored AV1 still-image decoding, from the AOM bitstream specification.
//! No codec implementation source, glue or binary is used by this crate.
pub mod bits;
pub mod cdf_tables;
pub mod cdfs;
pub mod coefficients;
pub mod color;
pub mod container;
pub mod decode;
pub mod entropy;
pub mod filters;
pub mod frame;
pub mod grain;
pub mod image;
pub mod intrabc;
pub mod obu;
pub mod palette;
pub mod prediction;
pub mod reconstruct;
pub mod restoration;
pub mod restore_filter;
pub mod sequence;
pub mod tables;
pub mod transform;
#[cfg(target_arch = "wasm32")]
mod wasm;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Truncated,
    Invalid,
    Limit,
    Unsupported,
}
pub type Result<T> = std::result::Result<T, Error>;
