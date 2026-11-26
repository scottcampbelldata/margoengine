// Clean room: binned surface-area BVH and conservative float bounds. The
// triangle predicate runs on the GPU; no engine, parser or foreign kernel code.
use std::cell::RefCell;

#[derive(Clone)]
struct Triangle {
    words: [u32; 16],
    attributes: Option<[u32; 16]>,
    indices: [usize; 3],
    // Union of both shutter ends for the SAH; close and open bound each end (equal for a still triangle).
    lo: [f32; 3],
    hi: [f32; 3],
    close: ([f32; 3], [f32; 3]),
    open: ([f32; 3], [f32; 3]),
    // Shutter-open vertices of a deforming mesh (FG-17 piece 4b), xyz per vertex.
    previous: Option<[u32; 9]>,
    center: [f64; 3],
}
impl Triangle {
    // A TLAS leaf: an instance's world box, the same at both shutter ends.
    fn leaf(lo: [f32; 3], hi: [f32; 3], center: [f64; 3]) -> Self {
        Self { words: [0; 16], attributes: None, indices: [0; 3], lo, hi, close: (lo, hi), open: (lo, hi), previous: None, center }
    }
}
thread_local! {
    static OUTPUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}

fn equal_words_slice(input: &[u32]) -> bool {
    if input.len() % 2 != 0 { return false; }
    let (a,b) = input.split_at(input.len()/2);
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use std::arch::wasm32::*;
        let mut left = a.chunks_exact(4); let mut right = b.chunks_exact(4);
        for (x,y) in left.by_ref().zip(right.by_ref()) {
            if !i32x4_all_true(i32x4_eq(v128_load(x.as_ptr().cast()), v128_load(y.as_ptr().cast()))) { return false; }
        }
        left.remainder() == right.remainder()
    }
    #[cfg(not(target_arch = "wasm32"))]
    { a == b }
}
/// Compare two consecutive equally sized word sequences. No hash collision or revision assumption.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn equal_words(ptr: *const u32, len: usize) -> u32 {
    u32::from(equal_words_slice(unsafe { std::slice::from_raw_parts(ptr,len) }))
}

#[unsafe(no_mangle)]
pub extern "C" fn allocate(len: usize) -> *mut u32 {
    let data = vec![0u32; len].into_boxed_slice();
    Box::into_raw(data) as *mut u32
}
/// The pointer and length must be a live allocation returned by allocate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(ptr: *mut u32, len: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

// Validate four independent coordinates per Wasm instruction group. Native
// tests use the same exact finite/range predicate, with no tolerance change.
fn valid_positions(values: &[u32]) -> bool {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use std::arch::wasm32::*;
        let mut chunks = values.chunks_exact(4);
        for c in &mut chunks {
            let v = f32x4_abs(v128_load(c.as_ptr().cast()));
            if !i32x4_all_true(f32x4_le(v, f32x4_splat(1e8))) {
                return false;
            }
        }
        chunks
            .remainder()
            .iter()
            .all(|v| f32::from_bits(*v).abs() <= 1e8)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        values.iter().all(|v| f32::from_bits(*v).abs() <= 1e8)
    }
}

// Products of two Float32 inputs are exact in Float64. Grow an error-free
// expansion of the six signed products rather than subtracting rounded edges;
// a tiny nonzero triangle near large coordinates must not be discarded.
fn oriented_area(points: &[[f64; 3]; 3], x: usize, y: usize) -> f64 {
    let mut expansion = [0.0f64; 6];
    let mut len = 0;
    for i in 0..3 {
        let j = (i + 1) % 3;
        for value in [points[i][x] * points[j][y], -points[i][y] * points[j][x]] {
            let mut carry = value;
            let mut used = 0;
            for k in 0..len {
                let old = expansion[k];
                let sum = carry + old;
                let recovered = sum - carry;
                let error = (carry - (sum - recovered)) + (old - recovered);
                if error != 0.0 {
                    expansion[used] = error;
                    used += 1;
                }
                carry = sum;
            }
            if carry != 0.0 {
                expansion[used] = carry;
                used += 1;
            }
            len = used;
        }
    }
    if len == 0 { 0.0 } else { expansion[len - 1] }
}

