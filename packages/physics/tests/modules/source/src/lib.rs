//! The source module of the shared-memory prototype (docs/physics-framework.md, section 3): particles falling under
//! gravity onto the plane y = 0, in a state region the world assigned. The region is also its port: another module reads
//! the positions in place. Only + - * / and compares, so every build gives the same bits.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Words a particle takes in the state region: position x, y, z, then velocity x, y, z.
pub const STRIDE: u32 = 6;

/// The share of the normal speed a particle keeps when it bounces off the plane, by bounce count mod 4: read-only
/// static data, so the module has a data window to place.
static KEEP: [f32; 4] = [0.5, 0.45, 0.4, 0.35];

/// One semi-implicit Euler step of `n` particles at `state` (f32 words, `STRIDE` per particle) under gravity `g` for `dt`
/// seconds; a particle below the plane is mirrored above it with its normal speed reversed and scaled by `KEEP`.
///
/// # Safety
/// `state` must point to `n * STRIDE` f32 words of the shared memory that no other call writes meanwhile.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn source_step(state: *mut f32, n: u32, gx: f32, gy: f32, gz: f32, dt: f32) {
    for i in 0..n as usize {
        // SAFETY: the caller hands a region of n particles.
        let p = unsafe { core::slice::from_raw_parts_mut(state.add(i * STRIDE as usize), STRIDE as usize) };
        p[3] += gx * dt;
        p[4] += gy * dt;
        p[5] += gz * dt;
        p[0] += p[3] * dt;
        p[1] += p[4] * dt;
        p[2] += p[5] * dt;
        if p[1] < 0.0 {
            p[1] = -p[1];
            p[4] = -p[4] * KEEP[i & 3];
        }
    }
}

/// The layout version of the state region and port this module writes.
#[unsafe(no_mangle)]
pub extern "C" fn source_layout() -> u32 {
    1
}
