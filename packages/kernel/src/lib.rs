// Margo Engine kernel.
// Built with precision, named with love. For Margie.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
type Data = &'static mut [f32];
#[cfg(target_arch = "wasm32")]
type Flags = &'static mut [u8];
#[cfg(not(target_arch = "wasm32"))]
type Data = Vec<f32>;
#[cfg(not(target_arch = "wasm32"))]
type Flags = Vec<u8>;

#[inline]
fn sqrt(value: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    { use core::arch::wasm32::*; f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value))) }
    #[cfg(not(target_arch = "wasm32"))]
    { value.sqrt() }
}

// Each Wasm instance owns one fixed-capacity kernel; no allocations occur in tick. JS grows it by dropping it and
// creating a larger one at the same address (TransformStore.grow); at most 2^23 slots keep the layout under 4 GiB.
// Columns: translation X..SZ, PARENTS, WORLD_MATRIX (16 floats), LOCAL_SPHERE (4), WORLD_SPHERE..WORLD_R.
// PLANES is TAIL frustum floats, then Euler XYZ at PLANES * n + TAIL. LIMITS is six min/max pairs at LIMITS * n + TAIL.
// SCRATCH_MATRIX, SCRATCH_SPHERE and SNAPSHOT follow. Flags: ACTIVE, VISIBLE, CONSTRAINED, HIDDEN,
// DEPTH (low 7 bits, bit 128 hidden), TICK_STATE, CHANGED. `flags[id]` is ACTIVE. ROTATION is the Euler constraint mask.
const X: usize = 0;
const Y: usize = 1;
const Z: usize = 2;
const QX: usize = 3;
const QY: usize = 4;
const QZ: usize = 5;
const QW: usize = 6;
const SX: usize = 7;
const SY: usize = 8;
const SZ: usize = 9;
const PARENTS: usize = 10;
const WORLD_MATRIX: usize = 11;
const LOCAL_SPHERE: usize = 27;
const WORLD_SPHERE: usize = 31;
const WORLD_Y: usize = 32;
const WORLD_Z: usize = 33;
const WORLD_R: usize = 34;
const PLANES: usize = 35;
const LIMITS: usize = 38;
const SCRATCH_MATRIX: usize = 50;
const SCRATCH_SPHERE: usize = 66;
const SNAPSHOT: usize = 70;
const TAIL: usize = 24;
const DATA_LANES: usize = 86;
const ACTIVE: usize = 0;
const VISIBLE: usize = 1;
const CONSTRAINED: usize = 2;
const HIDDEN: usize = 3;
const DEPTH: usize = 4;
const TICK_STATE: usize = 5;
const CHANGED: usize = 6;
const FLAG_LANES: usize = 7;
const ROTATION: u8 = 56;
pub struct Kernel {
    capacity: usize,
    data: Data,
    flags: Flags,
    full: bool,
}

impl Kernel {
    #[cfg(not(target_arch = "wasm32"))]
    fn new(capacity: usize) -> Self {
        let mut data = vec![0.0; capacity * DATA_LANES + TAIL];
        data[PARENTS*capacity..(PARENTS+1)*capacity].fill(-1.0);
        Self { capacity, data, flags: vec![0; capacity * FLAG_LANES], full: true }
    }

    // Stores everything world_matrix reads for one entity (TRS, parent, local bounds, hidden flag) and returns whether
    // any of it differs from the previous call. A failed tick sets `full`, so a snapshot taken by it is never trusted.
    #[inline(never)]
    fn snapshot(&mut self, id: usize) -> bool {
        let n = self.capacity;
        let mut changed = false;
        // Indices are in range by layout; bounds checks here cost about 250 compressed bytes of core.
        for f in 0..16 { unsafe {
            let v = if f < PARENTS + 1 { self.data.get_unchecked(f*n+id).to_bits() } else if f < PARENTS + 5 { self.data.get_unchecked(LOCAL_SPHERE*n+id*4+f-(PARENTS+1)).to_bits() } else { *self.flags.get_unchecked(HIDDEN*n+id) as u32 };
            let at = self.data.get_unchecked_mut(SNAPSHOT*n+TAIL+id*16+f);
            if at.to_bits() != v { changed = true; *at = f32::from_bits(v); }
        } }
        changed
    }

