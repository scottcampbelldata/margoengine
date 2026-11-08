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
    /// One row a body too, but dense lists: an index here is a place in a list, not a body, so freeing a row leaves them.
    BodyList,
    /// Four rows a pair: the points of its manifold, pair row times four plus the point.
    Contact,
    /// Convex polyhedra, and the rows of their vertices, half-edges and faces, held for the world's life.
    Hull,
    HullVertex,
    HullEdge,
    HullFace,
    Joint,
    /// One row a joint too, but a dense list, for the same reason as `BodyList`.
    JointList,
    /// JOINT_WORDS rows a joint: what a substep keeps of it.
    JointScratch,
    /// Triangle meshes, and the rows of their vertices, triangles and tree nodes, held for the world's life.
    Mesh,
    MeshVertex,
    MeshTriangle,
    MeshNode,
}
pub const ROW_CLASSES: usize = 18;

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
    // The higher of two touching bodies is a wall to the lower.
    DOMINANCE f32 Body,
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
    // A solid of the body's own on top of its colliders: mass at a point of its frame, and principal moments along a frame
    // of its own, both in the body's frame. setAdditionalMass and setMassProperties write it.
    OWN_MASS f32 Body,
    OWN_CENTER_X f32 Body,
    OWN_CENTER_Y f32 Body,
    OWN_CENTER_Z f32 Body,
    OWN_INERTIA_X f32 Body,
    OWN_INERTIA_Y f32 Body,
    OWN_INERTIA_Z f32 Body,
    OWN_FRAME_X f32 Body,
    OWN_FRAME_Y f32 Body,
    OWN_FRAME_Z f32 Body,
    OWN_FRAME_W f32 Body,
    // Solver passes the body's island takes on top of the world's.
    EXTRA_PASSES u32 Body,
    // The first of the body's joints: the chain runs through JOINT_NEXT_A or JOINT_NEXT_B, whichever side the body is on.
    FIRST_JOINT u32 Body,
    // Sleep: seconds under the threshold, and the energy the window began with.
    SLEEP_TIME f32 Body,
    SLEEP_ENERGY f32 Body,
    // A body's place in the awake list, NONE when it is not there.
    AWAKE_SLOT u32 Body,
    // Islands of this step: the forest, and a body's island.
    ISLAND_PARENT u32 Body,
    ISLAND_SIZE u32 Body,
    ISLAND_ID u32 Body,
    // The next body of a sleeping island's ring.
    ISLAND_NEXT u32 Body,
    // What the contact solver moves a body by, written once a step: inverse mass along each world axis and the world inverse
    // inertia, both zero for anything but an awake dynamic body, with locked axes taken out.
    SOLVE_MASS_X f32 Body,
    SOLVE_MASS_Y f32 Body,
    SOLVE_MASS_Z f32 Body,
    SOLVE_INERTIA_XX f32 Body,
    SOLVE_INERTIA_XY f32 Body,
    SOLVE_INERTIA_XZ f32 Body,
    SOLVE_INERTIA_YY f32 Body,
    SOLVE_INERTIA_YZ f32 Body,
    SOLVE_INERTIA_ZZ f32 Body,
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
    // The hull row of a SHAPE_HULL collider.
    COLLIDER_HULL u32 Collider,
    // Surface: friction, bounce, and how each mixes with another collider's, two bits for friction then two for bounce.
    COLLIDER_FRICTION f32 Collider,
    COLLIDER_RESTITUTION f32 Collider,
    COLLIDER_COMBINE u32 Collider,
    // Bits of what kind of collider it is, then its packed interaction groups and solver groups: memberships in the high 16
    // bits, filter in the low 16, all set by default.
    COLLIDER_FLAGS u32 Collider,
    COLLIDER_GROUPS u32 Collider,
    COLLIDER_SOLVER_GROUPS u32 Collider,
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
    // The sorted lists, one per axis. An id is the collider's row shifted left, plus 1 for a box's max end.
    ENDPOINT_VALUE_X f32 Endpoint,
    ENDPOINT_VALUE_Y f32 Endpoint,
    ENDPOINT_VALUE_Z f32 Endpoint,
    ENDPOINT_ID_X u32 Endpoint,
    ENDPOINT_ID_Y u32 Endpoint,
    ENDPOINT_ID_Z u32 Endpoint,
    // Working space of one step: colliders that joined, colliders that moved. One can be listed as moved twice only when
    // its box holds a NaN, so these take endpoint rows.
    LIST_NEW u32 Endpoint,
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
    // The pairs with an awake body, densely, and each pair's place in that list, NONE when it is not there.
    ACTIVE_PAIRS u32 Pair,
    PAIR_SLOT u32 Pair,
    // The pair's manifold: points in use, and the shared normal, from the first collider to the second, in world space.
    PAIR_CONTACTS u32 Pair,
    PAIR_NORMAL_X f32 Pair,
    PAIR_NORMAL_Y f32 Pair,
    PAIR_NORMAL_Z f32 Pair,
    // The feature that made the manifold, for the coherence of the next step.
    PAIR_FEATURE u32 Pair,
    // The normal impulse the pair gave in this step, over all its substeps.
    PAIR_FORCE f32 Pair,
    // What the last step has to say: two words an event, see `push_event`.
    EVENTS u32 Contact,
    // The solver's view of a pair for this step: the surfaces mixed, the first tangent, and the pairs it will solve, densely.
    PAIR_FRICTION f32 Pair,
    PAIR_RESTITUTION f32 Pair,
    PAIR_TANGENT_X f32 Pair,
    PAIR_TANGENT_Y f32 Pair,
    PAIR_TANGENT_Z f32 Pair,
    SOLVE_PAIRS u32 Pair,
    // Open addressing: a pair's row plus one, zero when empty.
    PAIR_TABLE u32 Table,
    // Awake bodies, densely.
    AWAKE u32 BodyList,
    // Islands of this step: bodies in runs, one run an island; each run's start, length, and whether all its bodies are ready.
    ISLAND_BODIES u32 BodyList,
    ISLAND_LEAD u32 BodyList,
    ISLAND_START u32 BodyList,
    ISLAND_COUNT u32 BodyList,
    ISLAND_READY u32 BodyList,
    // The most extra passes any body of the island asks for.
    ISLAND_PASSES u32 BodyList,
    // A manifold's points. An anchor is the point on each surface, from its body's centre of mass in its body's frame.
    // Separation is along the normal, negative when the shapes overlap. The id names the features that made the point.
    CONTACT_ANCHOR_A_X f32 Contact,
    CONTACT_ANCHOR_A_Y f32 Contact,
    CONTACT_ANCHOR_A_Z f32 Contact,
    CONTACT_ANCHOR_B_X f32 Contact,
    CONTACT_ANCHOR_B_Y f32 Contact,
    CONTACT_ANCHOR_B_Z f32 Contact,
    CONTACT_SEPARATION f32 Contact,
    CONTACT_ID u32 Contact,
    // The point in world space, midway between the surfaces, when it was found.
    CONTACT_X f32 Contact,
    CONTACT_Y f32 Contact,
    CONTACT_Z f32 Contact,
    // What a point carries from step to step: its normal impulse, its tangent impulse as a world vector, and how far its
    // friction anchor has drifted, a world vector too.
    CONTACT_NORMAL_IMPULSE f32 Contact,
    CONTACT_TANGENT_X f32 Contact,
    CONTACT_TANGENT_Y f32 Contact,
    CONTACT_TANGENT_Z f32 Contact,
    CONTACT_DRIFT_X f32 Contact,
    CONTACT_DRIFT_Y f32 Contact,
    CONTACT_DRIFT_Z f32 Contact,
    // The solver's view of a point for this step: arms from each centre of mass in world space, and effective masses along
    // the normal and the two tangents. An approach speed, and the list of points struck in this substep, densely.
    CONTACT_ARM_A_X f32 Contact,
    CONTACT_ARM_A_Y f32 Contact,
    CONTACT_ARM_A_Z f32 Contact,
    CONTACT_ARM_B_X f32 Contact,
    CONTACT_ARM_B_Y f32 Contact,
    CONTACT_ARM_B_Z f32 Contact,
    CONTACT_NORMAL_MASS f32 Contact,
    CONTACT_TANGENT_MASS f32 Contact,
    CONTACT_OTHER_MASS f32 Contact,
    CONTACT_APPROACH f32 Contact,
    IMPACTS u32 Contact,
    // A hull: where its rows start and how many it has; an interior point; the box around it; volume, and the principal
    // moments per unit of density with their frame, about its centroid.
    HULL_FIRST_VERTEX u32 Hull,
    HULL_VERTICES u32 Hull,
    HULL_FIRST_EDGE u32 Hull,
    HULL_EDGES u32 Hull,
    HULL_FIRST_FACE u32 Hull,
    HULL_FACES u32 Hull,
    HULL_CENTER_X f32 Hull,
    HULL_CENTER_Y f32 Hull,
    HULL_CENTER_Z f32 Hull,
    HULL_BOX_X f32 Hull,
    HULL_BOX_Y f32 Hull,
    HULL_BOX_Z f32 Hull,
    HULL_HALF_X f32 Hull,
    HULL_HALF_Y f32 Hull,
    HULL_HALF_Z f32 Hull,
    HULL_RADIUS f32 Hull,
    HULL_VOLUME f32 Hull,
    HULL_MOMENT_X f32 Hull,
    HULL_MOMENT_Y f32 Hull,
    HULL_MOMENT_Z f32 Hull,
    HULL_FRAME_X f32 Hull,
    HULL_FRAME_Y f32 Hull,
    HULL_FRAME_Z f32 Hull,
    HULL_FRAME_W f32 Hull,
    VERTEX_X f32 HullVertex,
    VERTEX_Y f32 HullVertex,
    VERTEX_Z f32 HullVertex,
    // The head of the chain of half-edges leaving a vertex, used while a hull is built.
    VERTEX_CHAIN u32 HullVertex,
    // Half-edges, all indices from the hull's first row. A face's edges run counter-clockwise seen from outside.
    EDGE_ORIGIN u32 HullEdge,
    EDGE_NEXT u32 HullEdge,
    EDGE_TWIN u32 HullEdge,
    EDGE_FACE u32 HullEdge,
    EDGE_CHAIN u32 HullEdge,
    FACE_EDGE u32 HullFace,
    FACE_NORMAL_X f32 HullFace,
    FACE_NORMAL_Y f32 HullFace,
    FACE_NORMAL_Z f32 HullFace,
    FACE_OFFSET f32 HullFace,
    // Joints: two bodies, the JOINT_ bits below, and the chain of each body's joints. A free row has its next in JOINT_NEXT_A.
    JOINT_A u32 Joint,
    JOINT_B u32 Joint,
    JOINT_FLAGS u32 Joint,
    JOINT_NEXT_A u32 Joint,
    JOINT_NEXT_B u32 Joint,
    // Where the joint holds each body, from the body's origin in its frame, and the joint's frame on each body.
    JOINT_ANCHOR_A_X f32 Joint,
    JOINT_ANCHOR_A_Y f32 Joint,
    JOINT_ANCHOR_A_Z f32 Joint,
    JOINT_ANCHOR_B_X f32 Joint,
    JOINT_ANCHOR_B_Y f32 Joint,
    JOINT_ANCHOR_B_Z f32 Joint,
    JOINT_FRAME_A_X f32 Joint,
    JOINT_FRAME_A_Y f32 Joint,
    JOINT_FRAME_A_Z f32 Joint,
    JOINT_FRAME_A_W f32 Joint,
    JOINT_FRAME_B_X f32 Joint,
    JOINT_FRAME_B_Y f32 Joint,
    JOINT_FRAME_B_Z f32 Joint,
    JOINT_FRAME_B_W f32 Joint,
    // Six axes in a row: along X, Y, Z of frame A, then about them. Limits; a motor's target, target speed, gains and cap;
    // the impulse a lock or limit carries, and the impulse its motor carries. A column plus an axis names that axis.
    JOINT_MIN_0 f32 Joint,
    JOINT_MIN_1 f32 Joint,
    JOINT_MIN_2 f32 Joint,
    JOINT_MIN_3 f32 Joint,
    JOINT_MIN_4 f32 Joint,
    JOINT_MIN_5 f32 Joint,
    JOINT_MAX_0 f32 Joint,
    JOINT_MAX_1 f32 Joint,
    JOINT_MAX_2 f32 Joint,
    JOINT_MAX_3 f32 Joint,
    JOINT_MAX_4 f32 Joint,
    JOINT_MAX_5 f32 Joint,
    JOINT_TARGET_0 f32 Joint,
    JOINT_TARGET_1 f32 Joint,
    JOINT_TARGET_2 f32 Joint,
    JOINT_TARGET_3 f32 Joint,
    JOINT_TARGET_4 f32 Joint,
    JOINT_TARGET_5 f32 Joint,
    JOINT_SPEED_0 f32 Joint,
    JOINT_SPEED_1 f32 Joint,
    JOINT_SPEED_2 f32 Joint,
    JOINT_SPEED_3 f32 Joint,
    JOINT_SPEED_4 f32 Joint,
    JOINT_SPEED_5 f32 Joint,
    JOINT_STIFFNESS_0 f32 Joint,
    JOINT_STIFFNESS_1 f32 Joint,
    JOINT_STIFFNESS_2 f32 Joint,
    JOINT_STIFFNESS_3 f32 Joint,
    JOINT_STIFFNESS_4 f32 Joint,
    JOINT_STIFFNESS_5 f32 Joint,
    JOINT_DAMPING_0 f32 Joint,
    JOINT_DAMPING_1 f32 Joint,
    JOINT_DAMPING_2 f32 Joint,
    JOINT_DAMPING_3 f32 Joint,
    JOINT_DAMPING_4 f32 Joint,
    JOINT_DAMPING_5 f32 Joint,
    JOINT_CAP_0 f32 Joint,
    JOINT_CAP_1 f32 Joint,
    JOINT_CAP_2 f32 Joint,
    JOINT_CAP_3 f32 Joint,
    JOINT_CAP_4 f32 Joint,
    JOINT_CAP_5 f32 Joint,
    JOINT_IMPULSE_0 f32 Joint,
    JOINT_IMPULSE_1 f32 Joint,
    JOINT_IMPULSE_2 f32 Joint,
    JOINT_IMPULSE_3 f32 Joint,
    JOINT_IMPULSE_4 f32 Joint,
    JOINT_IMPULSE_5 f32 Joint,
    JOINT_MOTOR_0 f32 Joint,
    JOINT_MOTOR_1 f32 Joint,
    JOINT_MOTOR_2 f32 Joint,
    JOINT_MOTOR_3 f32 Joint,
    JOINT_MOTOR_4 f32 Joint,
    JOINT_MOTOR_5 f32 Joint,
    // The angle of a joint with one free turning axis, counted past a whole turn.
    JOINT_ANGLE f32 Joint,
    // The step a joint was last listed in, plus one.
    JOINT_SEEN u32 Joint,
    // The joints this step solves, densely, in paths: a row with a body in SOLVE_VIA goes on from the row before through it.
    SOLVE_JOINTS u32 JointList,
    // The joint whose scratch keeps the sums of this one's island, for the warm start; NONE with no body to move.
    SOLVE_LEAD u32 JointList,
    SOLVE_VIA u32 JointList,
    // The share of its error each listed joint closes in a biased pass.
    SOLVE_SHARE f32 JointList,
    // Rows, measures and factors of the solving joints.
    JOINT_SCRATCH f32 JointScratch,
    // A pair of a triangle mesh holds no points itself: each triangle that touches has a part, a pair row of its own off
    // the broad phase's lists, chained from the pair. A part names its triangle; the chain ends in NONE.
    PAIR_PART u32 Pair,
    PAIR_CHILD u32 Pair,
    // A triangle mesh: where its rows start and how many it has, MESH_ bits, the box around it and the radius about the
    // box's centre that holds it.
    MESH_FIRST_VERTEX u32 Mesh,
    MESH_VERTICES u32 Mesh,
    MESH_FIRST_TRIANGLE u32 Mesh,
    MESH_TRIANGLES u32 Mesh,
    MESH_FIRST_NODE u32 Mesh,
    MESH_NODES u32 Mesh,
    MESH_FLAGS u32 Mesh,
    MESH_BOX_X f32 Mesh,
    MESH_BOX_Y f32 Mesh,
    MESH_BOX_Z f32 Mesh,
    MESH_HALF_X f32 Mesh,
    MESH_HALF_Y f32 Mesh,
    MESH_HALF_Z f32 Mesh,
    MESH_RADIUS f32 Mesh,
    MESH_VERTEX_X f32 MeshVertex,
    MESH_VERTEX_Y f32 MeshVertex,
    MESH_VERTEX_Z f32 MeshVertex,
    // A triangle's corners, counter-clockwise seen from its front, as indices from the mesh's first vertex; the triangle
    // across each edge (A to B, B to C, C to A) from the mesh's first triangle, NONE for an open edge; two bits an edge of
    // EDGE_ classes; and the tree's order of triangles.
    TRIANGLE_A u32 MeshTriangle,
    TRIANGLE_B u32 MeshTriangle,
    TRIANGLE_C u32 MeshTriangle,
    TRIANGLE_ACROSS_0 u32 MeshTriangle,
    TRIANGLE_ACROSS_1 u32 MeshTriangle,
    TRIANGLE_ACROSS_2 u32 MeshTriangle,
    TRIANGLE_EDGES u32 MeshTriangle,
    TRIANGLE_ORDER u32 MeshTriangle,
    // The tree's nodes: a box, then the first child and 0, or a leaf's first place in TRIANGLE_ORDER and its count.
    NODE_MIN_X f32 MeshNode,
    NODE_MIN_Y f32 MeshNode,
    NODE_MIN_Z f32 MeshNode,
    NODE_MAX_X f32 MeshNode,
    NODE_MAX_Y f32 MeshNode,
    NODE_MAX_Z f32 MeshNode,
    NODE_FIRST u32 MeshNode,
    NODE_COUNT u32 MeshNode,
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

