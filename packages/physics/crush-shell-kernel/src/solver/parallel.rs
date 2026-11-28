use core::num::NonZeroU64;

use super::{Face, FaceState, Shell, face_is_valid, load, panel_load, update_face};
#[cfg(feature = "threaded")]
use super::{Ledger, Workspace, add_forces};
use crate::material::Hill;
use crate::membrane::{Membrane, Vector, membrane, membrane_pair};

#[repr(C)]
pub(super) struct FaceWork {
    pub(super) force_evaluations: f64,
    pub(super) faces: f64,
    paired_faces: f64,
    pub(super) plastic_returns: f64,
    pub(super) pressure_faces: f64,
}

#[repr(C)]
struct Contributions {
    force: [Vector; 3],
    pressure: [Vector; 3],
    energy: Vector,
    pressure_active: f64,
}

const _: [(); 176] = [(); core::mem::size_of::<Contributions>()];

#[repr(C)]
pub(super) struct FaceJob {
    shell: *const Shell,
    positions: *const Vector,
    state: *mut FaceState,
    output: *mut Contributions,
    pub(super) work: *mut FaceWork,
    pub(super) parts: usize,
}

const _: [(); 24] = [(); core::mem::size_of::<FaceJob>()];

#[cfg(feature = "threaded")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn crush_shell_join() -> u32;
}

#[cfg(feature = "threaded")]
impl Workspace {
    pub(super) unsafe fn parallel_faces(&self, shell: &Shell, budget: &mut Ledger) -> bool {
        unsafe {
            let job = &mut *self.face_job;
            job.shell = shell;
            job.positions = self.positions;
            job.state = self.face_state;
            if crush_shell_join() != 0 {
                return false;
            }
            for i in 0..shell.face_count as usize {
                let face = *shell.faces.add(i);
                let row = &*(*self.face_job).output.add(i);
                budget.membrane += row.energy[0];
                budget.hardening += row.energy[1];
                budget.plastic += row.energy[2];
                add_forces(self.forces, face.vertices, row.force);
                // The serial path adds the membrane and pressure separately at this exact point.
                if row.pressure_active != 0.0 {
                    add_forces(self.forces, face.vertices, row.pressure);
                }
            }
        }
        true
    }
}

struct Input {
    index: usize,
    face: Face,
    points: [Vector; 3],
}

impl FaceJob {
    unsafe fn input(&self, shell: &Shell, index: usize) -> Option<Input> {
        let face = unsafe { *shell.faces.add(index) };
        let points = unsafe { load(self.positions, face.vertices) };
        face_is_valid(points).then_some(Input {
            index,
            face,
            points,
        })
    }

    unsafe fn evaluate_tail(
        &self,
        shell: &Shell,
        row: Input,
        hill: Option<Hill>,
        receipt: &mut FaceWork,
    ) {
        let state = unsafe { (*self.state.add(row.index)).plastic };
        let result = membrane(row.face.element, row.points, shell.steel, state, hill);
        unsafe { self.write(shell, row, result, receipt) };
    }

    unsafe fn write(&self, shell: &Shell, row: Input, result: Membrane, receipt: &mut FaceWork) {
        let state = unsafe { &mut *self.state.add(row.index) };
        if update_face(state, &result) {
            receipt.plastic_returns += 1.0;
        }
        let pressure = unsafe { panel_load(shell, row.index, row.points) };
        let mut active = 0.0;
        if pressure.is_some() {
            receipt.pressure_faces += 1.0;
            active = 1.0;
        }
        let volume = row.face.element.volume;
        unsafe {
            self.output.add(row.index).write(Contributions {
                force: result.forces,
                pressure: pressure.unwrap_or([[0.0; 3]; 3]),
                energy: [
                    volume * result.result.elastic,
                    volume * result.result.hardened,
                    volume * result.result.state.dissipated,
                ],
                pressure_active: active,
            });
        }
        receipt.faces += 1.0;
    }
}

/// Independent trial-state and force evaluations for a contiguous set of whole triangles.
///
/// Safety: the shell and position inputs remain immutable during the phase. Separate participants
/// own disjoint state, force output and receipt ranges, and join before the ordered assembly.
#[unsafe(no_mangle)]
unsafe extern "C" fn crush_shell_thread_phase(
    job: &FaceJob,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    let Some(partition) = NonZeroU64::new(parts as u64) else {
        return 1;
    };
    if stage != 0 || part >= parts || job.parts != parts {
        return 1;
    }
    let shell = unsafe { &*job.shell };
    let count = shell.face_count as usize;
    let pairs = (count / 2) as u64;
    let mut i = 2 * (pairs * part as u64 / partition) as usize;
    let end = if part + 1 == parts {
        count
    } else {
        2 * (pairs * (part + 1) as u64 / partition) as usize
    };
    let hill = (shell.hill.f > 0.0).then_some(shell.hill);
    let receipt = unsafe { &mut *job.work.add(part) };
    while i + 1 < end {
        let Some(a) = (unsafe { job.input(shell, i) }) else {
            return 1;
        };
        let Some(b) = (unsafe { job.input(shell, i + 1) }) else {
            return 1;
        };
        let (left, right) = unsafe {
            membrane_pair(
                (a.face.element, a.points, (*job.state.add(i)).plastic),
                (b.face.element, b.points, (*job.state.add(i + 1)).plastic),
                shell.steel,
                hill,
            )
        };
        unsafe {
            job.write(shell, a, left, receipt);
            job.write(shell, b, right, receipt);
        }
        i += 2;
        receipt.paired_faces += 2.0;
    }
    if i < end {
        let Some(row) = (unsafe { job.input(shell, i) }) else {
            return 1;
        };
        unsafe { job.evaluate_tail(shell, row, hill, receipt) };
    }
    receipt.force_evaluations += 1.0;
    0
}
