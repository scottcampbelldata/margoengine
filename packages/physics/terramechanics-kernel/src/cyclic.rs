#[repr(C)]
struct History {
    pressure: f64,
    compliance: f64,
    elastic: f64,
}

pub(crate) struct Cycle {
    initial_stiffness: f64,
    hardening: f64,
    states: *mut History,
    active: *mut u32,
}

pub(crate) struct Settlement {
    pub cut: f64,
    pub elastic: f64,
    pub change: f64,
}

impl Cycle {
    pub(crate) unsafe fn new(words: *mut f64, active: *mut u32) -> Option<Self> {
        (!words.is_null()).then(|| Self {
            initial_stiffness: *words,
            hardening: *words.add(1),
            states: words.add(2).cast(),
            active,
        })
    }

    /// Wong, Garber and Preston-Thomas (1984), the pressure-controlled inverse of the
    /// unload/reload line. Only the residual plastic advance enters the sediment ledger.
    pub(crate) unsafe fn indent(
        &self,
        i: usize,
        virgin_depth: f64,
        pressure: f64,
        permanent: f64,
        room: f64,
    ) -> Settlement {
        let state = &mut *self.states.add(i);
        let (cut, elastic) = if pressure > state.pressure {
            let stiffness = self.initial_stiffness + self.hardening * virgin_depth;
            let rebound = (pressure / stiffness).min(virgin_depth);
            state.pressure = pressure;
            state.compliance = rebound / pressure;
            let cut = (virgin_depth - rebound - permanent).max(0.0).min(room);
            (cut, rebound)
        } else {
            (0.0, pressure * state.compliance)
        };
        // Multiple footprint contributions in one step retain their maximum elastic displacement.
        let change = (elastic - state.elastic).max(0.0).min(room - cut);
        if change > 0.0 {
            if state.elastic == 0.0 {
                let count = *self.active;
                *self.active.add(1 + count as usize) = i as u32;
                *self.active = count + 1;
            }
            state.elastic += change;
        }
        Settlement {
            cut,
            elastic: state.elastic,
            change,
        }
    }
}

/// Restores the previous recoverable deformation before this tick's loads are applied.
///
/// # Safety
/// Input and output arrays cover the same full lattice in the world arena. The active array
/// holds a count followed by that many unique initialized vertex indices.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn unload_soil(words: *mut f64, active: *mut u32, deltas: *mut f64) {
    let states = words.add(2).cast::<History>();
    for j in 1..=*active as usize {
        let i = *active.add(j) as usize;
        let state = &mut *states.add(i);
        *deltas.add(i) += state.elastic;
        state.elastic = 0.0;
        *active.add(j) = 0;
    }
    *active = 0;
}
