// Clean room: binary spatial median BVH and conservative float bounds. The
// triangle predicate runs on the GPU; no engine, parser or foreign kernel code.
use std::cell::RefCell;

#[derive(Clone)]
struct Triangle {
    words: [u32; 16],
    lo: [f32; 3],
    hi: [f32; 3],
    center: [f64; 3],
}
thread_local! {
    static OUTPUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
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

fn parse(input: &[u32]) -> Result<Vec<Triangle>, u32> {
    let Some(&meshes) = input.first() else {
        return Err(1);
    };
    let mut at = 1usize;
    let mut triangles = Vec::new();
    for mesh in 0..meshes {
        if at + 3 > input.len() {
            return Err(1);
        }
        let vertices = input[at] as usize;
        let count = input[at + 1] as usize;
        let material = input[at + 2];
        at += 3;
        if material == 0
            || material > 255
            || count % 3 != 0
            || count / 3 + triangles.len() > 1_000_000
        {
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
            let a = std::array::from_fn::<_, 3, _>(|i| points[1][i] - points[0][i]);
            let b = std::array::from_fn::<_, 3, _>(|i| points[2][i] - points[0][i]);
            let normal = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
            if length == 0.0 {
                return Err(4);
            }
            for i in 0..3 {
                words[12 + i] = ((normal[i] / length) as f32).to_bits();
            }
            triangles.push(Triangle {
                words,
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
    if at != input.len() {
        return Err(1);
    }
    Ok(triangles)
}

fn branch(triangles: &[Triangle], order: &mut [usize], nodes: &mut Vec<u32>) {
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
        let axis = (0..3)
            .max_by(|a, b| (hi[*a] - lo[*a]).total_cmp(&(hi[*b] - lo[*b])))
            .unwrap();
        let mid = order.len() / 2;
        order.select_nth_unstable_by(mid, |a, b| {
            triangles[*a].center[axis]
                .total_cmp(&triangles[*b].center[axis])
                .then(a.cmp(b))
        });
        let (left, right) = order.split_at_mut(mid);
        branch(triangles, left, nodes);
        branch(triangles, right, nodes);
    }
    nodes[at + 3] = (nodes.len() / 8) as u32;
}
fn build(input: &[u32]) -> Result<Vec<u32>, u32> {
    let triangles = parse(input)?;
    let mut nodes = Vec::new();
    if !triangles.is_empty() {
        branch(
            &triangles,
            &mut (0..triangles.len()).collect::<Vec<_>>(),
            &mut nodes,
        );
    }
    // Header: node count, triangle offset (relative to this header), triangles, reserved.
    let mut result = vec![
        (nodes.len() / 8) as u32,
        (nodes.len() + 4) as u32,
        triangles.len() as u32,
        0,
    ];
    result.extend(nodes);
    for t in triangles {
        result.extend(t.words);
    }
    Ok(result)
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
        assert_eq!(build(&a).err(), Some(4));
        assert_eq!(build(&[1]).err(), Some(1));
    }
}
