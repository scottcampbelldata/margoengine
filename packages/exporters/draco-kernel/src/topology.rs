//! Clean-room inverse of the Draco 2.2 connectivity and depth-first traversal specification.
//! CLERS traversal follows Rossignac, Safonova and Szymczak, "3D Compression Made
//! Simple: Edgebreaker on a Corner-Table" (2001). No implementation source used.
use crate::{
    entropy::{symbols, varint},
    Mesh,
};
use std::collections::HashMap;

const INVALID: usize = usize::MAX;

#[derive(Clone, Debug)]
pub struct Topology {
    /// Smaller of standard and valence connectivity, beginning with traversal type.
    pub connectivity: Vec<u8>,
    /// Input point labels for the three corners of each decoder-order triangle.
    pub reordered_indices: Vec<u32>,
    pub encoded_vertex_count: usize,
    /// Input point labels, in the published decoder's depth-first attribute order.
    pub attribute_sequence: Vec<u32>,
    pub points: usize,
    /// Topology vertices, independent of source point labels that may be duplicated.
    pub corner_vertices: Vec<u32>,
    pub opposite_corners: Vec<i32>,
    pub boundary_vertices: Vec<bool>,
    pub attribute_corners: Vec<usize>,
    /// Original input index-buffer corner corresponding to every decoded corner.
    pub source_corners: Vec<usize>,
}

#[derive(Debug)]
pub struct AttributeGroup {
    pub attributes: Vec<usize>,
    pub topology: Topology,
}

#[derive(Debug)]
pub struct GroupedTopology {
    pub topology: Topology,
    pub groups: Vec<AttributeGroup>,
}

fn next(c: usize) -> usize {
    c / 3 * 3 + (c + 1) % 3
}
fn previous(c: usize) -> usize {
    c / 3 * 3 + (c + 2) % 3
}

struct Union {
    parent: Vec<usize>,
    rank: Vec<u8>,
}
impl Union {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            rank: vec![0; n],
        }
    }
    fn root(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }
    fn join(&mut self, a: usize, b: usize) {
        let (mut a, mut b) = (self.root(a), self.root(b));
        if a == b {
            return;
        }
        if self.rank[a] < self.rank[b] {
            std::mem::swap(&mut a, &mut b);
        }
        self.parent[b] = a;
        if self.rank[a] == self.rank[b] {
            self.rank[a] += 1;
        }
    }
}

struct Corners {
    vertices: Vec<u32>,
    opposite: Vec<usize>,
    source: Vec<u32>,
    boundary: Vec<bool>,
}