// A parsed face: mesh, material, face in its mesh, vertex indices, shutter-close corners.
type Face = (u32, u32, u32, [usize; 3], [u32; 9]);
fn parse(input: &[u32]) -> Result<(Vec<Triangle>, u32), u32> {
    let Some(&meshes) = input.first() else {
        return Err(1);
    };
    let mut at = 1usize;
    let mut triangles = Vec::new();
    let mut submitted = 0usize;
    let mut ordinal = 0u32;
    let mut skipped = 0u32;
    let mut vertex_counts = Vec::new();
    let mut faces: Vec<Face> = Vec::new();
    for mesh in 0..meshes {
        if at + 3 > input.len() {
            return Err(1);
        }
        let vertices = input[at] as usize;
        let count = input[at + 1] as usize;
        vertex_counts.push(vertices);
        let material = input[at + 2];
        at += 3;
        submitted = submitted.checked_add(count / 3).ok_or(1u32)?;
        if material == 0 || material > 255 || count % 3 != 0 || submitted > 1_000_000 {
            return Err(1);
        }
        let end = at
            .checked_add(vertices.checked_mul(3).ok_or(1u32)?)
            .ok_or(1u32)?;
        let last = end.checked_add(count).ok_or(1u32)?;
        if last > input.len() {
            return Err(1);
        }
        let positions = &input[at..end];
        if !valid_positions(positions) {
            return Err(2);
        }
        for (face, ids) in input[end..last].chunks_exact(3).enumerate() {
            if ids.iter().any(|i| *i as usize >= vertices) {
                return Err(3);
            }
            let indices = [ids[0] as usize, ids[1] as usize, ids[2] as usize];
            let corners = std::array::from_fn(|i| positions[indices[i / 3] * 3 + i % 3]);
            faces.push((mesh, material, face as u32, indices, corners));
        }
        at = last;
    }
    let mut attributes = Vec::new();
    if at < input.len() && input[at] == 0x4d415454 {
        at += 1;
        for &vertices in &vertex_counts {
            if at + 2 > input.len() {
                return Err(1);
            }
            let nn = input[at] as usize;
            let nu = input[at + 1] as usize;
            at += 2;
            if (nn != 0 && nn != vertices * 3)
                || (nu != 0 && nu != vertices * 2)
                || at + nn + nu > input.len()
            {
                return Err(1);
            }
            let normals = &input[at..at + nn];
            let uvs = &input[at + nn..at + nn + nu];
            at += nn + nu;
            if normals.chunks_exact(3).any(|n| {
                !n.iter().all(|v| f32::from_bits(*v).is_finite())
                    || n.iter().all(|v| f32::from_bits(*v) == 0.)
            }) {
                return Err(4);
            }
            if !valid_positions(uvs) {
                return Err(5);
            }
            attributes.push((normals, uvs));
        }
    }
    // Shutter-open positions (FG-17 piece 4b): per mesh a count (0, or its position count) and the values.
    let mut previous = Vec::new();
    if at < input.len() && input[at] == 0x4d505256 {
        at += 1;
        for &vertices in &vertex_counts {
            let Some(&n) = input.get(at) else {
                return Err(1);
            };
            let n = n as usize;
            at += 1;
            if (n != 0 && n != vertices * 3) || at + n > input.len() {
                return Err(1);
            }
            if !valid_positions(&input[at..at + n]) {
                return Err(2);
            }
            previous.push(&input[at..at + n]);
            at += n;
        }
    }
    if at != input.len() {
        return Err(1);
    }
    let points_of = |c: &[u32; 9]| -> [[f64; 3]; 3] {
        std::array::from_fn(|k| std::array::from_fn(|a| f32::from_bits(c[k * 3 + a]) as f64))
    };
    let unit = |points: &[[f64; 3]; 3]| -> Option<[f64; 3]> {
        let n = [
            oriented_area(points, 1, 2),
            oriented_area(points, 2, 0),
            oriented_area(points, 0, 1),
        ];
        let length = n.iter().map(|v| v * v).sum::<f64>().sqrt();
        (length != 0.0).then(|| n.map(|v| v / length))
    };
    let bounds = |p: &[[f64; 3]; 3]| -> ([f32; 3], [f32; 3]) {
        (
            std::array::from_fn(|i| p.iter().map(|v| v[i] as f32).fold(f32::INFINITY, f32::min)),
            std::array::from_fn(|i| p.iter().map(|v| v[i] as f32).fold(f32::NEG_INFINITY, f32::max)),
        )
    };
    for (mesh, material, face, indices, corners) in faces {
        let open = previous
            .get(mesh as usize)
            .filter(|p| !p.is_empty())
            .map(|p| std::array::from_fn::<u32, 9, _>(|i| p[indices[i / 3] * 3 + i % 3]));
        let points = points_of(&corners);
        let before = open.as_ref().map(points_of);
        // Every input face keeps its ordinal, skipped ones included (picking ids are input order).
        let index = ordinal;
        ordinal += 1;
        // A deforming triangle is skipped only when it has zero area at both shutter ends.
        let Some(normal) = unit(&points).or_else(|| before.as_ref().and_then(unit)) else {
            skipped += 1;
            continue;
        };
        let mut words = [0u32; 16];
        for k in 0..3 {
            for axis in 0..3 {
                words[k * 4 + axis] = corners[k * 3 + axis];
            }
        }
        words[3] = material;
        words[7] = face;
        words[11] = mesh;
        words[15] = index;
        for i in 0..3 {
            words[12 + i] = (normal[i] as f32).to_bits();
        }
        let close = bounds(&points);
        let opened = before.as_ref().map_or(close, bounds);
        let ends = before.unwrap_or(points);
        triangles.push(Triangle {
            words,
            attributes: None,
            indices,
            lo: std::array::from_fn(|i| close.0[i].min(opened.0[i])),
            hi: std::array::from_fn(|i| close.1[i].max(opened.1[i])),
            close,
            open: opened,
            previous: open,
            center: std::array::from_fn(|i| {
                (points[0][i] + points[1][i] + points[2][i] + ends[0][i] + ends[1][i] + ends[2][i]) / 6.0
            }),
        });
    }
    for t in &mut triangles {
        let Some(&(normals, uvs)) = attributes.get(t.words[11] as usize) else {
            continue;
        };
        if normals.is_empty() && uvs.is_empty() {
            continue;
        }
        let mut a = [0u32; 16];
        if !normals.is_empty() {
            a[15] |= 1;
            for k in 0..3 {
                let n = std::array::from_fn::<_, 3, _>(|i| f32::from_bits(normals[t.indices[k] * 3 + i]) as f64);
                let len = n.iter().map(|v| v * v).sum::<f64>().sqrt();
                for i in 0..3 {
                    a[k * 4 + i] = ((n[i] / len) as f32).to_bits();
                }
            }
        }
        if !uvs.is_empty() {
            a[15] |= 2;
            for (k, slot) in [3, 7, 11, 12, 13, 14].into_iter().enumerate() {
                a[slot] = uvs[t.indices[k / 2] * 2 + k % 2];
            }
        }
        t.attributes = Some(a);
    }
    Ok((triangles, skipped))
}

#[derive(Clone, Copy)]
struct Bounds {
    lo: [f32; 3],
    hi: [f32; 3],
    count: usize,
}
impl Bounds {
    const EMPTY: Self = Self {
        lo: [f32::INFINITY; 3],
        hi: [f32::NEG_INFINITY; 3],
        count: 0,
    };
    fn add(&mut self, other: Self) {
        if other.count == 0 {
            return;
        }
        self.count += other.count;
        for a in 0..3 {
            self.lo[a] = self.lo[a].min(other.lo[a]);
            self.hi[a] = self.hi[a].max(other.hi[a]);
        }
    }
    fn area(self) -> f64 {
        if self.count == 0 {
            return 0.0;
        }
        let d = std::array::from_fn::<_, 3, _>(|a| self.hi[a] as f64 - self.lo[a] as f64);
        2.0 * (d[0] * d[1] + d[1] * d[2] + d[2] * d[0])
    }
}
const BINS: usize = 16;
fn bin(center: f64, lo: f64, extent: f64) -> usize {
    (((center - lo) / extent * BINS as f64) as usize).min(BINS - 1)
}
fn partition(triangles: &[Triangle], order: &mut [usize], depth: usize) -> usize {
    let mut best = f64::INFINITY;
    let mut split = None;
    // A bounded SAH prefix avoids an adversarial chain exhausting the Wasm
    // stack; the remaining median tree has at most ceil(log2(N)) levels.
    if depth < 32 {
        for axis in 0..3 {
            let lo = order
                .iter()
                .map(|i| triangles[*i].center[axis])
                .fold(f64::INFINITY, f64::min);
            let hi = order
                .iter()
                .map(|i| triangles[*i].center[axis])
                .fold(f64::NEG_INFINITY, f64::max);
            let extent = hi - lo;
            if extent == 0.0 {
                continue;
            }
            let mut bins = [Bounds::EMPTY; BINS];
            for &i in order.iter() {
                let t = &triangles[i];
                bins[bin(t.center[axis], lo, extent)].add(Bounds {
                    lo: t.lo,
                    hi: t.hi,
                    count: 1,
                });
            }
            let mut right = [Bounds::EMPTY; BINS];
            let mut all = Bounds::EMPTY;
            for i in (0..BINS).rev() {
                all.add(bins[i]);
                right[i] = all;
            }
            let mut left = Bounds::EMPTY;
            for i in 0..BINS - 1 {
                left.add(bins[i]);
                let r = right[i + 1];
                if left.count == 0 || r.count == 0 {
                    continue;
                }
                let cost = left.area() * left.count as f64 + r.area() * r.count as f64;
                if cost < best {
                    best = cost;
                    split = Some((axis, lo, extent, i));
                }
            }
        }
    }
    if let Some((axis, lo, extent, cut)) = split {
        let mut mid = 0;
        for i in 0..order.len() {
            if bin(triangles[order[i]].center[axis], lo, extent) <= cut {
                order.swap(mid, i);
                mid += 1;
            }
        }
        if mid > 0 && mid < order.len() {
            return mid;
        }
    }
    let mid = order.len() / 2;
    let axis = (0..3)
        .max_by(|a, b| {
            let extent = |axis: usize| {
                let lo = order
                    .iter()
                    .map(|i| triangles[*i].center[axis])
                    .fold(f64::INFINITY, f64::min);
                let hi = order
                    .iter()
                    .map(|i| triangles[*i].center[axis])
                    .fold(f64::NEG_INFINITY, f64::max);
                hi - lo
            };
            extent(*a).total_cmp(&extent(*b))
        })
        .unwrap();
    order.select_nth_unstable_by(mid, |a, b| {
        triangles[*a].center[axis]
            .total_cmp(&triangles[*b].center[axis])
            .then(a.cmp(b))
    });
    mid
}

