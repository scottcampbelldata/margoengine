// Clean room: Shaker et al., PCG book chapter 3, partition rooms and sibling links.
#[derive(Clone, Copy)]
struct Rect {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}
struct Node {
    rect: Rect,
    children: Option<(usize, usize)>,
}
fn random(state: &mut u32, range: usize) -> usize {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    (*state as usize) % range
}
fn centre(r: Rect) -> (usize, usize) {
    (r.x + r.w / 2, r.y + r.h / 2)
}
fn line(grid: &mut [u32], width: usize, a: (usize, usize), b: (usize, usize)) -> u32 {
    let mut visits = 0;
    for y in a.1.min(b.1)..=a.1.max(b.1) {
        for x in a.0.min(b.0)..=a.0.max(b.0) {
            grid[y * width + x] = 1;
            visits += 1;
        }
    }
    visits
}
fn run(width: usize, height: usize, seed: u32, minimum: usize, maximum: usize) -> Vec<u32> {
    if !(6..=1024).contains(&width)
        || !(6..=1024).contains(&height)
        || !(2..=64).contains(&minimum)
        || !(1..=256).contains(&maximum)
        || width < minimum + 4
        || height < minimum + 4
    {
        return vec![4, 0, 0, 0];
    }
    let leaf_min = minimum + 2;
    let mut state = seed.max(1);
    let mut nodes = vec![Node {
        rect: Rect {
            x: 1,
            y: 1,
            w: width - 2,
            h: height - 2,
        },
        children: None,
    }];
    let mut split_checks = 0;
    for _ in 1..maximum {
        let mut chosen = None;
        let mut area = 0;
        for (i, node) in nodes.iter().enumerate() {
            if node.children.is_some() {
                continue;
            }
            split_checks += 1;
            let r = node.rect;
            if (r.w >= 2 * leaf_min || r.h >= 2 * leaf_min) && r.w * r.h > area {
                chosen = Some(i);
                area = r.w * r.h;
            }
        }
        let Some(i) = chosen else {
            break;
        };
        let r = nodes[i].rect;
        let vertical = r.h < 2 * leaf_min
            || (r.w >= 2 * leaf_min && (r.w > r.h || (r.w == r.h && random(&mut state, 2) == 0)));
        let span = if vertical { r.w } else { r.h };
        let cut = leaf_min + random(&mut state, span - 2 * leaf_min + 1);
        let (a, b) = if vertical {
            (
                Rect { w: cut, ..r },
                Rect {
                    x: r.x + cut,
                    w: r.w - cut,
                    ..r
                },
            )
        } else {
            (
                Rect { h: cut, ..r },
                Rect {
                    y: r.y + cut,
                    h: r.h - cut,
                    ..r
                },
            )
        };
        let left = nodes.len();
        nodes.push(Node {
            rect: a,
            children: None,
        });
        let right = nodes.len();
        nodes.push(Node {
            rect: b,
            children: None,
        });
        nodes[i].children = Some((left, right));
    }
    let mut rooms = Vec::new();
    let mut representative = vec![0; nodes.len()];
    for (i, node) in nodes.iter().enumerate() {
        if node.children.is_some() {
            continue;
        }
        let r = node.rect;
        let w = minimum + random(&mut state, r.w - minimum - 1);
        let h = minimum + random(&mut state, r.h - minimum - 1);
        let x = r.x + 1 + random(&mut state, r.w - w - 1);
        let y = r.y + 1 + random(&mut state, r.h - h - 1);
        representative[i] = rooms.len();
        rooms.push(Rect { x, y, w, h });
    }
    let mut corridors = Vec::new();
    for i in (0..nodes.len()).rev() {
        if let Some((a, b)) = nodes[i].children {
            let from = representative[a];
            let to = representative[b];
            let p = centre(rooms[from]);
            let q = centre(rooms[to]);
            let bend = if random(&mut state, 2) == 0 {
                (p.0, q.1)
            } else {
                (q.0, p.1)
            };
            corridors.push((from, to, bend));
            representative[i] = from;
        }
    }
    let mut grid = vec![0; width * height];
    let mut visits = 0;
    for r in &rooms {
        for y in r.y..r.y + r.h {
            grid[y * width + r.x..y * width + r.x + r.w].fill(1);
            visits += r.w as u32;
        }
    }
    for &(a, b, bend) in &corridors {
        visits += line(&mut grid, width, centre(rooms[a]), bend);
        visits += line(&mut grid, width, bend, centre(rooms[b]));
    }
    let length = 4 + 4 * rooms.len() + 4 * corridors.len() + grid.len();
    let mut result = vec![length as u32, rooms.len() as u32, split_checks, visits];
    for r in rooms {
        result.extend([r.x as u32, r.y as u32, r.w as u32, r.h as u32]);
    }
    for (a, b, (x, y)) in corridors {
        result.extend([a as u32, b as u32, x as u32, y as u32]);
    }
    result.extend(grid);
    result
}
#[unsafe(no_mangle)]
pub extern "C" fn generate(
    width: usize,
    height: usize,
    seed: u32,
    minimum: usize,
    maximum: usize,
) -> *mut u32 {
    Box::into_raw(run(width, height, seed, minimum, maximum).into_boxed_slice()) as *mut u32
}
/// Release exactly one returned allocation with its header's length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(pointer: *mut u32, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_requests_are_bounded() {
        for args in [
            (0, 48, 4, 32),
            (1025, 48, 4, 32),
            (6, 6, 64, 32),
            (64, 48, 4, 0),
        ] {
            assert_eq!(run(args.0, args.1, 1, args.2, args.3), vec![4, 0, 0, 0]);
        }
    }
    #[test]
    fn seeded_partition_output_and_outer_walls() {
        for seed in 0..64 {
            let a = run(64, 48, seed, 4, 32);
            assert_eq!(a, run(64, 48, seed, 4, 32));
            assert_eq!(a[0] as usize, a.len());
            assert!(a[1] > 1 && a[1] <= 32);
            let grid = &a[4 + a[1] as usize * 4 + (a[1] as usize - 1) * 4..];
            for x in 0..64 {
                assert_eq!(grid[x], 0);
                assert_eq!(grid[47 * 64 + x], 0);
            }
            for y in 0..48 {
                assert_eq!(grid[y * 64], 0);
                assert_eq!(grid[y * 64 + 63], 0);
            }
        }
    }
}
