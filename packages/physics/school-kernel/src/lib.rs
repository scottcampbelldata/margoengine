// LIFE-04. The grid is the common deterministic neighbour kernel. The three zones follow
// Couzin et al. (2002), with optional nearest-k ranking and predictive predator avoidance.
#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::vec::Vec;
use margoengine_physics_kernel_common::neighbours::{NeighbourGrid, Storage};

#[cfg(target_arch = "wasm32")]
mod arena {
    use core::alloc::{GlobalAlloc, Layout};

    struct Arena;

    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn school_alloc(size: usize, align: usize) -> *mut u8;
    }

    unsafe impl GlobalAlloc for Arena {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { school_alloc(layout.size(), layout.align()) }
        }

        // The world leases the entire scratch region for one kernel call. The host rewinds it
        // afterward, so no Rust allocation survives a tick or becomes hidden solver state.
        unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
    }

    #[global_allocator]
    static ALLOC: Arena = Arena;

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}

type V3 = [f64; 3];

#[repr(C)]
struct Body {
    position: V3,
    velocity: V3,
}

struct Zones {
    repulsion: f64,
    orientation: f64,
    attraction: f64,
    vision_dot: f64,
    neighbours: usize,
    threat: f64,
    prediction: f64,
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scaled(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn plus(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[cfg(target_arch = "wasm32")]
fn length(a: V3) -> f64 {
    use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
    // f64 square root is a single, correctly rounded Wasm instruction.
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(dot(a, a))))
}

#[cfg(not(target_arch = "wasm32"))]
fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: V3) -> V3 {
    let n = length(a);
    if n > 0.0 {
        scaled(a, 1.0 / n)
    } else {
        [0.0; 3]
    }
}

fn nonzero(a: V3) -> bool {
    a[0] != 0.0 || a[1] != 0.0 || a[2] != 0.0
}

#[derive(Clone, Copy, PartialEq)]
struct Member {
    distance: f64,
    index: usize,
}

// Keep at most k closest members. The total ordering makes a tie a property of row ids,
// independent of cell traversal, insertion order and the sort implementation.
fn closer(a: Member, b: Member) -> bool {
    a.distance < b.distance || (a.distance == b.distance && a.index < b.index)
}

fn keep_nearest(list: &mut Vec<Member>, next: Member, count: usize) {
    if list.len() == count && !closer(next, list[count - 1]) {
        return;
    }
    let at = list.partition_point(|&entry| closer(entry, next));
    if list.len() == count {
        list.pop();
    }
    list.insert(at, next);
}

fn evade(body: &Body, predators: &[Body], zones: &Zones, row: usize) -> V3 {
    let mut nearest = zones.threat;
    let mut heading = [0.0; 3];
    for predator in predators {
        let delta = sub(body.position, predator.position);
        let relative = sub(body.velocity, predator.velocity);
        let speed_squared = dot(relative, relative);
        let time = if speed_squared > 0.0 {
            (-dot(delta, relative) / speed_squared)
                .max(0.0)
                .min(zones.prediction)
        } else {
            0.0
        };
        let closest = plus(delta, scaled(relative, time));
        let distance = length(closest);
        if distance < nearest {
            nearest = distance;
            heading = if distance > 0.0 {
                scaled(closest, 1.0 / distance)
            } else {
                // A head-on intersection has no outward normal. Use a deterministic
                // perpendicular (or a row axis for an exactly coincident stationary pair).
                let side = if relative[0].abs() > relative[1].abs() {
                    [-relative[2], 0.0, relative[0]]
                } else {
                    [0.0, relative[2], -relative[1]]
                };
                if nonzero(side) {
                    unit(side)
                } else {
                    let mut axis = [0.0; 3];
                    axis[row % 3] = 1.0;
                    axis
                }
            };
        }
    }
    heading
}