// A node's box at each shutter end, padded one ULP outward. The shader blends the two at the ray's time: the blend of
// boxes bounding each end's vertices bounds the blend of the vertices (Woop, Afra and Benthin 2017, section 2).
fn pad(nodes: &mut [u32], at: usize, order: &[usize], triangles: &[Triangle], end: fn(&Triangle) -> ([f32; 3], [f32; 3])) {
    for a in 0..3 {
        let lo = order.iter().map(|i| end(&triangles[*i]).0[a]).fold(f32::INFINITY, f32::min);
        let hi = order.iter().map(|i| end(&triangles[*i]).1[a]).fold(f32::NEG_INFINITY, f32::max);
        nodes[at + a] = lo.next_down().to_bits();
        nodes[at + 4 + a] = hi.next_up().to_bits();
    }
}
fn branch(triangles: &[Triangle], order: &mut [usize], nodes: &mut Vec<u32>, open: &mut Vec<u32>, depth: usize) {
    let at = nodes.len();
    nodes.resize(at + 8, 0);
    open.resize(at + 8, 0);
    pad(nodes, at, order, triangles, |t| t.close);
    pad(open, at, order, triangles, |t| t.open);
    if order.len() == 1 {
        nodes[at + 7] = order[0] as u32 + 1;
    } else {
        let mid = partition(triangles, order, depth);
        let (left, right) = order.split_at_mut(mid);
        branch(triangles, left, nodes, open, depth + 1);
        branch(triangles, right, nodes, open, depth + 1);
    }
    nodes[at + 3] = (nodes.len() / 8) as u32;
}
fn build(input: &[u32]) -> Result<Vec<u32>, u32> {
    let (triangles, skipped) = parse(input)?;
    let mut nodes = Vec::new();
    let mut open = Vec::new();
    if !triangles.is_empty() {
        branch(
            &triangles,
            &mut (0..triangles.len()).collect::<Vec<_>>(),
            &mut nodes,
            &mut open,
            0,
        );
    }
    // Header: node count, triangle offset (relative to this header), retained, skipped.
    let mut result = vec![
        (nodes.len() / 8) as u32,
        (nodes.len() + 4) as u32,
        triangles.len() as u32,
        skipped,
    ];
    result.extend(nodes);
    let mut attribute_offset = result.len() + triangles.len() * 16;
    for t in &triangles {
        let mut words = t.words;
        words[7] = 0;
        if t.attributes.is_some() {
            words[7] = attribute_offset as u32;
            attribute_offset += 16;
        }
        result.extend(words);
    }
    for t in &triangles {
        if let Some(a) = t.attributes {
            result.extend(a);
        }
    }
    // A deforming mesh ends with its shutter-open node boxes (8 words a node) and triangle vertices (12 words a
    // triangle: xyz and a spare word per vertex), so the section starts nodes * 8 + retained * 12 words before the end.
    if triangles.iter().any(|t| t.previous.is_some()) {
        result.extend(open);
        for t in &triangles {
            let p = t.previous.unwrap_or(std::array::from_fn(|i| t.words[(i / 3) * 4 + i % 3]));
            for k in 0..3 {
                result.extend([p[k * 3], p[k * 3 + 1], p[k * 3 + 2], 0]);
            }
        }
    }
    Ok(result)
}

