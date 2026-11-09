//! Coded errors from the raw owned-2D API. No allocation is required on the Wasm path.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhysicsError {
    NotFinite,
    InvalidCore,
    Degenerate,
    ArithmeticOverflow,
    InvalidHandle,
    InvalidParameter,
}

impl PhysicsError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotFinite => "PHYSICS2D_NOT_FINITE",
            Self::InvalidCore => "PHYSICS2D_INVALID_CORE",
            Self::Degenerate => "PHYSICS2D_DEGENERATE",
            Self::ArithmeticOverflow => "PHYSICS2D_ARITHMETIC_OVERFLOW",
            Self::InvalidHandle => "PHYSICS2D_INVALID_HANDLE",
            Self::InvalidParameter => "PHYSICS2D_INVALID_PARAMETER",
        }
    }

    pub const fn help(self) -> &'static str {
        "https://margoengine.com/llms/docs/limits.md#own-2d-input-validation"
    }
}

impl core::fmt::Display for PhysicsError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}; {}", self.code(), self.help())
    }
}

impl core::error::Error for PhysicsError {}

impl From<crate::shape::ShapeError> for PhysicsError {
    fn from(value: crate::shape::ShapeError) -> Self {
        match value {
            crate::shape::ShapeError::NotFinite => Self::NotFinite,
            crate::shape::ShapeError::Degenerate => Self::Degenerate,
            crate::shape::ShapeError::TooManyVertices => Self::InvalidCore,
        }
    }
}