    fn matrix(&self, id: usize) -> Option<[f32; 16]> {
        let n = self.capacity;
        let value = |field| self.data[field * n + id] as f64;
        if (X..PARENTS).any(|field| !value(field).is_finite()) || (SX..PARENTS).any(|field| value(field) == 0.0) { return None; }
        let length = sqrt((QX..SX).map(|field| { let v=value(field); v*v }).sum::<f64>());
        if length == 0.0 { return None; }
        let (x, y, z, w) = (value(QX) / length, value(QY) / length, value(QZ) / length, value(QW) / length);
        let (sx, sy, sz) = (value(SX), value(SY), value(SZ));
        let matrix = [
            ((1.0-2.0*(y*y+z*z))*sx) as f32, (2.0*(x*y+w*z)*sx) as f32, (2.0*(x*z-w*y)*sx) as f32, 0.0,
            (2.0*(x*y-w*z)*sy) as f32, ((1.0-2.0*(x*x+z*z))*sy) as f32, (2.0*(y*z+w*x)*sy) as f32, 0.0,
            (2.0*(x*z+w*y)*sz) as f32, (2.0*(y*z-w*x)*sz) as f32, ((1.0-2.0*(x*x+y*y))*sz) as f32, 0.0,
            value(X) as f32, value(Y) as f32, value(Z) as f32, 1.0,
        ];
        matrix.iter().all(|v| v.is_finite()).then_some(matrix)
    }

    fn sphere(&self, id: usize, m: &[f32; 16]) -> Option<[f32; 4]> {
        let n = self.capacity;
        let b = &self.data[LOCAL_SPHERE*n+id*4..LOCAL_SPHERE*n+id*4+4];
        if b.iter().any(|v| !v.is_finite()) || b[3] < 0.0 { return None; }
        let mut out = [0.0; 4];
        for row in 0..3 {
            out[row] = (m[row] as f64*b[0] as f64 + m[4+row] as f64*b[1] as f64 + m[8+row] as f64*b[2] as f64 + m[12+row] as f64) as f32;
        }
        if b[3]!=0.0 {let mut rows=[0.0;3];let mut cols=[0.0;3];
        for c in 0..3 {for r in 0..3 {let v=m[c*4+r].abs() as f64;rows[r]+=v;cols[c]+=v;}}
        let norm1=cols.into_iter().fold(0.0,f64::max);let norm_inf=rows.into_iter().fold(0.0,f64::max);
        out[3] = (b[3] as f64 * sqrt(norm1*norm_inf)) as f32;}
        out.iter().all(|v| v.is_finite()).then_some(out)
    }

    // Returns whether the entity was recomputed: its inputs differ from the snapshot or its parent was recomputed.
    #[inline(never)]
    fn world_matrix(&mut self, id: usize, level: usize) -> Option<bool> {
        let n=self.capacity;let state=self.flags[TICK_STATE*n+id];
        if level>=64 || state==1 {return None;}
        if state!=0 {return Some(state==3);}
        self.flags[TICK_STATE*n+id]=1;
        let mut changed=self.snapshot(id)|self.full;
        let parent=self.data[PARENTS*n+id];
        if parent!=-1.0 {
            if !parent.is_finite() || parent<0.0 || parent as usize as f32!=parent || parent>=n as f32 || self.flags[ACTIVE*n+parent as usize]==0 {return None;}
            changed|=self.world_matrix(parent as usize,level+1)?;
        }
        if changed {self.compute(id,parent)?;}
        self.flags[TICK_STATE*n+id]=2+changed as u8;
        Some(changed)
    }

    // Separate so the two parent tests are not threaded together (which duplicates the matrix code).
    #[inline(never)]
    fn compute(&mut self, id: usize, parent: f32) -> Option<()> {
        let n=self.capacity;let at=SCRATCH_MATRIX*n+TAIL+id*16;
        let mut matrix=self.matrix(id)?;let mut depth=1;let mut hidden=self.flags[HIDDEN*n+id]!=0;
        if parent!=-1.0 {
            let parent=parent as usize;let p=&self.data[SCRATCH_MATRIX*n+TAIL+parent*16..SCRATCH_MATRIX*n+TAIL+(parent+1)*16];
            depth=(self.flags[DEPTH*n+parent]&127)+1;if depth>64 {return None;}
            hidden|=self.flags[DEPTH*n+parent]&128!=0;
            let mut result=[0.0;16];
            // Local transforms are affine; the last row is always [0, 0, 0, 1].
            for c in 0..4 {for r in 0..3 {result[c*4+r]=((0..3).map(|k|p[k*4+r] as f64*matrix[c*4+k] as f64).sum::<f64>()+if c==3 {p[12+r] as f64}else{0.0}) as f32;}}result[15]=1.0;
            if result.iter().any(|v|!v.is_finite()) {return None;}
            matrix=result;
        }
        let sphere=self.sphere(id,&matrix)?;
        self.data[at..at+16].copy_from_slice(&matrix);let sphere_at=SCRATCH_SPHERE*n+TAIL+id*4;
        self.data[sphere_at..sphere_at+4].copy_from_slice(&sphere);
        self.flags[DEPTH*n+id]=depth|if hidden {128}else{0};
        Some(())
    }

