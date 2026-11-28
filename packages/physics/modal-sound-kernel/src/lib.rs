//! Audio-rate complex modal resonators and band-limited spatial excitation.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;

const TEXTURE_BANDS: usize = 8;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Oscillator {
    a: f64,
    b: f64,
    force_real: f64,
    force_imaginary: f64,
    impact_gain: f64,
    scrape_gain: f64,
    roll_gain: f64,
    fracture_gain: f64,
}

#[repr(C)]
struct TextureBand {
    cosine: f64,
    sine: f64,
    amplitude: f64,
}

#[repr(C)]
struct Drive {
    impact: f64,
    fracture: f64,
    scrape: f64,
    roll: f64,
    attack: f64,
    bands: [TextureBand; TEXTURE_BANDS],
}

#[repr(C)]
struct SurfaceState {
    scrape: f64,
    roll: f64,
    phase: [[f64; 2]; TEXTURE_BANDS],
}

#[inline]
fn phasor(z: v128, a: f64, b: f64) -> v128 {
    let swap = i64x2_shuffle::<1, 0>(z, z);
    f64x2_add(f64x2_mul(z, f64x2_splat(a)), f64x2_mul(swap, f64x2(b, -b)))
}

#[inline]
fn texture(surface: &mut SurfaceState, drive: &Drive) -> (f64, f64) {
    let mut scrape = 0.0;
    let mut roll = 0.0;
    for (i, band) in drive.bands.iter().enumerate() {
        let [real, imaginary] = surface.phase[i];
        // Scale drift out once per block below. Rotation preserves phase even when muted.
        let next_real = real * band.cosine + imaginary * band.sine;
        let next_imaginary = imaginary * band.cosine - real * band.sine;
        surface.phase[i] = [next_real, next_imaginary];
        if i < TEXTURE_BANDS / 2 {
            scrape += real * band.amplitude;
        } else {
            roll += real * band.amplitude;
        }
    }
    surface.scrape += (drive.scrape - surface.scrape) * drive.attack;
    surface.roll += (drive.roll - surface.roll) * drive.attack;
    (scrape * surface.scrape, roll * surface.roll)
}

/// The caller passes named, non-overlapping world arena regions and bound-checked counts.
#[unsafe(no_mangle)]
extern "C" fn modal_sound_block(
    models: *const Oscillator,
    states: *mut [f64; 2],
    modes: usize,
    surface: *mut SurfaceState,
    drive: *const Drive,
    pcm: *mut f32,
    samples: usize,
) {
    let modes = unsafe { core::slice::from_raw_parts(models, modes) };
    let states = unsafe { core::slice::from_raw_parts_mut(states, modes.len()) };
    let surface = unsafe { &mut *surface };
    let drive = unsafe { &*drive };
    let pcm = unsafe { core::slice::from_raw_parts_mut(pcm, samples) };
    for (mode, state) in modes.iter().zip(states.iter_mut()) {
        state[1] += drive.impact * mode.impact_gain + drive.fracture * mode.fracture_gain;
    }
    for sample in pcm {
        let (scrape, roll) = texture(surface, drive);
        let mut pressure = 0.0;
        for (mode, state) in modes.iter().zip(states.iter_mut()) {
            pressure += state[0];
            let force = scrape * mode.scrape_gain + roll * mode.roll_gain;
            let before = unsafe { v128_load(state.as_ptr().cast()) };
            let affine = f64x2_mul(
                f64x2_splat(force),
                f64x2(mode.force_real, mode.force_imaginary),
            );
            let after = f64x2_add(phasor(before, mode.a, mode.b), affine);
            unsafe { v128_store(state.as_mut_ptr().cast(), after) };
        }
        *sample = pressure as f32;
    }
    for phase in &mut surface.phase {
        let norm = f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(
            phase[0] * phase[0] + phase[1] * phase[1],
        )));
        phase[0] /= norm;
        phase[1] /= norm;
    }
}

#[repr(C)]
struct TrackJob {
    models: *const Oscillator,
    oscillators: *mut [f64; 2],
    modes: usize,
    surface: *mut SurfaceState,
    drive: *const Drive,
    pcm: *mut f32,
}

#[repr(C)]
struct Work {
    tracks: f64,
    pcm_samples: f64,
    mode_updates: f64,
    texture_updates: f64,
}

#[repr(C)]
struct Batch {
    tracks: *const TrackJob,
    track_count: usize,
    samples: usize,
    work: *mut Work,
}

const _: [(); 24] = [(); size_of::<TrackJob>()];
const _: [(); 16] = [(); size_of::<Batch>()];

/// Each participant renders whole tracks to disjoint scratch rows, in authored mode order.
#[unsafe(no_mangle)]
unsafe extern "C" fn modal_sound_thread_phase(
    batch: &Batch,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if stage != 0 || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    if batch.track_count == 0
        || batch.track_count > isize::MAX as usize / size_of::<TrackJob>()
        || batch.samples > isize::MAX as usize / size_of::<f32>()
    {
        return 1;
    }
    let first = part * batch.track_count / parts;
    let end = (part + 1) * batch.track_count / parts;
    let mut mode_updates = 0.0;
    unsafe {
        for track in first..end {
            let job = &*batch.tracks.add(track);
            if job.modes == 0 || job.modes > isize::MAX as usize / size_of::<Oscillator>() {
                return 1;
            }
            modal_sound_block(
                job.models,
                job.oscillators,
                job.modes,
                job.surface,
                job.drive,
                job.pcm,
                batch.samples,
            );
            let surface = &*job.surface;
            if !surface.scrape.is_finite()
                || !surface.roll.is_finite()
                || !surface.phase.iter().flatten().all(|x| x.is_finite())
                || !core::slice::from_raw_parts(job.oscillators, job.modes)
                    .iter()
                    .flatten()
                    .all(|x| x.is_finite())
                || !core::slice::from_raw_parts(job.pcm, batch.samples)
                    .iter()
                    .all(|x| x.is_finite())
            {
                return 1;
            }
            mode_updates += job.modes as f64 * batch.samples as f64;
        }
        let tracks = (end - first) as f64;
        let pcm_samples = tracks * batch.samples as f64;
        batch.work.add(part).write(Work {
            tracks,
            pcm_samples,
            mode_updates,
            texture_updates: pcm_samples * TEXTURE_BANDS as f64,
        });
    }
    0
}