/// Points a manifold holds.
pub const MANIFOLD: usize = 4;

/// The rows of every class for `bodies`, `colliders` and `pairs`, keeping the hull and mesh rows a world already has room
/// for.
pub fn capacities(bodies: u32, colliders: u32, pairs: u32, hulls: [u32; 4], joints: u32, meshes: [u32; 4]) -> [u32; ROW_CLASSES] {
    let [hull, vertices, edges, faces] = hulls;
    let [mesh, mesh_vertices, triangles, nodes] = meshes;
    [
        bodies,
        colliders,
        colliders * 2,
        pairs,
        (pairs * 2).next_power_of_two(),
        bodies,
        pairs * MANIFOLD as u32,
        hull,
        vertices,
        edges,
        faces,
        joints,
        joints,
        joints * JOINT_WORDS,
        mesh,
        mesh_vertices,
        triangles,
        nodes,
    ]
}

/// The hull rows of a capacity.
#[inline]
pub fn hull_capacity(c: &[u32; ROW_CLASSES]) -> [u32; 4] {
    [c[7], c[8], c[9], c[10]]
}

/// The mesh rows of a capacity.
#[inline]
pub fn mesh_capacity(c: &[u32; ROW_CLASSES]) -> [u32; 4] {
    [c[14], c[15], c[16], c[17]]
}