    // The only XYZ (qX * qY * qZ) expansion. Tick calls this after clamping; JS calls kernel_sync_rotation.
    #[inline(never)]
    fn sync_rotation(&mut self, id: usize) {
        let n=self.capacity;
        let angle=&self.data[PLANES*n+TAIL+id*3..PLANES*n+TAIL+id*3+3];
        let pair=|a:f32|if a==0.0 {(0.0,1.0)}else{(sin(a as f64/2.0),sin(a as f64/2.0+core::f64::consts::FRAC_PI_2))};
        let ((sx,cx),(sy,cy),(sz,cz))=(pair(angle[0]),pair(angle[1]),pair(angle[2]));
        self.data[QX*n+id]=(sx*cy*cz+cx*sy*sz) as f32;self.data[QY*n+id]=(cx*sy*cz-sx*cy*sz) as f32;self.data[QZ*n+id]=(cx*cy*sz+sx*sy*cz) as f32;self.data[QW*n+id]=(cx*cy*cz-sx*sy*sz) as f32;
    }

    fn tick(&mut self, culling: bool) -> usize {
        let n = self.capacity;
        if culling && self.data[PLANES*n..PLANES*n+TAIL].iter().any(|v| !v.is_finite()) { return n+1; }
        for id in 0..n {
            if self.flags[ACTIVE*n+id] == 0 { continue; }
            let mask = self.flags[CONSTRAINED*n+id];if mask==0 {continue;}
            for axis in 0..6 { if mask & (1 << axis) != 0 {
                let at = if axis < 3 { axis*n+id } else { PLANES*n+TAIL+id*3+axis-3 };
                let limits = LIMITS*n+TAIL+id*12+axis*2;
                let (v, min, max) = (self.data[at],self.data[limits],self.data[limits+1]);
                if !v.is_finite() || !min.is_finite() || !max.is_finite() || min>max { return id+1; }
            } }
        }
        for id in 0..n { let mask=self.flags[CONSTRAINED*n+id]; if self.flags[ACTIVE*n+id]==0 || mask==0 {continue;}
            for axis in 0..6 { if mask & (1 << axis) != 0 { let at=if axis<3 {axis*n+id}else{PLANES*n+TAIL+id*3+axis-3};let limits=LIMITS*n+TAIL+id*12+axis*2;self.data[at]=self.data[at].max(self.data[limits]).min(self.data[limits+1]); } }
            if mask & ROTATION != 0 { self.sync_rotation(id); }
        }
        // Scratch is fixed at creation; publish only after the entire hierarchy validates.
        // Only entities whose inputs or ancestors changed are recomputed; a failed tick recomputes everything next time.
        self.flags[TICK_STATE*n..CHANGED*n].fill(0);
        for id in 0..n {if self.flags[ACTIVE*n+id]!=0 && self.world_matrix(id,0).is_none() {self.full=true;return id+1;}}
        for id in 0..n {
            self.flags[VISIBLE*n+id]=0;if self.flags[ACTIVE*n+id]==0 {continue;}
            if self.flags[TICK_STATE*n+id]==3 {
                self.data.copy_within(SCRATCH_MATRIX*n+TAIL+id*16..SCRATCH_MATRIX*n+TAIL+(id+1)*16,WORLD_MATRIX*n+id*16);
                for field in 0..4 {self.data[(WORLD_SPHERE+field)*n+id]=self.data[SCRATCH_SPHERE*n+TAIL+id*4+field];}
                // Sticky across ticks (packages tick too) until the engine has copied the matrix.
                self.flags[CHANGED*n+id]=1;
            }
            self.flags[VISIBLE*n+id]=u8::from(self.flags[DEPTH*n+id]&128==0);
        }
        if culling { self.cull(); }
        self.full=false;
        0
    }

