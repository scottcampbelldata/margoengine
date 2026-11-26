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
