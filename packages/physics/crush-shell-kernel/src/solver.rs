use core::ptr::copy_nonoverlapping;

use crate::bending::{angle, bend};
use crate::material::{Plastic, Steel};
use crate::membrane::{Element, Vector, combine, cross, dot, membrane, sub};

#[derive(Clone, Copy)]
#[repr(C)]
struct Node {
    mass: f64,
    fixed: f64,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Face {
    vertices: [u32; 3],
    padding: u32,
    element: Element,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct FaceState {
    plastic: Plastic,
    stress: Vector,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Hinge {
    vertices: [u32; 4],
    rest_angle: f64,
    stiffness: f64,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct Ledger {
    kinetic: f64,
    membrane: f64,
    bend: f64,
    hardening: f64,
    plastic: f64,
    applied_work: f64,
}

#[repr(C)]
struct Shell {
    positions: *mut Vector,
    velocities: *mut Vector,
    face_state: *mut FaceState,
    applied: *const Vector,
    reactions: *mut Vector,
    nodes: *const Node,
    faces: *const Face,
    hinges: *mut Hinge,
    scratch: *mut f64,
    ledger: *mut Ledger,
    node_count: u32,
    face_count: u32,
    hinge_count: u32,
    padding: u32,
    gravity: Vector,
    steel: Steel,
}

struct Workspace {
    positions: *mut Vector,
    velocities: *mut Vector,
    face_state: *mut FaceState,
    forces: *mut Vector,
}

impl Shell {
    unsafe fn rest_angles(&self) -> bool {
        for i in 0..self.hinge_count as usize {
            let hinge = unsafe { &mut *self.hinges.add(i) };
            let Some(rest) = angle(unsafe { load(self.positions, hinge.vertices) }) else {
                return false;
            };
            if !rest.value.is_finite() {
                return false;
            }
            hinge.rest_angle = rest.value;
        }
        true
    }

    unsafe fn workspace(&self) -> Workspace {
        let positions = self.scratch.cast::<Vector>();
        // Layout in f64 words: three position, three velocity and three force words
        // per vertex, followed by 8 mutable words per face.
        let (velocities, forces, face_state) = unsafe {
            let velocities = positions.add(self.node_count as usize);
            let forces = velocities.add(self.node_count as usize);
            (
                velocities,
                forces,
                forces.add(self.node_count as usize).cast(),
            )
        };
        Workspace {
            positions,
            velocities,
            face_state,
            forces,
        }
    }
}

#[inline]
unsafe fn load<const N: usize>(data: *const Vector, indices: [u32; N]) -> [Vector; N] {
    // The host only packs valid vertex indices from checked topology.
    indices.map(|index| unsafe { *data.add(index as usize) })
}

#[inline]
unsafe fn add_forces<const N: usize>(data: *mut Vector, indices: [u32; N], forces: [Vector; N]) {
    for (index, addition) in indices.into_iter().zip(forces) {
        let row = unsafe { &mut *data.add(index as usize) };
        *row = combine(*row, 1.0, addition, 1.0);
    }
}

impl Workspace {
    unsafe fn forces(&mut self, shell: &Shell, budget: &mut Ledger) -> bool {
        budget.membrane = 0.0;
        budget.bend = 0.0;
        budget.hardening = 0.0;
        budget.plastic = 0.0;
        for i in 0..shell.node_count as usize {
            let node = unsafe { *shell.nodes.add(i) };
            let applied = unsafe { *shell.applied.add(i) };
            unsafe {
                self.forces
                    .add(i)
                    .write(combine(applied, 1.0, shell.gravity, node.mass))
            };
        }
        for i in 0..shell.face_count as usize {
            let face = unsafe { *shell.faces.add(i) };
            let state = unsafe { &mut *self.face_state.add(i) };
            let points = unsafe { load(self.positions, face.vertices) };
            let normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
            let area_squared = dot(normal, normal);
            if !(area_squared.is_finite() && area_squared > 0.0) {
                return false;
            }
            let result = membrane(face.element, points, shell.steel, state.plastic);
            state.plastic = result.result.state;
            state.stress = result.result.stress;
            budget.membrane += face.element.volume * result.result.elastic;
            budget.hardening += face.element.volume * result.result.hardened;
            budget.plastic += face.element.volume * result.result.state.dissipated;
            unsafe { add_forces(self.forces, face.vertices, result.forces) };
        }
        for i in 0..shell.hinge_count as usize {
            let hinge = unsafe { *shell.hinges.add(i) };
            let Some((energy, forces)) = bend(
                unsafe { load(self.positions, hinge.vertices) },
                hinge.rest_angle,
                hinge.stiffness,
            ) else {
                return false;
            };
            budget.bend += energy;
            unsafe { add_forces(self.forces, hinge.vertices, forces) };
        }
        (budget.membrane + budget.bend + budget.hardening + budget.plastic).is_finite()
    }

    unsafe fn kick(&mut self, shell: &Shell, seconds: f64, drift: bool) -> bool {
        for i in 0..shell.node_count as usize {
            let node = unsafe { *shell.nodes.add(i) };
            let force = unsafe { *self.forces.add(i) };
            if !dot(force, force).is_finite() {
                return false;
            }
            if node.fixed == 0.0 {
                let velocity = unsafe { &mut *self.velocities.add(i) };
                *velocity = combine(*velocity, 1.0, force, 0.5 * seconds / node.mass);
                if drift {
                    let position = unsafe { &mut *self.positions.add(i) };
                    *position = combine(*position, 1.0, *velocity, seconds);
                }
            }
        }
        true
    }
}

/// Runs one complete world interval on a private arena workspace before publishing it.
///
/// Safety: the bridge supplies aligned, disjoint regions and checks all input indices and sizes.
#[unsafe(no_mangle)]
unsafe extern "C" fn crush_shell_advance(
    descriptor: *const Shell,
    seconds: f64,
    count: u32,
) -> u32 {
    let shell = unsafe { &*descriptor };
    let (nodes, faces) = (shell.node_count as usize, shell.face_count as usize);
    let interval = if count == 0 {
        if !unsafe { shell.rest_angles() } {
            return 0;
        }
        0.0
    } else {
        seconds / count as f64
    };
    let mut work = unsafe { shell.workspace() };
    let mut budget = unsafe { *shell.ledger };
    unsafe {
        copy_nonoverlapping(shell.positions, work.positions, nodes);
        copy_nonoverlapping(shell.velocities, work.velocities, nodes);
        copy_nonoverlapping(shell.face_state, work.face_state, faces);
    }
    if !unsafe { work.forces(shell, &mut budget) } {
        return 0;
    }
    for _ in 0..count {
        if !unsafe {
            work.kick(shell, interval, true)
                && work.forces(shell, &mut budget)
                && work.kick(shell, interval, false)
        } {
            return 0;
        }
    }
    budget.kinetic = 0.0;
    for i in 0..nodes {
        let position = unsafe { *work.positions.add(i) };
        let velocity = unsafe { *work.velocities.add(i) };
        let node = unsafe { *shell.nodes.add(i) };
        let applied = unsafe { *shell.applied.add(i) };
        let original = unsafe { *shell.positions.add(i) };
        budget.kinetic += 0.5 * node.mass * dot(velocity, velocity);
        budget.applied_work += dot(applied, sub(position, original));
    }
    if !(budget.kinetic + budget.applied_work).is_finite() {
        return 0;
    }
    for i in 0..nodes {
        let node = unsafe { *shell.nodes.add(i) };
        let reaction = if node.fixed != 0.0 {
            unsafe { (*work.forces.add(i)).map(|component| 0.0 - component) }
        } else {
            [0.0; 3]
        };
        unsafe { shell.reactions.add(i).write(reaction) };
    }
    unsafe {
        copy_nonoverlapping(work.positions, shell.positions, nodes);
        copy_nonoverlapping(work.velocities, shell.velocities, nodes);
        copy_nonoverlapping(work.face_state, shell.face_state, faces);
        shell.ledger.write(budget);
    }
    1
}
