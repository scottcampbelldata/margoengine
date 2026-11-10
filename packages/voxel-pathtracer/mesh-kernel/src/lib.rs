// Clean room: binned surface-area BVH and conservative float bounds. The
// triangle predicate runs on the GPU; no engine, parser or foreign kernel code.
use std::cell::RefCell;

#[derive(Clone)]
struct Triangle {
    words: [u32; 16],
    attributes: Option<[u32; 16]>,
    indices: [usize; 3],
    lo: [f32; 3],
    hi: [f32; 3],
    center: [f64; 3],
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
            let mut words = [0u32; 16];
            let mut points = [[0.0f64; 3]; 3];
            for k in 0..3 {
                for axis in 0..3 {
                    let v = positions[ids[k] as usize * 3 + axis];
                    words[k * 4 + axis] = v;
                    points[k][axis] = f32::from_bits(v) as f64;
                }
            }
            words[3] = material;
            words[7] = face as u32;
            words[11] = mesh;
            words[15] = ordinal;
            ordinal += 1;
            let normal = [
                oriented_area(&points, 1, 2),
                oriented_area(&points, 2, 0),
                oriented_area(&points, 0, 1),
            ];
            let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
            if length == 0.0 {
                skipped += 1;
                continue;
            }
            for i in 0..3 {
                words[12 + i] = ((normal[i] / length) as f32).to_bits();
            }
            triangles.push(Triangle {
                words,
                attributes: None,
                indices: [ids[0] as usize, ids[1] as usize, ids[2] as usize],
                lo: std::array::from_fn(|i| {
                    points
                        .iter()
                        .map(|p| p[i] as f32)
                        .fold(f32::INFINITY, f32::min)
                }),
                hi: std::array::from_fn(|i| {
                    points
                        .iter()
                        .map(|p| p[i] as f32)
                        .fold(f32::NEG_INFINITY, f32::max)
                }),
                center: std::array::from_fn(|i| (points[0][i] + points[1][i] + points[2][i]) / 3.0),
            });
        }
        at = last;
    }
    if at < input.len() {
        if input[at] != 0x4d415454 {
            return Err(1);
        }
        at += 1;
        let mut attributes = Vec::new();
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
        for t in &mut triangles {
            let (normals, uvs) = attributes[t.words[11] as usize];
            if normals.is_empty() && uvs.is_empty() {
                continue;
            }
            let mut a = [0u32; 16];
            if !normals.is_empty() {
                a[15] |= 1;
                for k in 0..3 {
                    let n = std::array::from_fn::<_, 3, _>(|i| {
                        f32::from_bits(normals[t.indices[k] * 3 + i]) as f64
                    });
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
    }
    if at != input.len() {
        return Err(1);
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

fn branch(triangles: &[Triangle], order: &mut [usize], nodes: &mut Vec<u32>, depth: usize) {
    let at = nodes.len();
    nodes.resize(at + 8, 0);
    let lo = std::array::from_fn::<_, 3, _>(|a| {
        order
            .iter()
            .map(|i| triangles[*i].lo[a])
            .fold(f32::INFINITY, f32::min)
    });
    let hi = std::array::from_fn::<_, 3, _>(|a| {
        order
            .iter()
            .map(|i| triangles[*i].hi[a])
            .fold(f32::NEG_INFINITY, f32::max)
    });
    for a in 0..3 {
        nodes[at + a] = lo[a].next_down().to_bits();
        nodes[at + 4 + a] = hi[a].next_up().to_bits();
    }
    if order.len() == 1 {
        nodes[at + 7] = order[0] as u32 + 1;
    } else {
        let mid = partition(triangles, order, depth);
        let (left, right) = order.split_at_mut(mid);
        branch(triangles, left, nodes, depth + 1);
        branch(triangles, right, nodes, depth + 1);
    }
    nodes[at + 3] = (nodes.len() / 8) as u32;
}
fn build(input: &[u32]) -> Result<Vec<u32>, u32> {
    let (triangles, skipped) = parse(input)?;
    let mut nodes = Vec::new();
    if !triangles.is_empty() {
        branch(
            &triangles,
            &mut (0..triangles.len()).collect::<Vec<_>>(),
            &mut nodes,
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
    Ok(result)
}

// Two-level instancing: transform bounds once, leave shared triangles untouched.
// Input records: object bounds (8), column-major affine matrix (16), metadata (4).
// Output records: world/local row-major 3x4 (24), metadata (4), padding (4).
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
        if record[27] != 0 { continue; }
        let object_lo: [f64; 3] = std::array::from_fn(|a| f32::from_bits(record[a]) as f64);
        let object_hi: [f64; 3] = std::array::from_fn(|a| f32::from_bits(record[4+a]) as f64);
        if (0..3).any(|a| !object_lo[a].is_finite() || !object_hi[a].is_finite() || object_lo[a] > object_hi[a]) { return Err(1); }
        let mut lo = [f64::INFINITY; 3]; let mut hi = [f64::NEG_INFINITY; 3];
        for corner in 0..8 {
            let p: [f64; 3] = std::array::from_fn(|a| if corner & (1 << a) == 0 { object_lo[a] } else { object_hi[a] });
            for r in 0..3 {
                let v = world[r][3] + (0..3).map(|c| world[r][c] * p[c]).sum::<f64>();
                // Conservative gamma(7) arithmetic interval, then outward f32 rounding.
                let error = 4.172327e-7 * (world[r][3].abs() + (0..3).map(|c| (world[r][c] * p[c]).abs()).sum::<f64>());
                if !v.is_finite() || v.abs() > 1e8 { return Err(1); }
                lo[r] = lo[r].min(v-error); hi[r] = hi[r].max(v+error);
            }
        }
        bounds.push(Triangle {
            words: [0;16], attributes: None, indices: [0;3],
            lo: lo.map(|v| (v as f32).next_down()), hi: hi.map(|v| (v as f32).next_up()),
            center: std::array::from_fn(|a| (lo[a]+hi[a])*0.5),
        });
        for rows in [world, local] { records.extend(rows.into_iter().flatten().map(|v| (v as f32).to_bits())); }
        records.extend_from_slice(&record[24..28]); records.extend([0;4]);
    }
    let mut nodes = Vec::new();
    if !bounds.is_empty() { branch(&bounds, &mut (0..bounds.len()).collect::<Vec<_>>(), &mut nodes, 0); }
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