// Two-level instancing: transform bounds once, leave shared triangles untouched.
// Input records: object bounds (8), column-major affine matrix (16), metadata (4).
// Metadata flags: bit 0 is empty; bit 1 identifies branch()'s one-ULP BLAS padding; bit 2 marks a moving instance,
// whose bounds words already hold its world bounds over the whole motion interval (FG-17 motion blur).
// Output records: world/local row-major 3x4 (24), metadata (4), padding (4).
const MOVING_LIMIT: f64 = 1e8 * (1.0 + 1.0 / 32768.0);
fn build_instance_packet(input: &[u32]) -> Result<Vec<u32>, u32> {
    if input.len() % 28 != 0 || input.len() / 28 > 1_000_000 { return Err(1); }
    let mut bounds = Vec::new();
    let mut records = Vec::new();
    for record in input.chunks_exact(28) {
        let matrix: [f64; 16] = std::array::from_fn(|i| f32::from_bits(record[8 + i]) as f64);
        if matrix.iter().any(|v| !v.is_finite() || v.abs() > 1e8) ||
            matrix[3] != 0. || matrix[7] != 0. || matrix[11] != 0. || matrix[15] != 1. { return Err(1); }
        let world: [[f64; 4]; 3] = std::array::from_fn(|r| std::array::from_fn(|c| matrix[c * 4 + r]));
        let cross = |a: [f64; 4], b: [f64; 4]| [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        let cofactor = [cross(world[1], world[2]), cross(world[2], world[0]), cross(world[0], world[1])];
        let det = (0..3).map(|a| world[0][a] * cofactor[0][a]).sum::<f64>();
        if det == 0. || !det.is_finite() { return Err(1); }
        let mut local = [[0.; 4]; 3];
        for r in 0..3 {
            for c in 0..3 { local[r][c] = cofactor[c][r] / det; }
            local[r][3] = -(0..3).map(|c| local[r][c] * world[c][3]).sum::<f64>();
        }
        if local.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1e8) { return Err(1); }
        // Empty definitions have no TLAS leaf, but must still validate their placement.
        if record[27] & !7 != 0 { return Err(1); }
        if record[27] & 1 != 0 { continue; }
        if record[27] & 4 != 0 {
            let lo: [f32; 3] = std::array::from_fn(|a| f32::from_bits(record[a]));
            let hi: [f32; 3] = std::array::from_fn(|a| f32::from_bits(record[4 + a]));
            // The interval's endpoint geometry is within the public limit; its outward padding may pass it by 2^-15.
            if (0..3).any(|a| !(lo[a] <= hi[a]) || !(lo[a].abs() as f64 <= MOVING_LIMIT) || !(hi[a].abs() as f64 <= MOVING_LIMIT)) { return Err(1); }
            bounds.push(Triangle::leaf(lo.map(f32::next_down), hi.map(f32::next_up),
                std::array::from_fn(|a| (lo[a] as f64 + hi[a] as f64) * 0.5)));
            for rows in [world, local] { records.extend(rows.into_iter().flatten().map(|v| (v as f32).to_bits())); }
            records.extend_from_slice(&record[24..27]); records.push(0); records.extend([0;4]);
            continue;
        }
        let object_lo: [f64; 3] = std::array::from_fn(|a| f32::from_bits(record[a]) as f64);
        let object_hi: [f64; 3] = std::array::from_fn(|a| f32::from_bits(record[4+a]) as f64);
        if (0..3).any(|a| !object_lo[a].is_finite() || !object_hi[a].is_finite() || object_lo[a] > object_hi[a]) { return Err(1); }
        // The public coordinate limit applies to geometry, not the conservative
        // padding stored by branch(). Undo that exact, tagged padding only for
        // validation; traversal below still transforms the full outward box.
        let geometric_lo: [f64; 3] = std::array::from_fn(|a| if record[27] & 2 != 0 {
            f32::from_bits(record[a]).next_up() as f64
        } else { object_lo[a] });
        let geometric_hi: [f64; 3] = std::array::from_fn(|a| if record[27] & 2 != 0 {
            f32::from_bits(record[4+a]).next_down() as f64
        } else { object_hi[a] });
        if (0..3).any(|a| geometric_lo[a] > geometric_hi[a]) { return Err(1); }
        let mut lo = [f64::INFINITY; 3]; let mut hi = [f64::NEG_INFINITY; 3];
        for corner in 0..8 {
            let p: [f64; 3] = std::array::from_fn(|a| if corner & (1 << a) == 0 { object_lo[a] } else { object_hi[a] });
            let geometric: [f64; 3] = std::array::from_fn(|a| if corner & (1 << a) == 0 { geometric_lo[a] } else { geometric_hi[a] });
            for r in 0..3 {
                let actual = world[r][3] + (0..3).map(|c| world[r][c] * geometric[c]).sum::<f64>();
                if !actual.is_finite() || actual.abs() > 1e8 { return Err(1); }
                let v = world[r][3] + (0..3).map(|c| world[r][c] * p[c]).sum::<f64>();
                // Conservative gamma(7) arithmetic interval, then outward f32 rounding.
                let error = 4.172327e-7 * (world[r][3].abs() + (0..3).map(|c| (world[r][c] * p[c]).abs()).sum::<f64>());
                if !v.is_finite() { return Err(1); }
                lo[r] = lo[r].min(v-error); hi[r] = hi[r].max(v+error);
            }
        }
        bounds.push(Triangle::leaf(lo.map(|v| (v as f32).next_down()), hi.map(|v| (v as f32).next_up()),
            std::array::from_fn(|a| (lo[a]+hi[a])*0.5)));
        for rows in [world, local] { records.extend(rows.into_iter().flatten().map(|v| (v as f32).to_bits())); }
        records.extend_from_slice(&record[24..27]); records.push(0); records.extend([0;4]);
    }
    let mut nodes = Vec::new();
    if !bounds.is_empty() { branch(&bounds, &mut (0..bounds.len()).collect::<Vec<_>>(), &mut nodes, &mut Vec::new(), 0); }
    let mut result = vec![(nodes.len()/8) as u32, (nodes.len()+4) as u32, bounds.len() as u32, 0];
    result.extend(nodes); result.extend(records); Ok(result)
}

