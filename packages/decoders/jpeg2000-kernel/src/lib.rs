//! Clean-room JPEG 2000 Part 1 decoder (Rec. ITU-T T.800 | ISO/IEC 15444-1), written from the standard and from
//! Taubman and Marcellin, "JPEG2000: Image Compression Fundamentals, Standards and Practice" (Kluwer, 2002), and
//! Taubman, "High performance scalable image compression with EBCOT" (IEEE Trans. Image Processing 9(7), 2000,
//! https://doi.org/10.1109/83.847830). No other decoder's source was read.
pub mod codestream;
pub mod decode;
pub mod dwt;
pub mod geometry;
pub mod jp2;
pub mod mq;
pub mod recon;
pub mod t1;
pub mod tier2;
pub mod tile;
#[cfg(any(target_arch = "wasm32", test))]
mod wasm;

/// Why a stream cannot be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The stream ends inside a marker segment the decoder needs.
    Truncated,
    /// A marker segment, box or value breaks the standard.
    Invalid,
    /// A coding tool outside Part 1 (for example the HT block coder of Part 15).
    Unsupported,
    /// The image is larger than the caller allows, or than this decoder can hold.
    Limit,
}
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The code the Wasm interface reports: 1 truncated, 2 invalid, 3 unsupported, 4 over a limit.
    pub fn code(self) -> u32 {
        match self {
            Error::Truncated => 1,
            Error::Invalid => 2,
            Error::Unsupported => 3,
            Error::Limit => 4,
        }
    }
}
