// The structure-of-arrays layout, shared with TypeScript: scripts/build-kernel.mjs reads the `columns!` table below and
// writes the same names into src/wasm.ts, so the two sides cannot disagree. Every column is 4 bytes a row and starts on
// a 16-byte boundary. Row classes grow independently. JS reads columns as typed-array views over the world's memory.

/// Which capacity a column's rows follow.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Rows {
    Body,
    Collider,
    /// Two rows a collider, for the sorted lists.
    Endpoint,
    Pair,
    /// The pair table's slots, a power of two.
    Table,
}
pub const ROW_CLASSES: usize = 5;

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
    // The next free row; mass given on top of the colliders'; the first of the body's colliders.
    NEXT_FREE u32 Body,
    ADDITIONAL_MASS f32 Body,
    FIRST_COLLIDER u32 Body,
    // Colliders: a shape in its body's frame.
    COLLIDER_BODY u32 Collider,
    COLLIDER_NEXT u32 Collider,
    COLLIDER_GENERATION u32 Collider,
    COLLIDER_SHAPE u32 Collider,
    COLLIDER_A f32 Collider,
    COLLIDER_B f32 Collider,
    COLLIDER_C f32 Collider,
    COLLIDER_X f32 Collider,
    COLLIDER_Y f32 Collider,
    COLLIDER_Z f32 Collider,
    COLLIDER_ROTATION_X f32 Collider,
    COLLIDER_ROTATION_Y f32 Collider,
    COLLIDER_ROTATION_Z f32 Collider,
    COLLIDER_ROTATION_W f32 Collider,
    COLLIDER_DENSITY f32 Collider,
    // Broad phase. State bits, the next in the pending chain, the first of its pairs.
    COLLIDER_STATE u32 Collider,
    COLLIDER_PENDING u32 Collider,
    COLLIDER_PAIRS u32 Collider,
    // The fat box. MAX columns follow MIN columns, so one index picks an end.
    FAT_MIN_X f32 Collider,
    FAT_MIN_Y f32 Collider,
    FAT_MIN_Z f32 Collider,
    FAT_MAX_X f32 Collider,
    FAT_MAX_Y f32 Collider,
    FAT_MAX_Z f32 Collider,
    // Where each end sits in its axis's sorted list.
    RANK_MIN_X u32 Collider,
    RANK_MIN_Y u32 Collider,
    RANK_MIN_Z u32 Collider,
    RANK_MAX_X u32 Collider,
    RANK_MAX_Y u32 Collider,
    RANK_MAX_Z u32 Collider,
    // Colliders that joined in this step.
    LIST_NEW u32 Collider,
    // The sorted lists, one per axis. An id is the collider's row shifted left, plus 1 for a box's max end.
    ENDPOINT_VALUE_X f32 Endpoint,
    ENDPOINT_VALUE_Y f32 Endpoint,
    ENDPOINT_VALUE_Z f32 Endpoint,
    ENDPOINT_ID_X u32 Endpoint,
    ENDPOINT_ID_Y u32 Endpoint,
    ENDPOINT_ID_Z u32 Endpoint,
    // Working space of one step. A collider that moved can be listed twice only when its box holds a NaN.
    LIST_MOVED u32 Endpoint,
    SCRATCH_A u32 Endpoint,
    SCRATCH_B u32 Endpoint,
    // Pairs: fat boxes that overlap, by collider row, A below B, in a row that stays put for the pair's life. Each pair is
    // on a list of A's pairs and a list of B's. A free row has NONE in PAIR_A and its next in PAIR_NEXT_A.
    PAIR_A u32 Pair,
    PAIR_B u32 Pair,
    PAIR_FLAGS u32 Pair,
    PAIR_NEXT_A u32 Pair,
    PAIR_PREVIOUS_A u32 Pair,
    PAIR_NEXT_B u32 Pair,
    PAIR_PREVIOUS_B u32 Pair,
    // Open addressing: a pair's row plus one, zero when empty.
    PAIR_TABLE u32 Table,
}

/// Rows every column of a class is padded to, so each column stays on a 16-byte boundary.
#[inline]
pub fn padded(rows: u32) -> u32 {
    (rows + 3) & !3
}

/// Byte offset of each column from the world's base and the bytes of the whole world; None past 32-bit offsets.
pub fn offsets(start: u32, capacity: &[u32; ROW_CLASSES]) -> Option<([u32; COLUMNS], u32)> {
    let mut at = start as u64;
    let mut out = [0; COLUMNS];
    let mut column = 0;
    while column < COLUMNS {
        out[column] = at as u32;
        at += padded(capacity[COLUMN_ROWS[column] as usize]) as u64 * 4;
        if at > u32::MAX as u64 {
            return None;
        }
        column += 1;
    }
    Some((out, at as u32))
}

/// The rows of every class for `bodies` and `colliders`, keeping the pairs a world already has room for.
pub fn capacities(bodies: u32, colliders: u32, pairs: u32) -> [u32; ROW_CLASSES] {
    [bodies, colliders, colliders * 2, pairs, (pairs * 2).next_power_of_two()]
}

/// Most bodies and colliders one world holds.
pub const MAX_BODIES: u32 = 1 << 22;
pub const MAX_COLLIDERS: u32 = 1 << 22;
/// Pairs the broad phase can hold; its table then fills 2^30 slots.
pub const MAX_PAIRS: u32 = 1 << 29;

// Values of the COLLIDER_SHAPE column. A, B, C hold the size: a ball's radius; a box's half extents; a capsule's radius
// and half the length of its core along local Y.
pub const SHAPE_BALL: u32 = 0;
pub const SHAPE_BOX: u32 = 1;
pub const SHAPE_CAPSULE: u32 = 2;

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

// Bits of the COLLIDER_STATE column.
/// Its ends are in the sorted lists.
pub const IN_BROAD: u32 = 1;
/// Waiting in the pending chain for the next step.
pub const PENDING: u32 = 2;
/// Gone from its body; the next step drops its ends and pairs and frees the row.
pub const REMOVED: u32 = 4;
/// Joining the lists in this step.
pub const JOINING: u32 = 8;