fn corners(indices: &[u32]) -> Corners {
    let mut edges: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for c in 0..indices.len() {
        let (a, b) = (indices[next(c)], indices[previous(c)]);
        edges.entry((a.min(b), a.max(b))).or_default().push(c);
    }
    let mut opposite = vec![INVALID; indices.len()];
    let mut union = Union::new(indices.len());
    for group in edges.values() {
        if group.len() != 2 {
            continue;
        }
        let (a, b) = (group[0], group[1]);
        if a / 3 == b / 3 || indices[next(a)] == indices[previous(a)] {
            continue;
        }
        if indices[next(a)] != indices[previous(b)] || indices[previous(a)] != indices[next(b)] {
            continue;
        }
        opposite[a] = b;
        opposite[b] = a;
        union.join(next(a), previous(b));
        union.join(previous(a), next(b));
    }
    // Scan order determines ids, never HashMap iteration order.
    let mut labels = HashMap::new();
    let mut source = Vec::new();
    let vertices: Vec<u32> = (0..indices.len())
        .map(|c| {
            let root = union.root(c);
            *labels.entry(root).or_insert_with(|| {
                let id = source.len() as u32;
                source.push(indices[c]);
                id
            })
        })
        .collect();
    let mut boundary = vec![false; source.len()];
    for c in 0..vertices.len() {
        if opposite[c] == INVALID {
            boundary[vertices[next(c)] as usize] = true;
            boundary[vertices[previous(c)] as usize] = true;
        }
    }
    Corners {
        vertices,
        opposite,
        source,
        boundary,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Symbol {
    C,
    S,
    L,
    R,
    E,
}
impl Symbol {
    fn code(self) -> u32 {
        match self {
            Self::C => 0,
            Self::S => 1,
            Self::L => 3,
            Self::R => 5,
            Self::E => 7,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Split {
    source: usize,
    target: usize,
    right: bool,
}

#[derive(Debug)]
struct Traversal {
    symbols: Vec<Symbol>,
    order: Vec<usize>,
    seeds: Vec<Option<usize>>,
    splits: Vec<Split>,
}

#[cfg(test)]
fn traversal(table: &Corners) -> Result<Traversal, &'static str> {
    traversal_from(table, 0)
}

fn traversal_from(table: &Corners, seed_corner: usize) -> Result<Traversal, &'static str> {
    let faces = table.vertices.len() / 3;
    if faces == 0 {
        return Err("nonempty triangle indices required");
    }
    let seed_corner = seed_corner % table.vertices.len();
    let first_face = seed_corner / 3;
    let rotation = seed_corner % 3;
    let mut seen = vec![false; faces];
    let mut marked = table.boundary.clone();
    let mut pending: HashMap<usize, usize> = HashMap::new();
    let mut result = Traversal {
        symbols: Vec::new(),
        order: Vec::new(),
        seeds: Vec::new(),
        splits: Vec::new(),
    };
    let mut component_seen = vec![false; faces];
    for step in 0..faces {
        let initial = (first_face + step) % faces;
        if seen[initial] {
            continue;
        }
        let mut component = vec![initial];
        component_seen[initial] = true;
        let mut at = 0;
        while at < component.len() {
            for c in component[at] * 3..component[at] * 3 + 3 {
                let opposite = table.opposite[c];
                if opposite != INVALID && !component_seen[opposite / 3] {
                    component_seen[opposite / 3] = true;
                    component.push(opposite / 3);
                }
            }
            at += 1;
        }
        let boundary_gate = component
            .iter()
            .flat_map(|&f| f * 3..f * 3 + 3)
            .filter(|&c| table.opposite[c] == INVALID)
            .min_by_key(|&c| {
                (
                    ((c / 3 + faces - first_face) % faces),
                    (c % 3 + 3 - rotation) % 3,
                )
            });
        let gate = if let Some(c) = boundary_gate {
            result.seeds.push(None);
            c
        } else {
            let seed = initial * 3 + rotation;
            seen[initial] = true;
            for c in [seed, next(seed), previous(seed)] {
                marked[table.vertices[c] as usize] = true;
            }
            result.seeds.push(Some(seed));
            table.opposite[seed]
        };
        let mut stack = vec![gate];
        while let Some(&c) = stack.last() {
            if c == INVALID || seen[c / 3] {
                stack.pop();
                continue;
            }
            let id = result.symbols.len();
            seen[c / 3] = true;
            result.order.push(c);
            // A pending left branch entered through its gate is ordinary recursion.
            pending.remove(&table.opposite[c]);
            // Entering it through a side instead is the genus/boundary-loop merge.
            for (edge, right) in [(next(c), true), (previous(c), false)] {
                if let Some(target) = pending.remove(&table.opposite[edge]) {
                    result.splits.push(Split {
                        source: id,
                        target,
                        right,
                    });
                }
            }
            let left = table.opposite[previous(c)];
            let right = table.opposite[next(c)];
            let left_seen = left == INVALID || seen[left / 3];
            let right_seen = right == INVALID || seen[right / 3];
            let tip = table.vertices[c] as usize;
            let symbol = if !marked[tip] {
                if right == INVALID {
                    return Err("an interior tip has no right face");
                }
                marked[tip] = true;
                *stack.last_mut().unwrap() = right;
                Symbol::C
            } else if left_seen && right_seen {
                stack.pop();
                Symbol::E
            } else if left_seen {
                *stack.last_mut().unwrap() = right;
                Symbol::L
            } else if right_seen {
                *stack.last_mut().unwrap() = left;
                Symbol::R
            } else {
                pending.insert(previous(c), id);
                *stack.last_mut().unwrap() = left;
                stack.push(right);
                Symbol::S
            };
            result.symbols.push(symbol);
        }
    }
    if !pending.is_empty() || seen.iter().any(|&value| !value) {
        return Err("incomplete topology traversal");
    }
    Ok(result)
}

/// Binary ANS inverse of RabsDescRead; the output includes p0 and byte length.
pub(crate) fn binary(values: &[bool]) -> Vec<u8> {
    let zeros = values.iter().filter(|&&value| !value).count();
    let p0 = ((zeros as u64 * 256 + values.len() as u64 / 2) / values.len().max(1) as u64)
        .clamp(1, 255) as u32;
    let mut state = 4096u32;
    let mut data = Vec::new();
    for &value in values.iter().rev() {
        let probability = if value { 256 - p0 } else { p0 };
        while state >= 4096 * probability {
            data.push(state as u8);
            state >>= 8;
        }
        state = state / probability * 256 + state % probability + if value { 0 } else { 256 - p0 };
    }
    let final_state = state - 4096;
    let count = if final_state < 1 << 6 {
        1
    } else if final_state < 1 << 14 {
        2
    } else if final_state < 1 << 22 {
        3
    } else {
        4
    };
    for i in 0..count {
        data.push((final_state >> (8 * i)) as u8);
    }
    *data.last_mut().unwrap() |= ((count - 1) << 6) as u8;
    let mut out = vec![p0 as u8];
    varint(&mut out, data.len() as u64);
    out.extend(data);
    out
}

fn pack_bits(items: impl IntoIterator<Item = (u32, u32)>) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut bits, mut count) = (0u32, 0u32);
    for (value, width) in items {
        bits |= value << count;
        count += width;
        while count >= 8 {
            out.push(bits as u8);
            bits >>= 8;
            count -= 8;
        }
    }
    if count > 0 {
        out.push(bits as u8);
    }
    out
}

fn connectivity_header(
    table: &Corners,
    traversal: &Traversal,
    method: u8,
    attributes: usize,
) -> Vec<u8> {
    let mut out = vec![method];
    varint(&mut out, table.source.len() as u64);
    varint(&mut out, (table.vertices.len() / 3) as u64);
    out.push(attributes as u8);
    varint(&mut out, traversal.symbols.len() as u64);
    varint(
        &mut out,
        traversal
            .symbols
            .iter()
            .filter(|&&s| s == Symbol::S)
            .count() as u64,
    );
    varint(&mut out, traversal.splits.len() as u64);
    let mut previous_source = 0;
    for event in &traversal.splits {
        varint(&mut out, (event.source - previous_source) as u64);
        varint(&mut out, (event.source - event.target) as u64);
        previous_source = event.source;
    }
    out.extend(pack_bits(
        traversal
            .splits
            .iter()
            .map(|event| (u32::from(event.right), 1)),
    ));
    out
}

fn connectivity_standard(table: &Corners, traversal: &Traversal, seams: &[Vec<bool>]) -> Vec<u8> {
    let mut out = connectivity_header(table, traversal, 0, seams.len());
    let symbols = pack_bits(
        traversal
            .symbols
            .iter()
            .rev()
            .map(|&s| (s.code(), if s == Symbol::C { 1 } else { 3 })),
    );
    varint(&mut out, symbols.len() as u64);
    out.extend(symbols);
    out.extend(binary(
        &traversal
            .seeds
            .iter()
            .map(Option::is_some)
            .collect::<Vec<_>>(),
    ));
    for seam in seams {
        out.extend(binary(seam));
    }
    out
}

/// Simulate only the published decoder's topology state to obtain the context
/// preceding each symbol. Split copies remain independent until the S merge;
/// using input-vertex valences here would incorrectly combine those copies.
fn valence_contexts(walk: &Traversal) -> Result<[Vec<u32>; 6], &'static str> {
    let mut buckets: [Vec<u32>; 6] = std::array::from_fn(|_| Vec::new());
    let mut vertices: Vec<usize> = Vec::with_capacity(walk.symbols.len() * 3);
    let mut opposite = vec![INVALID; walk.symbols.len() * 3];
    let capacity = walk.symbols.len() * 3;
    let mut roots = Union::new(capacity);
    let mut valence = vec![0u32; capacity];
    let mut created = 0;
    let mut stack = Vec::new();
    let mut split_corners: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut source_events: HashMap<usize, Vec<Split>> = HashMap::new();
    for &event in &walk.splits {
        source_events.entry(event.source).or_default().push(event);
    }
    let mut context: Option<usize> = None;
    for (id, &symbol) in walk.symbols.iter().rev().enumerate() {
        if let Some(context) = context {
            buckets[context].push(match symbol {
                Symbol::C => 0,
                Symbol::S => 1,
                Symbol::L => 2,
                Symbol::R => 3,
                Symbol::E => 4,
            });
        } else if symbol != Symbol::E {
            return Err("first reverse topology symbol is not E");
        }
        let c = vertices.len();
        let (tip, next_vertex, previous_vertex);
        match symbol {
            Symbol::E => {
                tip = created;
                next_vertex = created + 1;
                previous_vertex = created + 2;
                created += 3;
                valence[tip] = 2;
                valence[next_vertex] = 2;
                valence[previous_vertex] = 2;
                stack.push(c);
            }
            Symbol::L | Symbol::R => {
                let a = *stack.last().ok_or("missing active L/R corner")?;
                *stack.last_mut().unwrap() = c;
                if symbol == Symbol::L {
                    opposite[a] = c + 1;
                    opposite[c + 1] = a;
                    tip = roots.root(vertices[next(a)]);
                    next_vertex = created;
                    created += 1;
                    previous_vertex = roots.root(vertices[previous(a)]);
                } else {
                    opposite[a] = c + 2;
                    opposite[c + 2] = a;
                    tip = roots.root(vertices[previous(a)]);
                    next_vertex = roots.root(vertices[next(a)]);
                    previous_vertex = created;
                    created += 1;
                }
                valence[tip] += 1;
                if symbol == Symbol::L {
                    valence[next_vertex] = 2;
                    valence[previous_vertex] += 1;
                } else {
                    valence[next_vertex] += 1;
                    valence[previous_vertex] = 2;
                }
            }
            Symbol::C => {
                let a = *stack.last().ok_or("missing active C corner")?;
                let mut b = previous(a);
                let mut remaining = c + 1;
                while opposite[b] != INVALID {
                    b = previous(opposite[b]);
                    remaining -= 1;
                    if remaining == 0 {
                        return Err("cyclic C boundary");
                    }
                }
                opposite[a] = c + 1;
                opposite[c + 1] = a;
                opposite[b] = c + 2;
                opposite[c + 2] = b;
                *stack.last_mut().unwrap() = c;
                tip = roots.root(vertices[next(a)]);
                next_vertex = roots.root(vertices[next(b)]);
                previous_vertex = roots.root(vertices[previous(a)]);
                valence[next_vertex] += 1;
                valence[previous_vertex] += 1;
            }
            Symbol::S => {
                let b = stack.pop().ok_or("missing right S corner")?;
                if let Some(extra) = split_corners.remove(&id) {
                    stack.extend(extra);
                }
                let a = *stack.last().ok_or("missing left S corner")?;
                opposite[a] = c + 2;
                opposite[c + 2] = a;
                opposite[b] = c + 1;
                opposite[c + 1] = b;
                *stack.last_mut().unwrap() = c;
                tip = roots.root(vertices[previous(a)]);
                next_vertex = roots.root(vertices[next(a)]);
                previous_vertex = roots.root(vertices[previous(b)]);
                let from = roots.root(vertices[next(b)]);
                if from == tip {
                    return Err("S merges one vertex with itself");
                }
                valence[tip] += valence[from];
                roots.parent[from] = tip;
                valence[next_vertex] += 1;
                valence[previous_vertex] += 1;
            }
        }
        vertices.extend([tip, next_vertex, previous_vertex]);
        context = Some((valence[roots.root(next_vertex)].clamp(2, 7) - 2) as usize);
        let encoder_id = walk.symbols.len() - id - 1;
        if let Some(events) = source_events.get(&encoder_id) {
            for event in events.iter().rev() {
                split_corners
                    .entry(walk.symbols.len() - event.target - 1)
                    .or_default()
                    .push(if event.right { next(c) } else { previous(c) });
            }
        }
    }
    Ok(buckets)
}