/// Most bodies and colliders one world holds.
pub const MAX_BODIES: u32 = 1 << 22;
pub const MAX_COLLIDERS: u32 = 1 << 22;
/// Words of JOINT_SCRATCH a joint takes: 64 for its rows and measures, then doubles, 36 of inverse, 36 of link, 6 of right side,
/// 6 of what the pushing pass gave.
pub const JOINT_WORDS: u32 = 64 + 2 * (36 + 36 + 6 + 36 + 6 + 4);
/// Most joints one world holds.
pub const MAX_JOINTS: u32 = 1 << 22;
/// Pairs the broad phase can hold; its table then fills 2^30 slots and its points 2^31 rows.
pub const MAX_PAIRS: u32 = 1 << 29;
/// Edges of a hull's largest face: the clipper's buffers are sized by it, and left unwritten until used. 256 holds the cap of
/// a 256-sided cylinder in one face; contact ids give a face's edges 8 bits.
pub const MAX_FACE_EDGES: u32 = 256;

// Values of the COLLIDER_SHAPE column. A, B, C hold the size: a ball's radius; a box's half extents; a capsule's radius
// and half the length of its core along local Y. A hull has its row in COLLIDER_HULL and no size.
pub const SHAPE_BALL: u32 = 0;
pub const SHAPE_BOX: u32 = 1;
pub const SHAPE_CAPSULE: u32 = 2;
pub const SHAPE_HULL: u32 = 3;
/// A triangle mesh: its row in COLLIDER_HULL, no size, no volume. It touches every other shape but a mesh.
pub const SHAPE_TRIMESH: u32 = 4;

