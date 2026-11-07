// The structure-of-arrays layout, shared with TypeScript: scripts/build-kernel.mjs reads the `columns!` table below and
// writes the same names into src/wasm.ts, so the two sides cannot disagree. Every column is 4 bytes a row and starts on
// a 16-byte boundary. Row classes grow independently. JS reads columns as typed-array views over the world's memory.

/// Which capacity a column's rows follow.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Rows {
    Body,
}
pub const ROW_CLASSES: usize = 1;

macro_rules! columns {
    ($($name:ident $kind:ident $rows:ident,)*) => {
        #[allow(non_camel_case_types, clippy::upper_case_acronyms)]
        #[derive(Clone, Copy)]
        #[repr(usize)]
        enum Index { $($name,)* Count }
        $(pub const $name: usize = Index::$name as usize;)*
        pub const COLUMNS: usize = Index::Count as usize;
        pub const COLUMN_ROWS: [Rows; COLUMNS] = [$(Rows::$rows,)*];
    };
}

columns! {
    // Pose of the body's origin, what JS reads. Quaternions are x, y, z, w.
    POSITION_X f32 Body,
    POSITION_Y f32 Body,
    POSITION_Z f32 Body,
    ROTATION_X f32 Body,
    ROTATION_Y f32 Body,
    ROTATION_Z f32 Body,
    ROTATION_W f32 Body,
    // The pose before the last step, for interpolation.
    PREVIOUS_X f32 Body,
    PREVIOUS_Y f32 Body,
    PREVIOUS_Z f32 Body,
    PREVIOUS_ROTATION_X f32 Body,
    PREVIOUS_ROTATION_Y f32 Body,
    PREVIOUS_ROTATION_Z f32 Body,
    PREVIOUS_ROTATION_W f32 Body,
    // Velocity of the centre of mass and angular velocity, world space.
    LINEAR_X f32 Body,
    LINEAR_Y f32 Body,
    LINEAR_Z f32 Body,
    ANGULAR_X f32 Body,
    ANGULAR_Y f32 Body,
    ANGULAR_Z f32 Body,
    // Centre of mass: world position, kept during a step, and its place in the body's frame.
    CENTER_X f32 Body,
    CENTER_Y f32 Body,
    CENTER_Z f32 Body,
    LOCAL_CENTER_X f32 Body,
    LOCAL_CENTER_Y f32 Body,
    LOCAL_CENTER_Z f32 Body,
    // Forces stay until the caller clears them and reach every substep; impulses land once, before the first.
    FORCE_X f32 Body,
    FORCE_Y f32 Body,
    FORCE_Z f32 Body,
    TORQUE_X f32 Body,
    TORQUE_Y f32 Body,
    TORQUE_Z f32 Body,
    IMPULSE_X f32 Body,
    IMPULSE_Y f32 Body,
    IMPULSE_Z f32 Body,
    ANGULAR_IMPULSE_X f32 Body,
    ANGULAR_IMPULSE_Y f32 Body,
    ANGULAR_IMPULSE_Z f32 Body,
    // Mass: inverse mass, principal moments, their inverses, and the principal frame in the body's frame.
    INVERSE_MASS f32 Body,
    INERTIA_X f32 Body,
    INERTIA_Y f32 Body,
    INERTIA_Z f32 Body,
    INVERSE_INERTIA_X f32 Body,
    INVERSE_INERTIA_Y f32 Body,
    INVERSE_INERTIA_Z f32 Body,
    INERTIA_FRAME_X f32 Body,
    INERTIA_FRAME_Y f32 Body,
    INERTIA_FRAME_Z f32 Body,
    INERTIA_FRAME_W f32 Body,
    GRAVITY_SCALE f32 Body,
    LINEAR_DAMPING f32 Body,
    ANGULAR_DAMPING f32 Body,
    // The pose a kinematicPosition body reaches at the end of the next step.
    TARGET_X f32 Body,
    TARGET_Y f32 Body,
    TARGET_Z f32 Body,
    TARGET_ROTATION_X f32 Body,
    TARGET_ROTATION_Y f32 Body,
    TARGET_ROTATION_Z f32 Body,
    TARGET_ROTATION_W f32 Body,
    // Slot state: bit flags, the slot's generation.
    FLAGS u32 Body,
    GENERATION u32 Body,
}

/// Rows every column of a class is padded to, so each column stays on a 16-byte boundary.
#[inline]
pub fn padded(rows: u32) -> u32 {
    (rows + 3) & !3
}

/// Byte offset of each column from the world's base, and the bytes of the whole world.
pub fn offsets(start: u32, capacity: &[u32; ROW_CLASSES]) -> ([u32; COLUMNS], u32) {
    let mut at = start;
    let mut out = [0; COLUMNS];
    let mut column = 0;
    while column < COLUMNS {
        out[column] = at;
        at += padded(capacity[COLUMN_ROWS[column] as usize]) * 4;
        column += 1;
    }
    (out, at)
}

/// Most bodies one world holds: every column stays inside 32-bit offsets, with room to copy on growth.
pub const MAX_BODIES: u32 = 1 << 22;

// Bits of the FLAGS column.
pub const ALIVE: u32 = 1;
/// Two bits of body kind; `FIXED` is zero, so a fresh row never moves.
pub const KIND: u32 = 3 << 1;
pub const FIXED: u32 = 0;
pub const DYNAMIC: u32 = 1 << 1;
pub const KINEMATIC_POSITION: u32 = 2 << 1;
pub const KINEMATIC_VELOCITY: u32 = 3 << 1;
/// World axes a body may not move along or turn about: X, Y, Z in three consecutive bits each.
pub const LOCK_LINEAR_X: u32 = 1 << 3;
pub const LOCK_LINEAR: u32 = 7 << 3;
pub const LOCK_ANGULAR_X: u32 = 1 << 6;
pub const LOCK_ANGULAR: u32 = 7 << 6;