fn connectivity_valence(
    table: &Corners,
    walk: &Traversal,
    seams: &[Vec<bool>],
) -> Result<Vec<u8>, &'static str> {
    let buckets = valence_contexts(walk)?;
    let mut out = connectivity_header(table, walk, 2, seams.len());
    out.extend(binary(
        &walk.seeds.iter().map(Option::is_some).collect::<Vec<_>>(),
    ));
    for seam in seams {
        out.extend(binary(seam));
    }
    for bucket in buckets {
        varint(&mut out, bucket.len() as u64);
        if !bucket.is_empty() {
            out.extend(symbols(&bucket.into_iter().rev().collect::<Vec<_>>(), 1));
        }
    }
    Ok(out)
}

fn depth_first(vertices: &[u32], opposite: &[i32], boundary: &[bool]) -> (Vec<u32>, Vec<usize>) {
    let mut seen_face = vec![false; vertices.len() / 3];
    let mut seen_vertex = vec![false; boundary.len()];
    let mut sequence = Vec::new();
    let mut visited_corners = Vec::new();
    for seed_face in 0..seen_face.len() {
        if seen_face[seed_face] {
            continue;
        }
        let seed = seed_face * 3;
        for corner in [next(seed), previous(seed)] {
            let vertex = vertices[corner] as usize;
            if !seen_vertex[vertex] {
                seen_vertex[vertex] = true;
                sequence.push(vertex as u32);
                visited_corners.push(corner);
            }
        }
        let mut stack = vec![seed];
        while let Some(&top) = stack.last() {
            if top == INVALID || seen_face[top / 3] {
                stack.pop();
                continue;
            }
            let mut c = top;
            loop {
                seen_face[c / 3] = true;
                let vertex = vertices[c] as usize;
                if !seen_vertex[vertex] {
                    seen_vertex[vertex] = true;
                    sequence.push(vertex as u32);
                    visited_corners.push(c);
                    if !boundary[vertex] {
                        let right = opposite[next(c)];
                        if right >= 0 && !seen_face[right as usize / 3] {
                            c = right as usize;
                            continue;
                        }
                    }
                }
                let (left, right) = (opposite[previous(c)], opposite[next(c)]);
                let left_seen = left < 0 || seen_face[left as usize / 3];
                let right_seen = right < 0 || seen_face[right as usize / 3];
                if right_seen {
                    if left_seen {
                        stack.pop();
                        break;
                    }
                    c = left as usize;
                } else if left_seen {
                    c = right as usize;
                } else {
                    *stack.last_mut().unwrap() = left as usize;
                    stack.push(right as usize);
                    break;
                }
            }
        }
    }
    (sequence, visited_corners)
}

