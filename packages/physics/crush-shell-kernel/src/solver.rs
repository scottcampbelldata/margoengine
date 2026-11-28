use core::ptr::copy_nonoverlapping;

use crate::bending::{angle, bend};
use crate::cohesive::{CohesiveEdge, History, seam};
use crate::contact::{
    Closest, Contact, closest, contact, friction_impulse, inertia_product, within_bounds,
};
use crate::material::{Hill, Plastic, Steel};
use crate::math::sqrt;
use crate::membrane::{Element, Membrane, Vector, combine, cross, dot, membrane, sub};
use crate::pressure::{PanelPressure, pressure_forces};

#[cfg(target_arch = "wasm32")]
mod parallel;
#[cfg(target_arch = "wasm32")]
use parallel::FaceJob;

#[cfg(not(target_arch = "wasm32"))]
type FaceJob = core::ffi::c_void;

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
struct Sphere {
    center: Vector,
    velocity: Vector,
    inverse_mass: f64,
    radius: f64,
    stiffness: f64,
    force: Vector,
    impulse: Vector,
    energy: f64,
    clearance: f64,
    first_moment: Vector,
}

impl Sphere {
    fn kick(&mut self, gravity: Vector, seconds: f64, remaining: f64, drift: bool) {
        let half_step = seconds * 0.5;
        self.impulse = combine(self.impulse, 1.0, self.force, half_step);
        self.first_moment = combine(self.first_moment, 1.0, self.force, half_step * remaining);
        if self.inverse_mass > 0.0 {
            self.velocity = combine(
                self.velocity,
                1.0,
                combine(gravity, 1.0, self.force, self.inverse_mass),
                half_step,
            );
        }
        if drift {
            self.center = combine(self.center, 1.0, self.velocity, seconds);
        }
    }
}

#[repr(C)]
struct SphereFriction {
    coefficient: f64,
    angular_velocity: Vector,
    inverse_inertia: [f64; 6],
    angular_impulse: Vector,
    angular_first_moment: Vector,
    loss: f64,
    vertices: [u32; 3],
    padding: u32,
    weights: Vector,
    arm: Vector,
    reserved: Vector,
}

const _: [(); 28 * 8] = [(); core::mem::size_of::<SphereFriction>()];

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
    pressure: *const PanelPressure,
    gravity: Vector,
    steel: Steel,
    spheres: *mut Sphere,
    sphere_count: u32,
    seams: *const CohesiveEdge,
    seam_history: *mut History,
    seam_count: u32,
    hill: Hill,
    friction: *mut SphereFriction,
    contact_topology: *const u32,
}

struct Workspace {
    positions: *mut Vector,
    velocities: *mut Vector,
    face_state: *mut FaceState,
    seam_history: *mut History,
    forces: *mut Vector,
    face_job: *mut FaceJob,
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

    unsafe fn workspace(&self, face_job: *mut FaceJob) -> Workspace {
        let positions = self.scratch.cast::<Vector>();
        // Layout in f64 words: three position, three velocity and three force words
        // per vertex, followed by 8 mutable words per face.
        let (velocities, forces, face_state) = unsafe {
            let velocities = positions.add(self.node_count as usize);
            let forces = velocities.add(self.node_count as usize);
            (
                velocities,
                forces,
                forces.add(self.node_count as usize).cast::<FaceState>(),
            )
        };
        let seam_history = unsafe { face_state.add(self.face_count as usize).cast() };
        Workspace {
            positions,
            velocities,
            face_state,
            seam_history,
            forces,
            face_job,
        }
    }
}