    fn cull(&mut self) {
        let n = self.capacity;
        // shortcut: linear sphere culling, add a spatial index when measured scenes need it.
        #[cfg(target_arch = "wasm32")]
        unsafe {
            use core::arch::wasm32::*;
            for id in (0..n.saturating_sub(3)).step_by(4) {
                let x = v128_load(self.data.as_ptr().add(WORLD_SPHERE*n+id).cast());
                let y = v128_load(self.data.as_ptr().add(WORLD_Y*n+id).cast());
                let z = v128_load(self.data.as_ptr().add(WORLD_Z*n+id).cast());
                let r = v128_load(self.data.as_ptr().add(WORLD_R*n+id).cast());
                let mut mask = 0;
                for plane in self.data[PLANES*n..PLANES*n+TAIL].chunks_exact(4) {
                    let d = f32x4_add(f32x4_add(f32x4_mul(x, f32x4_splat(plane[0])), f32x4_mul(y, f32x4_splat(plane[1]))), f32x4_add(f32x4_mul(z, f32x4_splat(plane[2])), f32x4_splat(plane[3])));
                    mask |= i32x4_bitmask(f32x4_lt(d, f32x4_neg(r)));
                }
                for lane in 0..4 { if mask & (1 << lane) != 0 { self.flags[VISIBLE*n+id+lane] = 0; } }
            }
        }
        let start = if cfg!(target_arch = "wasm32") { n/4*4 } else { 0 };
        for id in start..n {
            for p in self.data[PLANES*n..PLANES*n+TAIL].chunks_exact(4) {
                let d = p[0]*self.data[WORLD_SPHERE*n+id]+p[1]*self.data[WORLD_Y*n+id]+p[2]*self.data[WORLD_Z*n+id]+p[3];
                if d < -self.data[WORLD_R*n+id] { self.flags[VISIBLE*n+id] = 0; break; }
            }
        }
    }
}

#[unsafe(no_mangle)]
#[cfg(not(target_arch = "wasm32"))]
pub extern "C" fn kernel_new(capacity: usize) -> *mut Kernel {
    if !(1..=1<<23).contains(&capacity) { return std::ptr::null_mut(); }
    Box::into_raw(Box::new(Kernel::new(capacity)))
}

#[cfg(target_arch = "wasm32")]
static mut KERNEL: core::mem::MaybeUninit<Kernel> = core::mem::MaybeUninit::uninit();
#[cfg(target_arch = "wasm32")]
static mut INITIALIZED: bool = false;
#[cfg(target_arch = "wasm32")]
unsafe extern "C" { static __heap_base: u8; }

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn kernel_new(capacity: usize) -> *mut Kernel {
    unsafe {
        if INITIALIZED || !(1..=1<<23).contains(&capacity) { return core::ptr::null_mut(); }
        let start = (core::ptr::addr_of!(__heap_base) as usize+3)&!3;
        let length = capacity*DATA_LANES+TAIL;
        let end = start+length*4+capacity*FLAG_LANES;
        let required = end.div_ceil(65536);
        let current = core::arch::wasm32::memory_size::<0>();
        if required>current && core::arch::wasm32::memory_grow::<0>(required-current)==usize::MAX { return core::ptr::null_mut(); }
        let data = core::slice::from_raw_parts_mut(start as *mut f32,length);
        let flags = core::slice::from_raw_parts_mut((start+length*4) as *mut u8,capacity*FLAG_LANES);
        data.fill(0.0); flags.fill(0); data[PARENTS*capacity..(PARENTS+1)*capacity].fill(-1.0);
        let handle = core::ptr::addr_of_mut!(KERNEL).cast::<Kernel>();
        handle.write(Kernel {capacity,data,flags,full:true}); INITIALIZED=true; handle
    }
}