pub fn plan(mesh: &Mesh) -> Result<Topology, &'static str> {
    plan_seed(mesh, 0)
}

/// Explicit first component face and cyclic face-corner rotation. Geometry and
/// attribute rows are unchanged; only traversal and prediction order can change.
pub fn plan_seed(mesh: &Mesh, seed_corner: usize) -> Result<Topology, &'static str> {
    if mesh.indices.is_empty() || mesh.indices.len() % 3 != 0 {
        return Err("nonempty triangle indices required");
    }
    if mesh.indices.iter().any(|&v| v as usize >= mesh.points) {
        return Err("point index outside mesh");
    }
    let table = corners(&mesh.indices);
    let traversal = traversal_from(&table, seed_corner)?;
    assemble(&table, &traversal, &mesh.indices, &[])
}

fn assemble(
    table: &Corners,
    traversal: &Traversal,
    source_indices: &[u32],
    seams: &[Vec<bool>],
) -> Result<Topology, &'static str> {
    let standard = connectivity_standard(table, traversal, seams);
    let valence = connectivity_valence(table, traversal, seams)?;
    let connectivity = if valence.len() < standard.len() {
        valence
    } else {
        standard
    };
    let mut order: Vec<usize> = traversal.order.iter().rev().copied().collect();
    order.extend(traversal.seeds.iter().flatten().copied());
    let mut corner_vertices = Vec::with_capacity(source_indices.len());
    let mut source_corner = Vec::with_capacity(source_indices.len());
    let mut corner_map = vec![INVALID; source_indices.len()];
    for c in order {
        for original in [c, next(c), previous(c)] {
            corner_map[original] = corner_vertices.len();
            corner_vertices.push(table.vertices[original]);
            source_corner.push(original);
        }
    }
    let opposite_corners: Vec<i32> = source_corner
        .iter()
        .map(|&c| {
            let opposite = table.opposite[c];
            if opposite == INVALID {
                -1
            } else {
                corner_map[opposite] as i32
            }
        })
        .collect();
    let reordered_indices: Vec<u32> = source_corner.iter().map(|&c| source_indices[c]).collect();
    let (sequence, attribute_corners) =
        depth_first(&corner_vertices, &opposite_corners, &table.boundary);
    if sequence.len() != table.source.len() {
        return Err("incomplete attribute traversal");
    }
    let attribute_sequence = attribute_corners
        .iter()
        .map(|&c| reordered_indices[c])
        .collect();
    Ok(Topology {
        connectivity,
        reordered_indices,
        encoded_vertex_count: table.source.len(),
        attribute_sequence,
        points: table.source.len(),
        corner_vertices,
        opposite_corners,
        boundary_vertices: table.boundary.clone(),
        attribute_corners,
        source_corners: source_corner,
    })
}

