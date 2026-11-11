//! Clean-room Draco. Sources: published Version 2,2 specification and the
//! explicitly recorded public black-box experiments in docs/clean-room.md.
//! Loaded only by the optional decoders/draco-native entry.
mod cursor;
mod edgebreaker;
mod entropy;
mod integer;
mod kd;
mod metadata;
mod normal;
mod prediction;
mod sequential;
mod traversal;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use metadata::{Metadata, MetadataEntry, MetadataNode};
pub use sequential::{Attribute, Geometry, decode, decode_gltf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Header = 1,
    Truncated = 2,
    Overflow = 3,
    Invalid = 4,
    Unsupported = 5,
    Limit = 6,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Bytes of output one decode may produce: 384 MiB, the most whose measured peak memory (up to 4.5 bytes per output
/// byte, tests/draco-output-limit.test.js) stays within 90% of the 2 GiB prebuilt module, a 10M-triangle scan with
/// normals and UVs (280 MB) included. Same value as DRACO_OUTPUT_LIMIT in src/protocol.ts.
pub const OUTPUT_LIMIT: usize = 384 * 1024 * 1024;
/// Bytes one decode may hold at once, output and scratch together: the measured 4.05x of the output, rounded up.
pub const WORKSPACE_LIMIT: usize = 4 * OUTPUT_LIMIT;
/// Loop steps one decode may take: one per output byte, as at the old 256 MiB ceiling.
pub const WORK_LIMIT: usize = OUTPUT_LIMIT;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub vertices: usize,
    pub indices: usize,
    pub bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            vertices: 16_777_216,
            indices: 134_217_728,
            bytes: OUTPUT_LIMIT,
        }
    }
}

pub(crate) struct Budget {
    remaining: usize,
    work: usize,
}
impl Budget {
    fn new(bytes: usize) -> Self {
        Self {
            remaining: bytes.min(WORKSPACE_LIMIT),
            work: WORK_LIMIT,
        }
    }
    fn charge(&mut self, count: usize, width: usize) -> Result<usize> {
        let bytes = count.checked_mul(width).ok_or(Error::Overflow)?;
        self.remaining = self.remaining.checked_sub(bytes).ok_or(Error::Limit)?;
        Ok(bytes)
    }
    fn steps(&mut self, count: usize) -> Result<()> {
        self.work = self.work.checked_sub(count).ok_or(Error::Limit)?;
        Ok(())
    }
    fn vector<T: Clone>(&mut self, count: usize, value: T) -> Result<Vec<T>> {
        self.charge(count, std::mem::size_of::<T>())?;
        let mut out = Vec::new();
        out.try_reserve_exact(count).map_err(|_| Error::Limit)?;
        out.resize(count, value);
        Ok(out)
    }
}