fn direction(
    bodies: &[Body],
    predators: &[Body],
    zones: &Zones,
    grid: &NeighbourGrid,
    query: [f32; 3],
    row: usize,
    closest: &mut Vec<Member>,
) -> V3 {
    let body = &bodies[row];
    let forward = unit(body.velocity);
    let mut repulsion = [0.0; 3];
    let mut repelling = false;
    closest.clear();
    grid.candidates(query, 1, |index| {
        let id = index as usize;
        if id == row {
            return;
        }
        let displacement = sub(bodies[id].position, body.position);
        let distance = length(displacement);
        if distance < zones.repulsion {
            repelling = true;
            if distance > 0.0 {
                repulsion = plus(repulsion, scaled(displacement, -1.0 / distance));
            } else {
                let axis = (row.min(id) ^ row.max(id)) % 3;
                repulsion[axis] += if row < id { -1.0 } else { 1.0 };
            }
        } else if distance > 0.0
            && distance <= zones.attraction
            && (zones.vision_dot == -1.0
                || !nonzero(forward)
                || dot(forward, displacement) >= zones.vision_dot * distance)
        {
            keep_nearest(
                closest,
                Member {
                    distance,
                    index: id,
                },
                zones.neighbours,
            );
        }
    });
    if repelling {
        return if nonzero(repulsion) {
            unit(repulsion)
        } else {
            forward
        };
    }
    let escape = evade(body, predators, zones, row);
    if nonzero(escape) {
        return escape;
    }
    let mut align = [0.0; 3];
    let mut attract = [0.0; 3];
    for member in closest {
        let neighbour = &bodies[member.index];
        if member.distance <= zones.orientation {
            align = plus(align, unit(neighbour.velocity));
        } else {
            let delta = sub(neighbour.position, body.position);
            attract = plus(attract, scaled(delta, 1.0 / member.distance));
        }
    }
    let social = plus(unit(align), unit(attract));
    if nonzero(social) {
        unit(social)
    } else {
        forward
    }
}

/// The host supplies non-overlapping, aligned regions using the checked TypeScript layout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn school_intent(
    bodies: *const f64,
    count: usize,
    predators: *const f64,
    predator_count: usize,
    output: *mut f64,
    repulsion: f64,
    orientation: f64,
    attraction: f64,
    vision_dot: f64,
    neighbours: usize,
    threat: f64,
    prediction: f64,
) -> u32 {
    let bodies = unsafe { core::slice::from_raw_parts(bodies.cast::<Body>(), count) };
    let predators =
        unsafe { core::slice::from_raw_parts(predators.cast::<Body>(), predator_count) };
    let output = unsafe { core::slice::from_raw_parts_mut(output.cast::<V3>(), count) };
    let zones = Zones {
        repulsion,
        orientation,
        attraction,
        vision_dot,
        neighbours,
        threat,
        prediction,
    };
    let origin = bodies[0].position;
    let mut span: f32 = 0.0;
    let points: Vec<[f32; 3]> = bodies
        .iter()
        .map(|body| {
            let local = sub(body.position, origin).map(|x| x as f32);
            span = span
                .max(local[0].abs())
                .max(local[1].abs())
                .max(local[2].abs());
            local
        })
        .collect();
    // Largest possible displacement within the physical sensing radius spans at most one
    // bin despite float rounding. The final distance and ranking always use the f64 rows.
    let cell = ((2.0 * attraction) as f32).max(8.0 * f32::EPSILON * span);
    let mut grid = NeighbourGrid::default();
    if grid.build_with(&points, cell, Storage::Sparse).is_err() {
        return 1;
    }
    let mut closest = Vec::with_capacity(neighbours.min(count - 1));
    for (row, intent) in output.iter_mut().enumerate() {
        *intent = direction(
            bodies,
            predators,
            &zones,
            &grid,
            points[row],
            row,
            &mut closest,
        );
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_keeps_the_correct_metric_candidates_at_large_offsets() {
        let bodies = [
            Body {
                position: [1.0e10, 0.0, 0.0],
                velocity: [1.0, 0.0, 0.0],
            },
            Body {
                position: [1.0e10 + 0.5, 0.0, 0.0],
                velocity: [0.0, 0.0, 1.0],
            },
            Body {
                position: [1.0e10 + 1.0e7, 0.0, 0.0],
                velocity: [0.0, 1.0, 0.0],
            },
        ];
        let mut out = [[0.0; 3]; 3];
        let status = unsafe {
            school_intent(
                bodies.as_ptr().cast(),
                bodies.len(),
                bodies.as_ptr().cast(),
                0,
                out.as_mut_ptr().cast(),
                0.2,
                1.0,
                2.0,
                -1.0,
                1,
                0.0,
                0.0,
            )
        };
        assert_eq!(status, 0);
        assert_eq!(out[0], [0.0, 0.0, 1.0]);
        assert_eq!(out[1], [1.0, 0.0, 0.0]);
        assert_eq!(out[2], [0.0, 1.0, 0.0]);
    }
}