fn cut_topology(base: &Topology, seams: &[bool]) -> Topology {
    let mut union = Union::new(base.corner_vertices.len());
    let mut opposite = base.opposite_corners.clone();
    for c in 0..opposite.len() {
        if seams[c] {
            opposite[c] = -1;
        }
        let o = opposite[c];
        if o < 0 {
            continue;
        }
        union.join(next(c), previous(o as usize));
        union.join(previous(c), next(o as usize));
    }
    let mut ids = HashMap::new();
    let mut count = 0usize;
    let vertices: Vec<u32> = (0..opposite.len())
        .map(|c| {
            let root = union.root(c);
            *ids.entry(root).or_insert_with(|| {
                let id = count as u32;
                count += 1;
                id
            })
        })
        .collect();
    let mut boundary = vec![false; count];
    for c in 0..opposite.len() {
        if opposite[c] < 0 {
            boundary[vertices[next(c)] as usize] = true;
            boundary[vertices[previous(c)] as usize] = true;
        }
    }
    let (_, attribute_corners) = depth_first(&vertices, &opposite, &boundary);
    let attribute_sequence = attribute_corners
        .iter()
        .map(|&c| base.reordered_indices[c])
        .collect();
    Topology {
        connectivity: Vec::new(),
        reordered_indices: base.reordered_indices.clone(),
        encoded_vertex_count: count,
        attribute_sequence,
        points: count,
        corner_vertices: vertices,
        opposite_corners: opposite,
        boundary_vertices: boundary,
        attribute_corners,
        source_corners: base.source_corners.clone(),
    }
}

/// Weld position rows, then encode each distinct attribute seam graph once.
/// Every group retains original source rows for payload and prediction. The
/// top-level points count includes the union of all corner-attribute seams.
pub fn plan_groups(mesh: &Mesh) -> Result<GroupedTopology, &'static str> {
    plan_groups_seed(mesh, 0)
}

/// The independent attribute seam graphs with the same explicit seed choice.
pub fn plan_groups_seed(mesh: &Mesh, seed_corner: usize) -> Result<GroupedTopology, &'static str> {
    let position = mesh
        .attributes
        .iter()
        .position(|a| a.kind == 0)
        .ok_or("position attribute required for seam topology")?;
    let stride = |attribute: &crate::Attribute| -> Result<usize, &'static str> {
        crate::scalar_size(attribute.data_type)
            .map(|n| n * attribute.width)
            .ok_or("unsupported attribute scalar")
    };
    let position_stride = stride(&mesh.attributes[position])?;
    let position_bytes = &mesh.attributes[position].bytes;
    let mut position_labels: HashMap<&[u8], u32> = HashMap::new();
    let mut source_to_position = Vec::with_capacity(mesh.points);
    for point in 0..mesh.points {
        let row = position_bytes
            .get(point * position_stride..(point + 1) * position_stride)
            .ok_or("invalid position dimensions")?;
        let count = position_labels.len() as u32;
        source_to_position.push(*position_labels.entry(row).or_insert(count));
    }
    let welded: Vec<u32> = mesh
        .indices
        .iter()
        .map(|&v| {
            source_to_position
                .get(v as usize)
                .copied()
                .ok_or("point index outside mesh")
        })
        .collect::<Result<_, _>>()?;
    if welded.is_empty() || welded.len() % 3 != 0 {
        return Err("nonempty triangle indices required");
    }
    let table = corners(&welded);
    let walk = traversal_from(&table, seed_corner)?;
    let mut topology = assemble(&table, &walk, &mesh.indices, &[])?;
    let mut patterns: Vec<(Vec<bool>, Vec<usize>)> =
        vec![(vec![false; welded.len()], vec![position])];
    for (attribute_index, attribute) in mesh.attributes.iter().enumerate() {
        if attribute_index == position {
            continue;
        }
        let width = stride(attribute)?;
        if attribute.bytes.len() != mesh.points * width {
            return Err("invalid attribute dimensions");
        }
        let equal = |a: usize, b: usize| {
            let (a, b) = (
                topology.reordered_indices[a] as usize,
                topology.reordered_indices[b] as usize,
            );
            attribute.bytes[a * width..(a + 1) * width]
                == attribute.bytes[b * width..(b + 1) * width]
        };
        let mut seam = vec![false; welded.len()];
        for c in 0..seam.len() {
            let o = topology.opposite_corners[c];
            if o < 0 || o as usize <= c {
                continue;
            }
            if !equal(next(c), previous(o as usize)) || !equal(previous(c), next(o as usize)) {
                seam[c] = true;
                seam[o as usize] = true;
            }
        }
        if let Some((_, attributes)) = patterns.iter_mut().find(|(pattern, _)| *pattern == seam) {
            attributes.push(attribute_index);
        } else {
            patterns.push((seam, vec![attribute_index]));
        }
    }
    if patterns.len() > 255 {
        return Err("too many attribute seam graphs");
    }
    let mut streams = Vec::new();
    let mut union_seam = vec![false; welded.len()];
    let mut groups = Vec::with_capacity(patterns.len());
    for (index, (seam, attributes)) in patterns.into_iter().enumerate() {
        if index > 0 {
            streams.push(
                (0..seam.len())
                    .filter(|&c| topology.opposite_corners[c] >= c as i32)
                    .map(|c| seam[c])
                    .collect(),
            );
            for (out, value) in union_seam.iter_mut().zip(&seam) {
                *out |= value;
            }
        }
        groups.push(AttributeGroup {
            attributes,
            topology: cut_topology(&topology, &seam),
        });
    }
    let standard = connectivity_standard(&table, &walk, &streams);
    let valence = connectivity_valence(&table, &walk, &streams)?;
    topology.connectivity = if valence.len() < standard.len() {
        valence
    } else {
        standard
    };
    topology.points = cut_topology(&topology, &union_seam).points;
    Ok(GroupedTopology { topology, groups })
}