#[inline]
unsafe fn load<T: Copy, const N: usize>(data: *const T, indices: [u32; N]) -> [T; N] {
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

fn face_is_valid(points: [Vector; 3]) -> bool {
    let normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    let area_squared = dot(normal, normal);
    area_squared.is_finite() && area_squared > 0.0
}

unsafe fn panel_load(shell: &Shell, i: usize, points: [Vector; 3]) -> Option<[Vector; 3]> {
    if shell.pressure.is_null() {
        return None;
    }
    let pressure = unsafe { *shell.pressure.add(i) };
    if pressure.air == 0.0 && (pressure.water_weight == 0.0 || pressure.inside == pressure.outside)
    {
        return None;
    }
    Some(pressure_forces(pressure, points))
}

fn update_face(state: &mut FaceState, result: &Membrane) -> bool {
    let returned = result.result.state.equivalent > state.plastic.equivalent;
    state.plastic = result.result.state;
    state.stress = result.result.stress;
    returned
}

impl Workspace {
    unsafe fn face_forces(&self, shell: &Shell, budget: &mut Ledger, hill: Option<Hill>) -> bool {
        #[cfg(all(target_arch = "wasm32", feature = "threaded"))]
        if !self.face_job.is_null() && unsafe { (*self.face_job).parts } > 1 {
            return unsafe { self.parallel_faces(shell, budget) };
        }
        #[cfg(not(target_arch = "wasm32"))]
        let _ = self.face_job;
        let mut returned = 0;
        let mut loaded = 0;
        for i in 0..shell.face_count as usize {
            let face = unsafe { *shell.faces.add(i) };
            let state = unsafe { &mut *self.face_state.add(i) };
            let points = unsafe { load(self.positions, face.vertices) };
            if !face_is_valid(points) {
                return false;
            }
            let result = membrane(face.element, points, shell.steel, state.plastic, hill);
            returned += u32::from(update_face(state, &result));
            budget.membrane += face.element.volume * result.result.elastic;
            budget.hardening += face.element.volume * result.result.hardened;
            budget.plastic += face.element.volume * result.result.state.dissipated;
            unsafe { add_forces(self.forces, face.vertices, result.forces) };
            if let Some(forces) = unsafe { panel_load(shell, i, points) } {
                loaded += 1;
                unsafe { add_forces(self.forces, face.vertices, forces) };
            }
        }
        #[cfg(target_arch = "wasm32")]
        if let Some(job) = unsafe { self.face_job.as_ref() } {
            let receipt = unsafe { &mut *job.work };
            receipt.force_evaluations += 1.0;
            receipt.faces += f64::from(shell.face_count);
            receipt.plastic_returns += f64::from(returned);
            receipt.pressure_faces += f64::from(loaded);
        }
        true
    }

    /// Visit the closest point on each shell feature that is also a local minimum on the live sheet.
    unsafe fn visit_manifold(
        &self,
        shell: &Shell,
        center: Vector,
        radius: f64,
        stiffness: f64,
        mut visit: impl FnMut([u32; 3], Closest, Contact) -> bool,
    ) -> bool {
        for face_index in 0..shell.face_count as usize {
            let face = unsafe { *shell.faces.add(face_index) };
            let vertices = unsafe { load(self.positions, face.vertices) };
            if !within_bounds(center, radius, vertices) {
                continue;
            }
            let candidate = closest(center, vertices);
            let squared = dot(candidate.separation, candidate.separation);
            if squared >= radius * radius {
                continue;
            }
            if let Some(feature) = candidate.boundary_slot() {
                let slots = unsafe { shell.contact_topology.add(12 * face_index + 2 * feature) };
                let start = unsafe { *slots };
                if start == u32::MAX {
                    continue;
                }
                let end = unsafe { *slots.add(1) };
                if (start..end).any(|index| {
                    let vertex = unsafe { *shell.contact_topology.add(index as usize) };
                    let neighbor = unsafe { *self.positions.add(vertex as usize) };
                    candidate.descends_toward(sub(center, neighbor))
                }) {
                    continue;
                }
            }
            let Some(hit) = contact(candidate.separation, radius, stiffness) else {
                return false;
            };
            if !visit(face.vertices, candidate, hit) {
                return false;
            }
        }
        true
    }

    unsafe fn contact_forces(&self, shell: &Shell) -> bool {
        for i in 0..shell.sphere_count as usize {
            let sphere = unsafe { &mut *shell.spheres.add(i) };
            if !shell.contact_topology.is_null() {
                sphere.force = [0.0; 3];
                sphere.energy = 0.0;
                let mut closest_squared = sphere.radius * sphere.radius;
                if !unsafe {
                    self.visit_manifold(
                        shell,
                        sphere.center,
                        sphere.radius,
                        sphere.stiffness,
                        |vertices, candidate, hit| {
                            sphere.force = combine(sphere.force, 1.0, hit.force, 1.0);
                            sphere.energy += hit.energy;
                            closest_squared = closest_squared
                                .min(dot(candidate.separation, candidate.separation));
                            let reactions = candidate
                                .weights
                                .map(|weight| hit.force.map(|component| -weight * component));
                            add_forces(self.forces, vertices, reactions);
                            true
                        },
                    )
                } {
                    return false;
                }
                sphere.clearance = sqrt(closest_squared);
                if !(dot(sphere.force, sphere.force) + sphere.energy).is_finite() {
                    return false;
                }
                continue;
            }
            let mut best_squared = sphere.radius * sphere.radius;
            let mut winner = None;
            for j in 0..shell.face_count as usize {
                let face = unsafe { *shell.faces.add(j) };
                let vertices = unsafe { load(self.positions, face.vertices) };
                // Conservative sphere/face AABB check before closest-feature calculations.
                if !within_bounds(sphere.center, sphere.radius, vertices) {
                    continue;
                }
                let candidate = closest(sphere.center, vertices);
                let distance_squared = dot(candidate.separation, candidate.separation);
                if distance_squared < best_squared {
                    best_squared = distance_squared;
                    winner = Some((face.vertices, candidate));
                }
            }
            sphere.force = [0.0; 3];
            sphere.energy = 0.0;
            sphere.clearance = sqrt(best_squared);
            if let Some((vertices, candidate)) = winner {
                let Some(hit) = contact(candidate.separation, sphere.radius, sphere.stiffness)
                else {
                    // A center on the sheet has no unique contact normal. Stop before committing the step.
                    return false;
                };
                sphere.force = hit.force;
                sphere.energy = hit.energy;
                if !shell.friction.is_null() {
                    let friction = unsafe { &mut *shell.friction.add(i) };
                    friction.vertices = vertices;
                    friction.weights = candidate.weights;
                    friction.arm = candidate.separation.map(|value| -value);
                }
                let reactions = candidate
                    .weights
                    .map(|weight| hit.force.map(|component| -weight * component));
                unsafe { add_forces(self.forces, vertices, reactions) };
            }
            if !dot(sphere.force, sphere.force).is_finite() {
                return false;
            }
        }
        true
    }

    unsafe fn forces(&mut self, shell: &Shell, budget: &mut Ledger) -> bool {
        budget.membrane = 0.0;
        budget.bend = 0.0;
        budget.hardening = 0.0;
        budget.plastic = 0.0;
        let hill = if shell.hill.f > 0.0 {
            Some(shell.hill)
        } else {
            None
        };
        for i in 0..shell.node_count as usize {
            let node = unsafe { *shell.nodes.add(i) };
            let applied = unsafe { *shell.applied.add(i) };
            unsafe {
                self.forces
                    .add(i)
                    .write(combine(applied, 1.0, shell.gravity, node.mass))
            };
        }
        if !unsafe { self.face_forces(shell, budget, hill) } {
            return false;
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
        for i in 0..shell.seam_count as usize {
            let edge = unsafe { *shell.seams.add(i) };
            let history = unsafe { &mut *self.seam_history.add(i) };
            let nodes = unsafe { load(self.positions, edge.vertices) };
            let (force, updated) = seam(edge, nodes, *history);
            if !(updated.elastic + updated.opening_area + updated.dissipation).is_finite() {
                return false;
            }
            *history = updated;
            unsafe { add_forces(self.forces, edge.vertices, force) };
        }
        (budget.membrane + budget.bend + budget.hardening + budget.plastic).is_finite()
            && unsafe { self.contact_forces(shell) }
    }

    unsafe fn friction_kick(&mut self, shell: &Shell, half_step: f64, remaining: f64) -> bool {
        for i in 0..shell.sphere_count as usize {
            let friction = unsafe { &mut *shell.friction.add(i) };
            let sphere = unsafe { &mut *shell.spheres.add(i) };
            if friction.coefficient == 0.0 {
                continue;
            }
            if shell.contact_topology.is_null() {
                if !unsafe {
                    self.friction_point(shell, sphere, friction, sphere.force, half_step, remaining)
                } {
                    return false;
                }
                continue;
            }
            if !unsafe {
                self.visit_manifold(
                    shell,
                    sphere.center,
                    sphere.radius,
                    sphere.stiffness,
                    |vertices, candidate, hit| {
                        friction.vertices = vertices;
                        friction.weights = candidate.weights;
                        friction.arm = candidate.separation.map(|value| -value);
                        self.friction_point(
                            shell, sphere, friction, hit.force, half_step, remaining,
                        )
                    },
                )
            } {
                return false;
            }
        }
        true
    }

    unsafe fn friction_point(
        &self,
        shell: &Shell,
        sphere: &mut Sphere,
        friction: &mut SphereFriction,
        force: Vector,
        half_step: f64,
        remaining: f64,
    ) -> bool {
        let normal_force = sqrt(dot(force, force));
        if normal_force == 0.0 {
            return true;
        }
        let velocities = unsafe { load(self.velocities, friction.vertices) };
        let inverse_masses = unsafe { load(shell.nodes, friction.vertices) }.map(|node| {
            if node.fixed == 0.0 {
                1.0 / node.mass
            } else {
                0.0
            }
        });
        let surface = combine(
            velocities[0],
            friction.weights[0],
            combine(
                velocities[1],
                friction.weights[1],
                velocities[2],
                friction.weights[2],
            ),
            1.0,
        );
        let relative = sub(
            combine(
                sphere.velocity,
                1.0,
                cross(friction.angular_velocity, friction.arm),
                1.0,
            ),
            surface,
        );
        let inverse_translation = sphere.inverse_mass
            + inverse_masses
                .iter()
                .zip(friction.weights)
                .map(|(inverse, weight)| inverse * weight * weight)
                .sum::<f64>();
        if inverse_translation == 0.0 {
            return true;
        }
        let normal = force.map(|value| value / normal_force);
        let limit = half_step * normal_force * friction.coefficient;
        let Some((impulse, loss)) = friction_impulse(
            relative,
            normal,
            friction.arm,
            inverse_translation,
            friction.inverse_inertia,
            limit,
        ) else {
            return false;
        };
        for (j, vertex) in friction.vertices.into_iter().enumerate() {
            let velocity = unsafe { &mut *self.velocities.add(vertex as usize) };
            *velocity = combine(
                *velocity,
                1.0,
                impulse,
                -inverse_masses[j] * friction.weights[j],
            );
        }
        sphere.velocity = combine(sphere.velocity, 1.0, impulse, sphere.inverse_mass);
        sphere.impulse = combine(sphere.impulse, 1.0, impulse, 1.0);
        sphere.first_moment = combine(sphere.first_moment, 1.0, impulse, remaining);
        let torque = cross(friction.arm, impulse);
        friction.angular_velocity = combine(
            friction.angular_velocity,
            1.0,
            inertia_product(friction.inverse_inertia, torque),
            1.0,
        );
        friction.angular_impulse = combine(friction.angular_impulse, 1.0, torque, 1.0);
        friction.angular_first_moment =
            combine(friction.angular_first_moment, 1.0, torque, remaining);
        // On the final kick only, publish support reactions without feeding them into the next kick.
        if remaining == 0.0 {
            let forces = friction
                .weights
                .map(|weight| impulse.map(|value| -weight * value / half_step));
            unsafe { add_forces(self.forces, friction.vertices, forces) };
        }
        friction.loss += loss;
        (friction.loss
            + dot(sphere.velocity, sphere.velocity)
            + dot(friction.angular_velocity, friction.angular_velocity))
        .is_finite()
    }

    unsafe fn kick(&mut self, shell: &Shell, seconds: f64, remaining: f64, drift: bool) -> bool {
        let has_friction = !shell.friction.is_null();
        let immediate_drift = drift && !has_friction;
        for i in 0..shell.node_count as usize {
            let node = unsafe { *shell.nodes.add(i) };
            let force = unsafe { *self.forces.add(i) };
            if !dot(force, force).is_finite() {
                return false;
            }
            if node.fixed == 0.0 {
                let velocity = unsafe { &mut *self.velocities.add(i) };
                *velocity = combine(*velocity, 1.0, force, 0.5 * seconds / node.mass);
                if immediate_drift {
                    let position = unsafe { &mut *self.positions.add(i) };
                    *position = combine(*position, 1.0, *velocity, seconds);
                }
            }
        }
        for i in 0..shell.sphere_count as usize {
            let sphere = unsafe { &mut *shell.spheres.add(i) };
            sphere.kick(shell.gravity, seconds, remaining, immediate_drift);
            if !dot(sphere.velocity, sphere.velocity).is_finite()
                || !dot(sphere.center, sphere.center).is_finite()
            {
                return false;
            }
        }
        if has_friction {
            if !unsafe { self.friction_kick(shell, 0.5 * seconds, remaining) } {
                return false;
            }
            if drift {
                for i in 0..shell.node_count as usize {
                    let node = unsafe { *shell.nodes.add(i) };
                    if node.fixed == 0.0 {
                        let position = unsafe { &mut *self.positions.add(i) };
                        let velocity = unsafe { *self.velocities.add(i) };
                        *position = combine(*position, 1.0, velocity, seconds);
                    }
                }
                for i in 0..shell.sphere_count as usize {
                    let sphere = unsafe { &mut *shell.spheres.add(i) };
                    sphere.center = combine(sphere.center, 1.0, sphere.velocity, seconds);
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
    work_counts: *mut [f64; 6],
    face_job: *mut FaceJob,
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
    let mut work = unsafe { shell.workspace(face_job) };
    let mut budget = unsafe { *shell.ledger };
    unsafe {
        copy_nonoverlapping(shell.positions, work.positions, nodes);
        copy_nonoverlapping(shell.velocities, work.velocities, nodes);
        copy_nonoverlapping(shell.face_state, work.face_state, faces);
        if shell.seam_count > 0 {
            copy_nonoverlapping(
                shell.seam_history,
                work.seam_history,
                shell.seam_count as usize,
            );
        }
    }
    if !unsafe { work.forces(shell, &mut budget) } {
        return 0;
    }
    for index in 0..count {
        if !unsafe {
            work.kick(shell, interval, (count - index) as f64 * interval, true)
                && work.forces(shell, &mut budget)
                && work.kick(
                    shell,
                    interval,
                    (count - index - 1) as f64 * interval,
                    false,
                )
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
    if (0..nodes).any(|i| !unsafe { *work.forces.add(i) }.iter().all(|x| x.is_finite())) {
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
        if shell.seam_count > 0 {
            copy_nonoverlapping(
                work.seam_history,
                shell.seam_history,
                shell.seam_count as usize,
            );
        }
        shell.ledger.write(budget);
    }
    if !work_counts.is_null() {
        let steps = f64::from(count);
        let faces = f64::from(shell.face_count);
        let force_evaluations = steps + 1.0;
        let sphere_checks = f64::from(shell.sphere_count) * force_evaluations;
        let friction_checks = if shell.friction.is_null() || shell.contact_topology.is_null() {
            0.0
        } else {
            let active = (0..shell.sphere_count as usize)
                .filter(|index| unsafe { (*shell.friction.add(*index)).coefficient } > 0.0)
                .count();
            2.0 * steps * active as f64
        };
        let pressure_visits = if shell.pressure.is_null() {
            0.0
        } else {
            faces * force_evaluations
        };
        unsafe {
            work_counts.write([
                steps,
                faces * force_evaluations,
                f64::from(shell.hinge_count) * force_evaluations,
                2.0 * f64::from(shell.seam_count) * force_evaluations,
                faces * (sphere_checks + friction_checks),
                pressure_visits,
            ]);
        }
    }
    1
}