fn sin(value:f64)->f64 {
    #[cfg(target_arch = "wasm32")]
    let turns = {use core::arch::wasm32::*;f64x2_extract_lane::<0>(f64x2_nearest(f64x2_splat(value/core::f64::consts::TAU)))};
    #[cfg(not(target_arch = "wasm32"))]
    let turns=(value/core::f64::consts::TAU).round();
    let x=value-turns*core::f64::consts::TAU;let mut term=x;let mut sum=x;for i in 1..12 {term *= -x*x/((2*i)*(2*i+1)) as f64;sum+=term;}sum
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_data(kernel: *mut Kernel) -> *mut f32 { unsafe { (*kernel).data.as_mut_ptr() } }
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_flags(kernel: *mut Kernel) -> *mut u8 { unsafe { (*kernel).flags.as_mut_ptr() } }
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_tick(kernel: *mut Kernel, culling: u32) -> usize { unsafe { (*kernel).tick(culling != 0) } }
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_sync_rotation(kernel: *mut Kernel, id: usize) {
    unsafe { if !kernel.is_null() && id < (*kernel).capacity { (*kernel).sync_rotation(id); } }
}
#[unsafe(no_mangle)]
#[cfg(not(target_arch = "wasm32"))]
pub unsafe extern "C" fn kernel_drop(kernel: *mut Kernel) { if !kernel.is_null() { unsafe { drop(Box::from_raw(kernel)); } } }

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_drop(kernel: *mut Kernel) {
    unsafe { if !kernel.is_null() { (*kernel).flags.fill(0); INITIALIZED=false; } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transforms_and_failed_updates_are_atomic() {
        let mut k = Kernel::new(1);
        k.flags[ACTIVE] = 1;
        k.data[X] = 2.0; k.data[QW] = 2.0;
        k.data[SX..PARENTS].copy_from_slice(&[-2.0, 3.0, 4.0]);
        k.data[LOCAL_SPHERE + 3] = 1.0;
        assert_eq!(k.tick(false), 0);
        assert_eq!(k.data[WORLD_MATRIX], -2.0); assert_eq!(k.data[WORLD_MATRIX + 12], 2.0);
        let previous = k.data[WORLD_MATRIX..LOCAL_SPHERE].to_vec();
        k.data[X] = f32::NAN;
        assert_eq!(k.tick(false), 1);
        assert_eq!(&k.data[WORLD_MATRIX..LOCAL_SPHERE], previous.as_slice());
    }
    #[test]
    fn culling_includes_touching_and_ignores_inactive_slots() {
        let mut k = Kernel::new(5);
        for id in 0..5 {
            k.flags[ACTIVE * 5 + id] = 1;
            k.data[X * 5 + id] = id as f32;
            for field in QW..PARENTS { k.data[field*5+id] = 1.0; }
            k.data[LOCAL_SPHERE*5+id*4+3] = 1.0;
        }
        k.data[PLANES*5] = -1.0; k.data[PLANES*5+3] = 1.0;
        k.flags[ACTIVE * 5 + 4] = 0;
        assert_eq!(k.tick(true), 0);
        assert_eq!(&k.flags[VISIBLE * 5..CONSTRAINED * 5], &[1,1,1,0,0]);
    }
    #[test]
    fn parents_compose_and_cycles_reject() {
        let mut k = Kernel::new(2);
        for id in 0..2 { k.flags[ACTIVE * 2 + id] = 1; for field in QW..PARENTS { k.data[field*2+id] = 1.0; } }
        k.data[X * 2] = 3.0; k.data[X * 2 + 1] = 2.0; k.data[PARENTS * 2 + 1] = 0.0;
        assert_eq!(k.tick(false), 0);
        assert_eq!(k.data[WORLD_MATRIX * 2 + 16 + 12], 5.0);
        k.data[PARENTS * 2] = 1.0;
        assert_eq!(k.tick(false), 1);
    }
    #[test]
    fn joint_limits_clamp_in_rust_and_hidden_parents_keep_descendants_hidden() {
        let n=2;let mut k=Kernel::new(n);for id in 0..n {k.flags[ACTIVE*n+id]=1;for field in QW..PARENTS {k.data[field*n+id]=1.0;}}
        k.data[PARENTS*n+1]=0.0;k.flags[CONSTRAINED*n]=1|32;k.data[LIMITS*n+TAIL]=0.0;k.data[LIMITS*n+TAIL+1]=2.0;k.data[LIMITS*n+TAIL+10]=-0.5;k.data[LIMITS*n+TAIL+11]=0.5;k.data[X]=7.0;k.data[PLANES*n+TAIL+2]=2.0;k.flags[HIDDEN*n]=1;
        assert_eq!(k.tick(false),0);assert_eq!(k.data[X],2.0);assert_eq!(k.data[PLANES*n+TAIL+2],0.5);assert_eq!(&k.flags[VISIBLE*n..VISIBLE*n+2],&[0,0]);assert!((k.data[WORLD_MATRIX*n]-0.5f32.cos()).abs()<1e-6);
        k.flags[HIDDEN*n]=0;k.flags[HIDDEN*n+1]=1;assert_eq!(k.tick(false),0);assert_eq!(&k.flags[VISIBLE*n..VISIBLE*n+2],&[1,0]);
    }
    #[test]
    fn only_changed_inputs_and_their_descendants_are_recomputed() {
        let n=3;let mut k=Kernel::new(n);
        for id in 0..n {k.flags[ACTIVE*n+id]=1;for field in QW..PARENTS {k.data[field*n+id]=1.0;}}
        k.data[PARENTS*n+1]=2.0;k.data[PARENTS*n]=1.0; // 0 -> 1 -> 2 (child ids before parents)
        // Sticky changed bytes, cleared here the way the engine clears them after copying matrices.
        let changed=|k:&mut Kernel|{let ids:Vec<usize>=(0..n).filter(|&id|k.flags[CHANGED*n+id]!=0).collect();k.flags[CHANGED*n..(CHANGED+1)*n].fill(0);ids};
        assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0,1,2]);
        assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[]);
        k.data[X*n+2]=5.0;assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0,1,2]);assert_eq!(k.data[WORLD_MATRIX*n+12],5.0);
        k.data[X*n]=1.0;assert_eq!(k.tick(false),0);assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0]);assert_eq!(k.data[WORLD_MATRIX*n+12],6.0);
        k.data[SX*n+1]=2.0;assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0,1]);assert_eq!(k.data[WORLD_MATRIX*n+16],2.0);
        k.flags[HIDDEN*n+1]=1;assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0,1]);assert_eq!(&k.flags[VISIBLE*n..(VISIBLE+1)*n],&[0,0,1]);
        k.data[PARENTS*n]=-1.0;assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0]);assert_eq!(&k.flags[VISIBLE*n..(VISIBLE+1)*n],&[1,0,1]);assert_eq!(k.data[WORLD_MATRIX*n+12],1.0);
        // A failed tick publishes nothing and the next one recomputes everything.
        let published=k.data[WORLD_MATRIX*n..LOCAL_SPHERE*n].to_vec();
        k.data[X*n+2]=f32::NAN;assert_eq!(k.tick(false),2);assert_eq!(&k.data[WORLD_MATRIX*n..LOCAL_SPHERE*n],published.as_slice());assert_eq!(changed(&mut k),[]);
        k.data[X*n+2]=5.0;assert_eq!(k.tick(false),0);assert_eq!(changed(&mut k),[0,1,2]);assert_eq!(&k.data[WORLD_MATRIX*n..LOCAL_SPHERE*n],published.as_slice());
    }
    #[test]
    fn sync_rotation_matches_a_constrained_tick_and_ignores_a_bad_id() {
        let mut direct=Kernel::new(1);
        direct.sync_rotation(0);
        assert_eq!([direct.data[QX],direct.data[QY],direct.data[QZ],direct.data[QW]],[0.0,0.0,0.0,1.0]);
        let angles=[0.3f32,-0.4,1.1];
        let mut clamped=Kernel::new(1);
        clamped.flags[ACTIVE]=1;clamped.flags[CONSTRAINED]=ROTATION;
        for field in QW..PARENTS {clamped.data[field]=1.0;}
        for axis in 0..3 {
            direct.data[PLANES+TAIL+axis]=angles[axis];
            clamped.data[PLANES+TAIL+axis]=angles[axis];
            clamped.data[LIMITS+TAIL+(axis+3)*2]=angles[axis];
            clamped.data[LIMITS+TAIL+(axis+3)*2+1]=angles[axis];
        }
        direct.sync_rotation(0);
        assert_eq!(clamped.tick(false),0);
        assert_eq!(&direct.data[QX..SX],&clamped.data[QX..SX]);
        let saved=direct.data[QX];
        unsafe { kernel_sync_rotation(&mut direct, 1); }
        assert_eq!(direct.data[QX],saved);
    }
}