/// The input must be a live allocation of len words. Returns zero on success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn build_instances(ptr: *const u32, len: usize) -> u32 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    match build_instance_packet(input) {
        Ok(data) => { OUTPUT.with(|v| *v.borrow_mut() = data); 0 }
        Err(code) => { OUTPUT.with(|v| v.borrow_mut().clear()); code }
    }
}
/// The input must be a live u32 allocation of len words; status is zero on success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn build_mesh(ptr: *const u32, len: usize) -> u32 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    match build(input) {
        Ok(data) => {
            OUTPUT.with(|v| *v.borrow_mut() = data);
            0
        }
        Err(code) => {
            OUTPUT.with(|v| v.borrow_mut().clear());
            code
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u32 {
    OUTPUT.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> usize {
    OUTPUT.with(|v| v.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equality_checks_every_word_and_tail() {
        for len in 0..19 {
            let a: Vec<u32>=(0..len).map(|i|i as u32).collect();
            let mut both=a.clone();both.extend(&a);
            assert!(equal_words_slice(&both));
            for at in 0..len { both[len+at]^=0x80000000;assert!(!equal_words_slice(&both));both[len+at]^=0x80000000; }
        }
        assert!(!equal_words_slice(&[0]));
    }
    #[test]
    fn deforming_mesh_blends_boxes_that_hold_its_blended_vertices() {
        // A strip of 8 triangles over a 3 x 5 grid; every vertex moves differently over the shutter. The last triangle
        // has zero area at shutter close and a real one at open, so it is kept.
        let (columns, rows) = (5usize, 3usize);
        let close: Vec<f32> = (0..rows * columns)
            .flat_map(|i| [(i % columns) as f32, (i / columns) as f32, ((i * 7) % 3) as f32 * 0.25])
            .collect();
        let open: Vec<f32> = close
            .chunks(3)
            .enumerate()
            .flat_map(|(i, p)| [p[0] * 1.5 - 2.0, p[1] + (i % 4) as f32, p[2] - 3.0 + i as f32 * 0.125])
            .collect();
        let mut close = close;
        let mut indices = Vec::new();
        for r in 0..rows - 1 {
            for c in 0..columns - 1 {
                let i = (r * columns + c) as u32;
                indices.extend([i, i + 1, i + columns as u32]);
            }
        }
        // Collapse the last triangle at close only.
        let last = indices[indices.len() - 3..].to_vec();
        for k in 1..3 {
            for a in 0..3 {
                close[last[k] as usize * 3 + a] = close[last[0] as usize * 3 + a];
            }
        }
        let triangles = indices.len() / 3;
        let mut packet = vec![1, (rows * columns) as u32, indices.len() as u32, 1];
        packet.extend(close.iter().map(|v| v.to_bits()));
        packet.extend(&indices);
        packet.push(0x4d505256);
        packet.push(open.len() as u32);
        packet.extend(open.iter().map(|v| v.to_bits()));
        let data = build(&packet).unwrap();
        let (nodes, start) = (data[0] as usize, data[1] as usize);
        assert_eq!(data[2] as usize, triangles, "the triangle with area only at open is kept");
        let section = data.len() - nodes * 8 - triangles * 12;
        let f = |at: usize| f32::from_bits(data[at]);
        for k in 0..=16 {
            let t = k as f32 / 16.0;
            let blend = |a: f32, b: f32| a * (1.0 - t) + b * t;
            for node in 0..nodes {
                let (c, o) = (4 + node * 8, section + node * 8);
                // The triangles under a node are the leaves between it and its skip index.
                let end = data[c + 3] as usize;
                for inner in node..end {
                    let l = data[4 + inner * 8 + 7] as usize;
                    if l == 0 {
                        continue;
                    }
                    let (tri, prev) = (start + (l - 1) * 16, section + nodes * 8 + (l - 1) * 12);
                    for v in 0..3 {
                        for a in 0..3 {
                            let p = blend(f(prev + v * 4 + a), f(tri + v * 4 + a));
                            assert!(blend(f(o + a), f(c + a)) <= p && p <= blend(f(o + 4 + a), f(c + 4 + a)));
                        }
                    }
                }
            }
        }
        // Without the section the same mesh is packed exactly as before.
        let still = build(&packet[..packet.len() - open.len() - 2]).unwrap();
        assert_eq!(still[2] as usize, triangles - 1);
        assert_eq!(still.len(), 4 + still[0] as usize * 8 + (triangles - 1) * 16);
        // A count other than 0 or the position count, or a value past the limit, is refused.
        let mut bad = packet.clone();
        let n = bad.len() - open.len() - 1;
        bad[n] -= 3;
        assert_eq!(build(&bad[..bad.len() - 3]), Err(1));
        let mut far = packet.clone();
        let last = far.len() - 1;
        far[last] = 2e8f32.to_bits();
        assert_eq!(build(&far), Err(2));
    }
    #[test]
    fn moving_instance_keeps_its_interval_bounds_and_inverse() {
        let mut packet = vec![0u32;28];
        // World bounds over the interval, as motion.ts packs them, and the shutter-close matrix.
        for (a, (lo, hi)) in [(-1f32, 9f32), (0., 1.), (2., 3.)].into_iter().enumerate() {
            packet[a] = lo.to_bits(); packet[4 + a] = hi.to_bits();
        }
        let matrix: [f32;16] = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 8.,0.,2.,1.];
        packet[8..24].copy_from_slice(&matrix.map(f32::to_bits));
        packet[24..28].copy_from_slice(&[100,20,9,6]);
        let out=build_instance_packet(&packet).unwrap();
        for (a,(low,high)) in [(-1.,9.),(0.,1.),(2.,3.)].into_iter().enumerate() {
            assert!(f32::from_bits(out[4+a]) < low && f32::from_bits(out[4+a]) > low - 1e-5);
            assert!(f32::from_bits(out[8+a]) > high && f32::from_bits(out[8+a]) < high + 1e-5);
        }
        // The local rows are the inverse of the shutter-close transform; metadata follows; word 31 is left for TS.
        assert_eq!(f32::from_bits(out[12+12+3]), -8.0);
        assert_eq!(&out[12+24..12+32], &[100,20,9,0,0,0,0,0]);
        // Bounds out of order, not finite or past the padded limit are refused.
        for bad in [[5f32, 4.], [f32::NAN, 1.], [0., 1.0001e8]] {
            let mut p = packet.clone(); p[0] = bad[0].to_bits(); p[4] = bad[1].to_bits();
            assert!(build_instance_packet(&p).is_err());
        }
        let mut p = packet.clone(); p[27] = 8; assert!(build_instance_packet(&p).is_err());
    }
    #[test]
    fn instance_bounds_inverse_and_rejections() {
        let mut packet = vec![0u32;28];
        packet[4..7].copy_from_slice(&[1f32.to_bits();3]);
        let matrix: [f32;16] = [-2.,0.,0.,0., 1.,3.,0.,0., 0.,0.,4.,0., 5.,6.,7.,1.];
        packet[8..24].copy_from_slice(&matrix.map(f32::to_bits));
        packet[24..28].copy_from_slice(&[100,20,9,0]);
        let out=build_instance_packet(&packet).unwrap();
        assert_eq!(&out[..4], &[1,12,1,0]);
        for (a,(low,high)) in [(3.,6.),(6.,9.),(7.,11.)].into_iter().enumerate() {
            assert!(f32::from_bits(out[4+a]) < low);
            assert!(f32::from_bits(out[8+a]) > high);
        }
        assert_eq!(&out[36..40], &[100,20,9,0]);
        let world: Vec<f64> = out[12..24].iter().map(|v| f32::from_bits(*v) as f64).collect();
        let local: Vec<f64> = out[24..36].iter().map(|v| f32::from_bits(*v) as f64).collect();
        let p=[0.25,0.5,0.75];
        let q: [f64;3]=std::array::from_fn(|r| world[r*4+3]+(0..3).map(|c|world[r*4+c]*p[c]).sum::<f64>());
        for r in 0..3 {
            let restored=local[r*4+3]+(0..3).map(|c|local[r*4+c]*q[c]).sum::<f64>();
            assert!((restored-p[r]).abs()<1e-6);
        }
        for (at,value) in [(8,0.),(11,0.1),(23,0.),(8,f32::NAN),(8,1e-20),(20,1e8)] {
            let mut invalid=packet.clone(); invalid[at]=value.to_bits();
            assert_eq!(build_instance_packet(&invalid).err(),Some(1));
        }
        assert_eq!(build_instance_packet(&[]).unwrap(),vec![0,4,0,0]);
    }
    fn padded_limit_record() -> Vec<u32> {
        let mut packet=vec![0u32;28];
        packet[..3].fill((-1f32).next_down().to_bits());
        packet[4..7].fill(1f32.next_up().to_bits());
        let matrix:[f32;16]=[1e8,0.,0.,0.,0.,1e8,0.,0.,0.,0.,1e8,0.,0.,0.,0.,1.];
        packet[8..24].copy_from_slice(&matrix.map(f32::to_bits));
        packet[24..28].copy_from_slice(&[100,20,9,2]);packet
    }
    #[test]
    fn instance_geometry_limit_excludes_only_tagged_acceleration_padding() {
        let out=build_instance_packet(&padded_limit_record()).unwrap();
        assert_eq!(out[0],1);
        for a in 0..3 {
            assert!(f32::from_bits(out[4+a]) < -1e8);
            assert!(f32::from_bits(out[8+a]) > 1e8);
        }
        assert_eq!(out[39],0,"input padding provenance is not an output instance flag");
    }
    #[test]
    fn instance_limit_still_rejects_one_geometry_ulp_beyond_either_boundary() {
        for a in 0..3 {
            for negative in [false,true] {
                let mut packet=padded_limit_record();
                if negative {packet[a]=(-1f32).next_down().next_down().to_bits();}
                else {packet[4+a]=1f32.next_up().next_up().to_bits();}
                assert_eq!(build_instance_packet(&packet).err(),Some(1));
            }
        }
    }
    fn input() -> Vec<u32> {
        let mut v = vec![1, 3, 3, 1];
        v.extend([0., 0., 0., 1., 0., 0., 0., 1., 0.].map(f32::to_bits));
        v.extend([0, 1, 2]);
        v
    }
    #[test]
    fn packed_bounds_and_normal() {
        let v = build(&input()).unwrap();
        assert_eq!(&v[..4], &[1, 12, 1, 0]);
        assert!(f32::from_bits(v[4]) < 0.);
        assert!(f32::from_bits(v[8]) > 1.);
        assert_eq!(v[11], 1);
        assert_eq!(f32::from_bits(v[26]), 1.);
        assert_eq!(build(&[0]).unwrap(), vec![0, 4, 0, 0]);
    }
    #[test]
    fn hostile_data_is_rejected() {
        let mut a = input();
        a[4] = f32::NAN.to_bits();
        assert_eq!(build(&a).err(), Some(2));
        a = input();
        a[15] = 3;
        assert_eq!(build(&a).err(), Some(3));
        a = input();
        a[14] = 0;
        assert_eq!(build(&a).unwrap(), vec![0, 4, 0, 1]);
        assert_eq!(build(&[1]).err(), Some(1));
    }
    fn layers(offsets: &[f32]) -> Vec<u32> {
        let mut v = vec![1, (offsets.len() * 3) as u32, (offsets.len() * 3) as u32, 1];
        for &x in offsets {
            v.extend([x, 0., 0., x + 1., 0., 0., x, 1., 0.].map(f32::to_bits));
        }
        v.extend(0..(offsets.len() * 3) as u32);
        v
    }
    #[test]
    fn sah_separates_a_dense_cluster_from_an_outlier() {
        let data = build(&layers(&[0., 1., 2., 1000.])).unwrap();
        assert_eq!(data[0], 7);
        assert_eq!(
            data[15], 6,
            "the first subtree has three triangles, not the median's two"
        );
        let mut node = 0;
        let mut visits = 0;
        while node < data[0] as usize {
            visits += 1;
            let b = 4 + node * 8;
            if 500. < f32::from_bits(data[b]) || 500. > f32::from_bits(data[b + 4]) {
                node = data[b + 3] as usize;
            } else {
                node += 1;
            }
        }
        assert_eq!(
            visits, 3,
            "a gap ray tests root and two disjoint child boxes, versus five with median splitting"
        );
        assert_eq!(data, build(&layers(&[0., 1., 2., 1000.])).unwrap());
    }
    #[test]
    fn identical_centroids_and_depth_fallback_stay_balanced() {
        let (triangles, _) = parse(&layers(&vec![0.; 1024])).unwrap();
        let mut order = (0..1024).collect::<Vec<_>>();
        assert_eq!(partition(&triangles, &mut order, 0), 512);
        assert_eq!(partition(&triangles, &mut order, 32), 512);
        assert_eq!(build(&layers(&vec![0.; 1024])).unwrap()[0], 2047);
    }
    #[test]
    fn attributes_follow_retained_indices_and_reject_invalid_data() {
        let mut packet = input();
        packet.extend([0x4d415454, 9, 6]);
        packet
            .extend([0., 0., 2., 0., 2., 2., 2., 0., 2., 0., 0., 1., 0., 0., 1.].map(f32::to_bits));
        let data = build(&packet).unwrap();
        let a = data[12 + 7] as usize;
        assert_eq!(a, 28);
        assert_eq!(data[a + 15], 3);
        assert_eq!(f32::from_bits(data[a + 2]), 1.);
        assert_eq!(f32::from_bits(data[a + 11]), 1.);
        assert_eq!(f32::from_bits(data[a + 14]), 1.);
        packet[19] = f32::NAN.to_bits();
        assert_eq!(build(&packet).err(), Some(4));
        packet[19] = 0u32;
    }
    #[test]
    fn zero_area_is_exact_and_input_ordinals_survive_compaction() {
        let mut packet = input();
        packet[2] = 9;
        packet.truncate(13);
        packet.extend([0, 0, 1, 0, 1, 2, 1, 2, 2]);
        let data = build(&packet).unwrap();
        assert_eq!(&data[..4], &[1, 12, 1, 2]);
        assert_eq!(data[12 + 15], 1);
        for (x, y) in [(0, 1), (1, 2), (2, 0)] {
            let mut points = [[0.; 3]; 3];
            points[0][x] = 1e8;
            points[0][y] = 1e8;
            points[1][x] = -1e8;
            points[1][y] = -1e8;
            points[2][x] = 1e-40f32 as f64;
            assert!(oriented_area(&points, x, y) > 0.);
        }
    }
}

// The three corners at `corners` (4 words apart) through the world rows at `rows`, in float64.
fn world_corners(g:&[u32],rows:usize,corners:usize)->[[f64;3];3] {
    std::array::from_fn(|v|std::array::from_fn(|a| {
        let row=rows+a*4;
        (0..3).map(|b|f32::from_bits(g[row+b]) as f64*f32::from_bits(g[corners+v*4+b]) as f64).sum::<f64>()+f32::from_bits(g[row+3]) as f64
    }))
}
fn corner_area(points:&[[f64;3];3])->f32 {
    let edge=|v:usize|std::array::from_fn::<_,3,_>(|a|points[v][a]-points[0][a]);
    let a=edge(1);let b=edge(2);
    let cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    (cross.iter().map(|v|v*v).sum::<f64>().sqrt()*0.5) as f32
}
// World-area emitter table for the existing two-level packet. All offsets remain
// relative to the geometry root; per-placement lookup matches reordered BLAS faces.
fn light_packet(input: &[u32]) -> Result<Vec<u32>, u32> {
    if input.len() < 1025 { return Err(1); }
    let n=input[0] as usize;
    if n<16 || input.len()!=1025+n { return Err(1); }
    let emission=&input[1..1025];let g=&input[1025..];
    if g[1]!=0 || g[9]!=0x4d494e53 { return Err(1); }
    let mut out=g.to_vec();let header=out.len();out.extend([0;8]);out[12]=header as u32;
    let mut lights:Vec<[u32;24]>=Vec::new();let mut lookups=Vec::new();let mut total=0.0f64;
    for i in 0..g[4] as usize {
        let instance=g[5] as usize+i*32;
        // Moving (record word 31) and deforming (word 27, FG-17 piece 4b) instances get records at the close pose too:
        // the tracer moves a sampled point to the path's own time (FG-17-EMITTERS); the pick weight is the close area.
        let head=g[instance+24] as usize;let start=head+g[head+1] as usize;
        let count=g[head+2] as usize;let table=out.len();out.resize(table+count,0);out[instance+30]=table as u32;
        for j in 0..count {
            let tri=start+j*16;let material=g[tri+3] as usize;
            let r=g[instance+29] as usize;
            let (rgb,two_sided)=if r!=0 {
                (std::array::from_fn::<_,3,_>(|a|f32::from_bits(g[r+8+a]) as f64*f32::from_bits(g[r+11]) as f64),g[r+2]!=0)
            } else {
                if material>=256 { return Err(1); }
                (std::array::from_fn::<_,3,_>(|a|f32::from_bits(emission[material*4+a]) as f64),true)
            };
            let power=rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
            if power<=0.0 {continue;}
            let points=world_corners(g,instance,tri);
            let area=corner_area(&points);
            let mut weight=area;
            if area==0.0 {
                // A face that collapses at the close pose but not at the open one is picked by its open-pose area. Its
                // stored area and normal stay 0: the still sampler skips it, a path time where it has area samples it.
                let motion=g[instance+31] as usize;let section=g[instance+27] as usize;
                if motion==0&&section==0 {continue;}
                let corners=if section!=0 {head+section+g[head] as usize*8+j*12} else {tri};
                weight=corner_area(&world_corners(g,if motion!=0 {motion+4} else {instance},corners));
                if weight==0.0 {continue;}
            }
            let mut record=[0;24];for v in 0..3 {for a in 0..3 {record[v*4+a]=(points[v][a] as f32).to_bits();}}
            if area!=0.0 {
                let normal: [f64;3]=std::array::from_fn(|a|(0..3).map(|b|f32::from_bits(g[instance+12+b*4+a]) as f64*f32::from_bits(g[tri+12+b]) as f64).sum());
                let norm=normal.iter().map(|v|v*v).sum::<f64>().sqrt();
                for a in 0..3 {record[12+a]=((normal[a]/norm) as f32).to_bits();}
            }
            record[7]=area.to_bits();record[15]=u32::from(two_sided);record[16]=tri as u32;record[17]=head as u32;record[18]=instance as u32;record[19]=material as u32;
            total+=weight as f64*power;
            if !total.is_finite() {return Err(2);}
            lights.push(record);lookups.push((table+j,total));
        }
    }
    let records=out.len();let mut previous=0.0f32;
    let count=lights.len();
    for (i,(record,(lookup,sum))) in lights.iter_mut().zip(lookups).enumerate() {
        let cdf=if i+1==count {1.0} else {(sum/total) as f32};
        record[3]=cdf.to_bits();record[20]=(cdf-previous).to_bits();previous=cdf;
        out[lookup]=(records+i*24) as u32;
        out.extend(*record);
    }
    out[header]=count as u32;out[header+1]=records as u32;
    if out.len()>(128<<20)/4 {return Err(3);}
    Ok(out)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn build_lights(ptr:*const u32,len:usize)->u32 {
    match light_packet(unsafe {std::slice::from_raw_parts(ptr,len)}) {
        Ok(words)=>{OUTPUT.with(|out|*out.borrow_mut()=words);0},Err(code)=>code
    }
}
#[cfg(test)]
mod light_tests {
    use super::light_packet;
    type Tri = [[f32; 3]; 3];
    const IDENTITY: [f32; 12] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.];
    struct Placement { world: [f32; 12], model: [f32; 12], open: Option<[f32; 12]>, material: u32 }
    fn still(world: [f32; 12], model: [f32; 12], material: u32) -> Placement { Placement { world, model, open: None, material } }
    fn normal(t: &Tri) -> [f32; 3] {
        let e = |v: usize| std::array::from_fn::<f64, 3, _>(|a| t[v][a] as f64 - t[0][a] as f64);
        let (a, b) = (e(1), e(2));
        let c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let l = c.iter().map(|v| v * v).sum::<f64>().sqrt();
        if l == 0. { [0.; 3] } else { c.map(|v| (v / l) as f32) }
    }
    // One BLAS shared by every placement (one node, triangles retained in order), an optional shutter-open section
    // (record word 27) and an optional open-pose world block (record word 31) per placement, as the tracer packs them.
    fn packet(close: &[Tri], open: Option<&[Tri]>, placements: &[Placement], emission: &[(u32, [f32; 3])]) -> Vec<u32> {
        let records = 16; let blocks = records + placements.len() * 32;
        let head = blocks + placements.len() * 32;
        let nodes = 1; let triangles = 4 + nodes * 8; let section = triangles + close.len() * 16;
        let mut g = vec![0u32; head + section + nodes * 8 + close.len() * 12];
        g[0] = 1; g[4] = placements.len() as u32; g[5] = records as u32; g[9] = 0x4d494e53;
        g[head] = nodes as u32; g[head + 1] = triangles as u32; g[head + 2] = close.len() as u32;
        for (j, t) in close.iter().enumerate() {
            let at = head + triangles + j * 16;
            for v in 0..3 { for a in 0..3 { g[at + v * 4 + a] = t[v][a].to_bits(); } }
            g[at + 3] = placements.iter().map(|p| p.material).next().unwrap_or(0);
            let n = normal(t); for a in 0..3 { g[at + 12 + a] = n[a].to_bits(); }
        }
        if let Some(open) = open {
            for (j, t) in open.iter().enumerate() {
                let at = head + section + nodes * 8 + j * 12;
                for v in 0..3 { for a in 0..3 { g[at + v * 4 + a] = t[v][a].to_bits(); } }
            }
        }
        for (i, p) in placements.iter().enumerate() {
            let r = records + i * 32;
            for k in 0..12 { g[r + k] = p.world[k].to_bits(); g[r + 12 + k] = p.model[k].to_bits(); }
            g[r + 24] = head as u32;
            if open.is_some() { g[r + 27] = section as u32; }
            if let Some(rows) = p.open {
                let b = blocks + i * 32; g[r + 31] = b as u32;
                for k in 0..12 { g[b + 4 + k] = rows[k].to_bits(); }
            }
        }
        let mut input = vec![g.len() as u32]; input.extend(vec![0u32; 1024]);
        for &(m, rgb) in emission { for a in 0..3 { input[1 + m as usize * 4 + a] = rgb[a].to_bits(); } }
        input.extend(g); input
    }
    fn fl(v: &[u32], i: usize) -> f32 { f32::from_bits(v[i]) }
    fn lights(out: &[u32]) -> (usize, usize) { let h = out[12] as usize; (out[h] as usize, out[h + 1] as usize) }
    fn hash(v: &[u32]) -> u64 { v.iter().fold(0xcbf29ce484222325u64, |h, w| (h ^ *w as u64).wrapping_mul(0x100000001b3)) }
    const QUAD: [Tri; 2] = [[[0., 0., 0.], [1., 0., 0.], [1., 1., 0.]], [[0., 0., 0.], [1., 1., 0.], [0., 1., 0.]]];
    const SCALED: [f32; 12] = [2., 0., 0., 1., 0., 3., 0., -2., 0., 0., 1., 4.];
    const SCALED_MODEL: [f32; 12] = [0.5, 0., 0., -0.5, 0., 1. / 3., 0., 2. / 3., 0., 0., 1., -4.];
    #[test]
    fn still_packet_is_unchanged() {
        // Captured from main's kernel (be51f15878) before FG-17-EMITTERS: a scene with no mover packs as before.
        let input = packet(&QUAD, None, &[still(SCALED, SCALED_MODEL, 1), still(IDENTITY, IDENTITY, 2)], &[(1, [2., 1., 0.5]), (2, [0., 0., 0.])]);
        let out = light_packet(&input).unwrap();
        assert_eq!(lights(&out).0, 4);
        assert_eq!((out.len(), hash(&out)), (STILL_LEN, STILL_HASH));
    }
    const STILL_LEN: usize = 328; const STILL_HASH: u64 = 12604359644678197407;
    fn record_of(out: &[u32], placement: usize, j: usize) -> usize {
        let lookup = out[16 + placement * 32 + 30] as usize; assert_ne!(lookup, 0); out[lookup + j] as usize
    }
    #[test]
    fn movers_and_deformers_get_close_pose_records() {
        let open = [[[0., 0., 0.], [2., 0., 0.], [2., 2., 0.]], [[0., 0., 0.], [2., 2., 0.], [0., 2., 0.]]];
        let moved = [1., 0., 0., 5., 0., 1., 0., 0., 0., 0., 1., 0.];
        for (placement, section) in [(Placement { open: Some(moved), ..still(SCALED, SCALED_MODEL, 1) }, None), (still(SCALED, SCALED_MODEL, 1), Some(&open[..]))] {
            let deforming = section.is_some();
            let out = light_packet(&packet(&QUAD, section, &[placement], &[(1, [1., 1., 1.])])).unwrap();
            let (count, records) = lights(&out);
            assert_eq!(count, 2, "deforming {deforming}");
            let mut cdf = 0.;
            for j in 0..2 {
                let r = record_of(&out, 0, j);
                assert_eq!(r, records + j * 24);
                // Close-pose world corners, area (scale 2 x 3, half of a unit square) and the triangle's identity.
                assert_eq!([fl(&out, r), fl(&out, r + 1), fl(&out, r + 2)], [1., -2., 4.]);
                assert_eq!(fl(&out, r + 7), 3.);
                assert_eq!([fl(&out, r + 12), fl(&out, r + 13), fl(&out, r + 14)], [0., 0., 1.]);
                assert!(fl(&out, r + 20) > 0.);
                cdf += fl(&out, r + 20);
                assert_eq!(out[r + 18], 16);
            }
            assert_eq!(fl(&out, records + 24 + 3), 1.);
            assert!((cdf - 1.).abs() < 1e-6);
        }
    }
    #[test]
    fn a_face_degenerate_at_close_is_picked_by_its_open_area() {
        // Triangle 0 collapses to a line at close; it opens to area 2 (world, scale 2 x 3 on a 2/3 x 1/1 right triangle).
        let close: [Tri; 2] = [[[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]], QUAD[1]];
        let open: [Tri; 2] = [[[0., 0., 0.], [2. / 3., 0., 0.], [0., 2. / 3., 0.]], QUAD[1]];
        let out = light_packet(&packet(&close, Some(&open), &[still(SCALED, SCALED_MODEL, 1)], &[(1, [1., 1., 1.])])).unwrap();
        assert_eq!(lights(&out).0, 2);
        let r = record_of(&out, 0, 0);
        assert_eq!(fl(&out, r + 7), 0.);
        assert_eq!([out[r + 12], out[r + 13], out[r + 14]], [0, 0, 0]);
        // Weights: open area 4/3 for the collapsed face against close area 3 for the other.
        let pmf = fl(&out, r + 20);
        assert!((pmf - (4. / 3.) / (4. / 3. + 3.)).abs() < 1e-6, "{pmf}");
        // The same collapsed face on a still placement, or collapsed at both ends, is left out as before.
        let still_out = light_packet(&packet(&close, None, &[still(SCALED, SCALED_MODEL, 1)], &[(1, [1., 1., 1.])])).unwrap();
        assert_eq!(lights(&still_out).0, 1);
        let both = light_packet(&packet(&close, Some(&close), &[still(SCALED, SCALED_MODEL, 1)], &[(1, [1., 1., 1.])])).unwrap();
        assert_eq!(lights(&both).0, 1);
        // A moving placement whose open rows give the collapsed face area also falls back to them.
        let flat = [Placement { open: Some(SCALED), ..still([2., 0., 0., 1., 0., 0., 0., -2., 0., 0., 1., 4.], SCALED_MODEL, 1) }];
        let moved = light_packet(&packet(&QUAD, None, &flat, &[(1, [1., 1., 1.])])).unwrap();
        assert_eq!(lights(&moved).0, 2);
        assert_eq!(fl(&moved, record_of(&moved, 0, 0) + 7), 0.);
        assert!((fl(&moved, record_of(&moved, 0, 0) + 20) - 0.5).abs() < 1e-6);
    }
    #[test]
    fn a_moving_dark_placement_gets_a_zero_lookup_table() {
        let placements = [Placement { open: Some(SCALED), ..still(IDENTITY, IDENTITY, 2) }];
        let out = light_packet(&packet(&QUAD, None, &placements, &[(1, [1., 1., 1.])])).unwrap();
        assert_eq!(lights(&out).0, 0);
        let lookup = out[16 + 30] as usize;
        assert_ne!(lookup, 0);
        assert_eq!(&out[lookup..lookup + 2], &[0, 0]);
    }
}