/// Bound candidate input volume in index corners plus source attribute scalar
/// cells, rather than elapsed time. Large meshes receive only the baseline.
/// Callers retain the smallest complete payload, including that baseline.
pub fn seed_candidates(mesh: &Mesh) -> Vec<usize> {
    const WORK_BUDGET: usize = 8192;
    const MAX_PLANS: usize = 8;
    let faces = mesh.indices.len() / 3;
    if faces == 0 {
        return Vec::new();
    }
    let scalars = mesh.attributes.iter().map(|a| a.width).sum::<usize>();
    let work = mesh
        .indices
        .len()
        .saturating_add(mesh.points.saturating_mul(scalars))
        .max(1);
    let count = (WORK_BUDGET / work).clamp(1, MAX_PLANS).min(faces);
    (0..count).map(|i| i * faces / count * 3).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn mesh(indices: Vec<u32>) -> Mesh {
        Mesh {
            points: indices.iter().copied().max().unwrap_or(0) as usize + 1,
            indices,
            attributes: Vec::new(),
            encode_speed: 5,
            decode_speed: 5,
        }
    }

    #[test]
    fn alternative_seeds_preserve_closed_open_and_multicomponent_topology() {
        for input in [
            mesh(vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
            mesh(vec![0, 1, 2, 3, 4, 5, 6, 7, 8]),
            grid(7, 5, true, true, &[]),
            grid(7, 7, true, true, &[(1, 1), (3, 3)]),
        ] {
            let table = corners(&input.indices);
            for seed in [0, 1, 2, input.indices.len() / 2, input.indices.len() - 1] {
                let walk = traversal_from(&table, seed).unwrap();
                replay(&table, &walk);
                let plan = plan_seed(&input, seed).unwrap();
                assert_eq!(plan.reordered_indices.len(), input.indices.len());
                assert_eq!(plan.attribute_sequence.len(), plan.points);
            }
        }
    }

    #[test]
    fn seed_search_has_a_deterministic_work_bound_and_keeps_the_baseline() {
        for input in [grid(6, 5, false, false, &[]), grid(25, 25, true, true, &[])] {
            let seeds = seed_candidates(&input);
            assert_eq!(seeds[0], 0);
            assert!(seeds.len() <= 8);
            assert!(seeds.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(seeds.iter().all(|&c| c < input.indices.len() && c % 3 == 0));
            if seeds.len() > 1 {
                assert!(seeds.len() * input.indices.len() <= 8192);
            }
        }
        assert_eq!(seed_candidates(&grid(50, 50, true, true, &[])), [0]);
    }

    fn grid(w: u32, h: u32, wrap_x: bool, wrap_y: bool, holes: &[(u32, u32)]) -> Mesh {
        let mut indices = Vec::new();
        let vertex = |x: u32, y: u32| (y % h) * w + x % w;
        for y in 0..if wrap_y { h } else { h - 1 } {
            for x in 0..if wrap_x { w } else { w - 1 } {
                if holes.contains(&(x, y)) {
                    continue;
                }
                let (a, b, c, d) = (
                    vertex(x, y),
                    vertex(x + 1, y),
                    vertex(x + 1, y + 1),
                    vertex(x, y + 1),
                );
                indices.extend([a, b, c, a, c, d]);
            }
        }
        mesh(indices)
    }

    // A fresh inverse-state replay from the published decoding equations. This
    // checks every vertex merge and triangle orientation, including handle events.
    fn replay(table: &Corners, walk: &Traversal) {
        let mut vertices: Vec<usize> = Vec::new();
        let mut opposite: Vec<usize> = Vec::new();
        let mut labels: Vec<u32> = Vec::new();
        let mut stack = Vec::new();
        let mut splits: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for (id, (&source, &symbol)) in walk
            .order
            .iter()
            .rev()
            .zip(walk.symbols.iter().rev())
            .enumerate()
        {
            let c = vertices.len();
            opposite.extend([INVALID; 3]);
            let wanted = [
                table.vertices[source],
                table.vertices[next(source)],
                table.vertices[previous(source)],
            ];
            let mut join = |a: usize, b: usize| {
                opposite[a] = b;
                opposite[b] = a;
            };
            match symbol {
                Symbol::E => {
                    for value in wanted {
                        vertices.push(labels.len());
                        labels.push(value);
                    }
                    stack.push(c);
                }
                Symbol::L => {
                    let a = *stack.last().unwrap();
                    join(a, c + 1);
                    *stack.last_mut().unwrap() = c;
                    let new = labels.len();
                    labels.push(wanted[1]);
                    vertices.extend([vertices[next(a)], new, vertices[previous(a)]]);
                }
                Symbol::R => {
                    let a = *stack.last().unwrap();
                    join(a, c + 2);
                    *stack.last_mut().unwrap() = c;
                    let new = labels.len();
                    labels.push(wanted[2]);
                    vertices.extend([vertices[previous(a)], vertices[next(a)], new]);
                }
                Symbol::C => {
                    let a = *stack.last().unwrap();
                    let mut b = previous(a);
                    let mut fuel = opposite.len();
                    while opposite[b] != INVALID {
                        b = previous(opposite[b]);
                        fuel -= 1;
                        assert!(fuel > 0);
                    }
                    opposite[a] = c + 1;
                    opposite[c + 1] = a;
                    opposite[b] = c + 2;
                    opposite[c + 2] = b;
                    *stack.last_mut().unwrap() = c;
                    vertices.extend([vertices[next(a)], vertices[next(b)], vertices[previous(a)]]);
                }
                Symbol::S => {
                    let b = stack.pop().unwrap();
                    if let Some(extra) = splits.remove(&id) {
                        stack.extend(extra);
                    }
                    let a = *stack.last().unwrap();
                    join(a, c + 2);
                    join(b, c + 1);
                    *stack.last_mut().unwrap() = c;
                    let (from, to) = (vertices[next(b)], vertices[previous(a)]);
                    assert_eq!(labels[from], labels[to]);
                    for vertex in &mut vertices {
                        if *vertex == from {
                            *vertex = to;
                        }
                    }
                    vertices.extend([to, vertices[next(a)], vertices[previous(b)]]);
                }
            }
            assert_eq!(
                [
                    labels[vertices[c]],
                    labels[vertices[c + 1]],
                    labels[vertices[c + 2]]
                ],
                wanted
            );
            let encoder_id = walk.symbols.len() - id - 1;
            for event in walk
                .splits
                .iter()
                .filter(|event| event.source == encoder_id)
                .rev()
            {
                splits
                    .entry(walk.symbols.len() - event.target - 1)
                    .or_default()
                    .push(if event.right { next(c) } else { previous(c) });
            }
        }
        for seed in &walk.seeds {
            let a = stack.pop().unwrap();
            let Some(seed) = seed else {
                continue;
            };
            let mut b = previous(a);
            let mut fuel = opposite.len();
            while opposite[b] != INVALID {
                b = previous(opposite[b]);
                fuel -= 1;
                assert!(fuel > 0);
            }
            let mut d = next(a);
            fuel = opposite.len();
            while opposite[d] != INVALID {
                d = next(opposite[d]);
                fuel -= 1;
                assert!(fuel > 0);
            }
            let c = vertices.len();
            opposite.extend([INVALID; 3]);
            vertices.extend([vertices[next(b)], vertices[next(d)], vertices[next(a)]]);
            assert_eq!(
                [
                    labels[vertices[c]],
                    labels[vertices[c + 1]],
                    labels[vertices[c + 2]]
                ],
                [
                    table.vertices[*seed],
                    table.vertices[next(*seed)],
                    table.vertices[previous(*seed)]
                ]
            );
            for (left, right) in [(c, a), (c + 1, b), (c + 2, d)] {
                opposite[left] = right;
                opposite[right] = left;
            }
        }
        assert!(stack.is_empty());
        assert!(splits.is_empty());
        assert_eq!(vertices.len(), table.vertices.len());
        let s = walk.symbols.iter().filter(|&&s| s == Symbol::S).count();
        assert_eq!(labels.len() - s, table.source.len());
        for c in 0..opposite.len() {
            if opposite[c] == INVALID {
                continue;
            }
            let o = opposite[c];
            assert_eq!(labels[vertices[next(c)]], labels[vertices[previous(o)]]);
            assert_eq!(labels[vertices[previous(c)]], labels[vertices[next(o)]]);
        }
    }

    #[test]
    fn clers_preserves_holes_handles_components_and_pathological_faces() {
        let meshes = [
            mesh(vec![0, 1, 2]),
            mesh(vec![0, 1, 2, 0, 2, 3]),
            mesh(vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
            grid(6, 5, false, false, &[]),
            grid(7, 5, true, false, &[]),
            grid(7, 5, true, true, &[]),
            grid(7, 7, false, false, &[(1, 1), (3, 3)]),
            grid(7, 7, true, true, &[(1, 1), (3, 3)]),
            mesh(vec![0, 1, 2, 3, 4, 5]),
            mesh(vec![0, 1, 2, 0, 3, 4]),
            mesh(vec![0, 1, 2, 1, 0, 3, 0, 1, 4]),
            mesh(vec![0, 0, 1, 1, 1, 1]),
            mesh(vec![0, 1, 2, 0, 1, 2]),
        ];
        for input in meshes {
            let table = corners(&input.indices);
            let walk = traversal(&table).unwrap();
            replay(&table, &walk);
            let result = plan(&input).unwrap();
            assert_eq!(result.reordered_indices.len(), input.indices.len());
            assert_eq!(result.attribute_sequence.len(), result.points);
            assert_eq!(result.attribute_corners.len(), result.points);
            for (&corner, &source) in result
                .attribute_corners
                .iter()
                .zip(&result.attribute_sequence)
            {
                assert_eq!(result.reordered_indices[corner], source);
            }
        }
    }

    #[test]
    fn binary_ans_inverts_published_equation_at_probability_extremes() {
        for values in [
            vec![],
            vec![false; 1000],
            vec![true; 1000],
            (0..1000).map(|i| i % 3 == 0).collect(),
        ] {
            let bytes = binary(&values);
            let p0 = bytes[0] as u32;
            let mut offset = 1;
            let mut size = 0;
            let mut shift = 0;
            loop {
                let byte = bytes[offset];
                offset += 1;
                size |= ((byte & 127) as usize) << shift;
                if byte < 128 {
                    break;
                }
                shift += 7;
            }
            let data = &bytes[offset..offset + size];
            let count = ((data[size - 1] >> 6) + 1) as usize;
            let mut at = size - count;
            let mut state = 0u32;
            for i in 0..count {
                state |= (data[at + i] as u32) << (8 * i);
            }
            state &= (1 << (8 * count - 2)) - 1;
            state += 4096;
            for wanted in values {
                if state < 4096 {
                    at -= 1;
                    state = state * 256 + data[at] as u32;
                }
                let p = 256 - p0;
                let (q, r) = (state / 256, state % 256);
                let actual = r < p;
                state = if actual { q * p + r } else { state - q * p - p };
                assert_eq!(actual, wanted);
            }
            assert_eq!(state, 4096);
            assert_eq!(at, 0);
        }
    }

    #[test]
    fn handles_require_split_records_and_plans_are_deterministic() {
        let input = grid(7, 5, true, true, &[]);
        let table = corners(&input.indices);
        let walk = traversal(&table).unwrap();
        assert_eq!(walk.splits.len(), 2);
        let expected = plan(&input).unwrap().connectivity;
        for _ in 0..10 {
            assert_eq!(plan(&input).unwrap().connectivity, expected);
        }
    }

    #[test]
    fn valence_uses_all_symbols_except_the_implicit_initial_e() {
        let input = grid(25, 25, true, true, &[]);
        let table = corners(&input.indices);
        let walk = traversal(&table).unwrap();
        let buckets = valence_contexts(&walk).unwrap();
        assert_eq!(
            buckets.iter().map(Vec::len).sum::<usize>(),
            walk.symbols.len() - 1
        );
        let standard = connectivity_standard(&table, &walk, &[]);
        let valence = connectivity_valence(&table, &walk, &[]).unwrap();
        assert!(valence.len() < standard.len());
        assert_eq!(plan(&input).unwrap().connectivity, valence);
    }

    #[test]
    fn arbitrary_triangle_soups_preserve_every_oriented_face() {
        let mut state = 0x13a5_47cdu32;
        for _ in 0..256 {
            let mut indices = Vec::new();
            for _ in 0..36 {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                indices.push((state >> 16) % 9);
            }
            let input = mesh(indices);
            let table = corners(&input.indices);
            let walk = traversal(&table).unwrap();
            replay(&table, &walk);
            let result = plan(&input).unwrap();
            assert_eq!(result.reordered_indices.len(), input.indices.len());
            assert_eq!(result.attribute_sequence.len(), result.points);
        }
    }

    #[test]
    fn uv_seams_share_position_weights_and_normals_without_changing_corner_rows() {
        fn attribute(kind: u8, width: usize, rows: &[f32]) -> crate::Attribute {
            crate::Attribute {
                kind,
                data_type: 9,
                width,
                normalized: false,
                bits: 0,
                grid: None,
                bytes: rows.iter().flat_map(|v| v.to_le_bytes()).collect(),
            }
        }
        let input = Mesh {
            points: 6,
            indices: vec![0, 1, 2, 3, 4, 5],
            encode_speed: 5,
            decode_speed: 5,
            attributes: vec![
                attribute(
                    0,
                    3,
                    &[
                        0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0.,
                    ],
                ),
                attribute(
                    4,
                    4,
                    &[
                        1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0.,
                        0., 1., 0., 0., 0.,
                    ],
                ),
                attribute(3, 2, &[0., 0., 1., 0., 1., 1., 0.25, 0., 0.75, 1., 0., 1.]),
                attribute(
                    1,
                    3,
                    &[
                        0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1.,
                    ],
                ),
            ],
        };
        let plan = plan_groups(&input).unwrap();
        assert_eq!(plan.topology.encoded_vertex_count, 4);
        assert_eq!(plan.topology.points, 6);
        assert_eq!(plan.groups.len(), 2);
        assert_eq!(plan.groups[0].attributes, [0, 1, 3]);
        assert_eq!(plan.groups[0].topology.attribute_sequence.len(), 4);
        assert_eq!(plan.groups[1].attributes, [2]);
        assert_eq!(plan.groups[1].topology.attribute_sequence.len(), 6);
        for group in &plan.groups {
            let mut row_for_vertex = vec![0u32; group.topology.points];
            for (&corner, &source) in group
                .topology
                .attribute_corners
                .iter()
                .zip(&group.topology.attribute_sequence)
            {
                row_for_vertex[group.topology.corner_vertices[corner] as usize] = source;
            }
            for (corner, &vertex) in group.topology.corner_vertices.iter().enumerate() {
                let actual = row_for_vertex[vertex as usize] as usize;
                let expected = plan.topology.reordered_indices[corner] as usize;
                for &index in &group.attributes {
                    let attribute = &input.attributes[index];
                    let stride = attribute.width * 4;
                    assert_eq!(
                        attribute.bytes[actual * stride..(actual + 1) * stride],
                        attribute.bytes[expected * stride..(expected + 1) * stride]
                    );
                }
            }
        }
    }
}