/// MESH_FLAGS: contacts on a triangle's inner edges keep to the normals the surface allows (fixInternalEdges).
pub const MESH_FIX_EDGES: u32 = 1;
/// TRIANGLE_EDGES, two bits an edge: open (no triangle across), convex, concave, or flat.
pub const EDGE_OPEN: u32 = 0;
pub const EDGE_CONVEX: u32 = 1;
pub const EDGE_CONCAVE: u32 = 2;
pub const EDGE_FLAT: u32 = 3;

// How two colliders mix a surface property: a pair takes the larger number of its two.
pub const COMBINE_AVERAGE: u32 = 0;
pub const COMBINE_MIN: u32 = 1;
pub const COMBINE_MULTIPLY: u32 = 2;
pub const COMBINE_MAX: u32 = 3;

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
/// Asleep: on no list a step walks. Fixed bodies never are.
pub const SLEEPING: u32 = 1 << 9;
/// May go to sleep; a body without it keeps its island awake.
pub const CAN_SLEEP: u32 = 1 << 10;
/// Out of the world: on no list, touching nothing, its joints at rest.
pub const DISABLED: u32 = 1 << 11;
/// A kinematic body still for the sleep window: it reads asleep, as Rapier's does, though it stays on the awake list, since a
/// script may give it speed at any time. It moves and wakes nothing while still, so this changes no result.
pub const RESTING: u32 = 1 << 12;

// Bits of the COLLIDER_FLAGS column.
/// Sees overlaps and pushes nothing.
pub const COLLIDER_SENSOR: u32 = 1;
/// Touches nothing and is seen by nothing.
pub const COLLIDER_OFF: u32 = 2;

// Bits of the PAIR_FLAGS column.
/// It touched at the end of the last step that looked at it.
pub const PAIR_TOUCHING: u32 = 1;
/// A pair that is not solved overlaps: a sensor, or solver groups that do not meet.
pub const PAIR_OVERLAP: u32 = 2;
/// In this step's solve the first body, or the second, is a wall to the other.
pub const PAIR_A_RULES: u32 = 4;
pub const PAIR_B_RULES: u32 = 8;
/// A part of a mesh pair: off the broad phase's lists, solved like any pair, silent in events.
pub const PAIR_IS_PART: u32 = 16;

// Top bits of an event's first word, over the collider's row.
pub const EVENT_STARTED: u32 = 1 << 31;
pub const EVENT_SENSOR: u32 = 1 << 30;
pub const EVENT_COLLIDER: u32 = (1 << 30) - 1;

// Bits of the COLLIDER_STATE column.
/// Its ends are in the sorted lists.
pub const IN_BROAD: u32 = 1;
/// Waiting in the pending chain for the next step.
pub const PENDING: u32 = 2;
/// Gone from its body; the next step drops its ends and pairs and frees the row.
pub const REMOVED: u32 = 4;
/// Joining the lists in this step.
pub const JOINING: u32 = 8;

// Bits of the JOINT_FLAGS column. Each of the first four is six bits, one an axis in the order of the JOINT_ axis columns.
/// The axis does not move.
pub const JOINT_LOCK: u32 = 1;
/// The axis stays between JOINT_MIN and JOINT_MAX.
pub const JOINT_LIMIT: u32 = 1 << 6;
/// A motor drives the axis.
pub const JOINT_MOTOR_ON: u32 = 1 << 12;
/// That motor's gains are in force units; otherwise they are per unit of effective mass, so its load does not change them.
pub const JOINT_MOTOR_FORCE: u32 = 1 << 18;
pub const JOINT_ALIVE: u32 = 1 << 24;
/// The two bodies may collide with each other.
pub const JOINT_CONTACTS: u32 = 1 << 25;
/// A cone: the first turning axis is the twist about frame X, the second how far past its swing limit frame B's X stands.
pub const JOINT_CONE: u32 = 1 << 26;
/// The first axis is the line between the anchors, and what it measures is their distance: a rope's limit, a spring's motor.
pub const JOINT_DISTANCE: u32 = 1 << 27;
/// A body of the joint is out of the world, so nothing solves the joint.
pub const JOINT_OFF: u32 = 1 << 28;
