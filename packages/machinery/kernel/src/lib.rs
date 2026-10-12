#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
unsafe extern "C" { static __heap_base: u8; }
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

// One fixed allocation per instance; all hot paths use caller-owned linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn allocate(bytes: usize) -> usize {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        let start = (core::ptr::addr_of!(__heap_base) as usize + 7) & !7;
        if bytes > 256 * 1024 * 1024 { return 0; }
        let required = (start + bytes).div_ceil(65536);
        let current = core::arch::wasm32::memory_size::<0>();
        if required > current && core::arch::wasm32::memory_grow::<0>(required-current) == usize::MAX { return 0; }
        core::ptr::write_bytes(start as *mut u8, 0, bytes);
        start
    }
    #[cfg(not(target_arch = "wasm32"))]
    { let _ = bytes; 0 }
}

fn sqrt(v: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    { use core::arch::wasm32::*; f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(v))) }
    #[cfg(not(target_arch = "wasm32"))]
    { v.sqrt() }
}

// SoA: position, velocity, target velocity, friction, half length, lane, lane axis,
// mass, carrier and contact normal. Scratch: next position/velocity plus sort IDs.
fn surface(data: &mut [f32], order: &mut [u32], n: usize, dt: f64, gravity: f64) -> usize {
    if !dt.is_finite() || !(0.0..=1.0).contains(&dt) || !gravity.is_finite() || gravity < 0.0 { return n+1; }
    for i in 0..n {
        if (0..20).any(|f| !data[f*n+i].is_finite()) || data[9*n+i] < 0.0 || data[10*n+i] < 0.0 || data[15*n+i] <= 0.0 { return i+1; }
        let length = (12..15).map(|f| {let v=data[f*n+i] as f64;v*v}).sum::<f64>();
        if (length-1.0).abs() > 1e-5 || data[11*n+i] < 0.0 || data[11*n+i] as u32 as f32 != data[11*n+i] { return i+1; }
        let mut change = [0.0;3];
        for a in 0..3 { change[a] = data[(6+a)*n+i] as f64 - data[(3+a)*n+i] as f64; }
        let length = sqrt(change.iter().map(|v| v*v).sum());
        let factor = if length == 0.0 { 0.0 } else { (data[9*n+i] as f64 * gravity * dt / length).min(1.0) };
        for a in 0..3 {
            let velocity = data[(3+a)*n+i] as f64 + change[a]*factor;
            let position = data[a*n+i] as f64 + velocity*dt;
            if !(velocity as f32).is_finite() || !(position as f32).is_finite() { return i+1; }
            data[(20+a)*n+i] = position as f32; data[(23+a)*n+i] = velocity as f32;
        }
        order[i] = i as u32;
    }
    let coordinate = |data:&[f32],id: usize| (0..3).map(|a| data[a*n+id] as f64 * data[(12+a)*n+id] as f64).sum::<f64>();
    order.sort_unstable_by(|a,b| data[11*n+*a as usize].total_cmp(&data[11*n+*b as usize]).then_with(||coordinate(data,*a as usize).total_cmp(&coordinate(data,*b as usize))));
    let mut start=0;
    while start<n {
        let mut end=start+1; while end<n && data[11*n+order[end] as usize]==data[11*n+order[start] as usize] {end+=1;}
        let mut direction=1.0;
        // Inertia determines the leader during reversal, even before velocity reaches the new target.
        for at in start..end {let id=order[at] as usize;let speed=(0..3).map(|a|data[(23+a)*n+id]*data[(12+a)*n+id]).sum::<f32>();if speed!=0.0 {direction=if speed<0.0 {-1.0}else{1.0};break;}}
        for step in 1..end-start {
            let (rear,lead)=if direction>0.0 {(order[end-1-step] as usize,order[end-step] as usize)}else{(order[start+step] as usize,order[start+step-1] as usize)};
            for a in 0..3 { if (data[(12+a)*n+rear]-data[(12+a)*n+lead]).abs()>1e-5 {return rear+1;} }
            let clearance=data[10*n+rear] as f64+data[10*n+lead] as f64;
            let lead_coordinate=coordinate(data,lead);let rear_coordinate=coordinate(data,rear);
            // Float32 positions lose absolute precision with distance from the scene origin.
            let epsilon=lead_coordinate.abs().max(rear_coordinate.abs()).max(clearance).max(1.0)*f32::EPSILON as f64*4.0;
            let old_gap=direction*(lead_coordinate-rear_coordinate);
            if old_gap+epsilon<clearance {return rear+1;}
            let projected = |id:usize| (0..3).map(|a|data[(20+a)*n+id] as f64*data[(12+a)*n+id] as f64).sum::<f64>();
            let gap=direction*(projected(lead)-projected(rear));
            if gap<=clearance+epsilon {
                let lead_speed=(0..3).map(|a|data[(23+a)*n+lead] as f64*data[(12+a)*n+lead] as f64).sum::<f64>();
                let rear_speed=(0..3).map(|a|data[(23+a)*n+rear] as f64*data[(12+a)*n+rear] as f64).sum::<f64>();
                for a in 0..3 {let axis=data[(12+a)*n+rear] as f64;data[(20+a)*n+rear]=(data[(20+a)*n+rear] as f64-direction*(clearance-gap).max(0.0)*axis) as f32;if direction*(rear_speed-lead_speed)>0.0 {data[(23+a)*n+rear]=(data[(23+a)*n+rear] as f64+(lead_speed-rear_speed)*axis) as f32;}}
            }
        }
        start=end;
    }
    if data[20*n..26*n].iter().any(|v|!v.is_finite()) {return n+1;}
    for f in 0..6 {data.copy_within((20+f)*n..(21+f)*n,f*n);}
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn surface_tick(ptr: *mut f32, n: usize, dt: f64, gravity: f64) -> usize {
    unsafe {surface(core::slice::from_raw_parts_mut(ptr,26*n),core::slice::from_raw_parts_mut(ptr.add(26*n).cast(),n),n,dt,gravity)}
}

// Ring rows: previous value, next value, previous slope, next slope, result.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn telemetry_sample(ptr: *mut f32, n: usize, t: f64, span: f64) {
    let d=unsafe {core::slice::from_raw_parts_mut(ptr,n*5)};let t=t.clamp(0.0,1.0);let t2=t*t;let t3=t2*t;
    for i in 0..n {d[4*n+i]=((2.0*t3-3.0*t2+1.0)*d[i] as f64+(t3-2.0*t2+t)*span*d[2*n+i] as f64+(-2.0*t3+3.0*t2)*d[n+i] as f64+(t3-t2)*span*d[3*n+i] as f64) as f32;}
}

fn bounds(triangles:&[f32],ids:&[u32],start:usize,count:usize)->[f32;6] {
    let mut b=[f32::INFINITY,f32::INFINITY,f32::INFINITY,f32::NEG_INFINITY,f32::NEG_INFINITY,f32::NEG_INFINITY];
    for &id in &ids[start..start+count] {for v in 0..3 {for a in 0..3 {let p=triangles[id as usize*9+v*3+a];b[a]=b[a].min(p);b[a+3]=b[a+3].max(p);}}}b
}
fn build(triangles:&[f32],ids:&mut [u32],nodes:&mut [f32],start:usize,count:usize,next:&mut usize)->usize {
    let at=*next;*next+=1;let b=bounds(triangles,ids,start,count);nodes[at*8..at*8+6].copy_from_slice(&b);
    if count<=8 {nodes[at*8+6]=start as f32;nodes[at*8+7]=count as f32;}
    else {let mut axis=0;for a in 1..3 {if b[a+3] as f64-b[a] as f64>b[axis+3] as f64-b[axis] as f64 {axis=a;}}
        let centroid=|id:u32| (0..3).map(|v|triangles[id as usize*9+v*3+axis] as f64).sum::<f64>();
        let mid=count/2;ids[start..start+count].select_nth_unstable_by(mid,|a,b|centroid(*a).total_cmp(&centroid(*b)));
        let left=build(triangles,ids,nodes,start,mid,next);let right=build(triangles,ids,nodes,start+mid,count-mid,next);nodes[at*8+6]=left as f32;nodes[at*8+7]=-(right as f32);
    }at
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bvh_build(ptr:*mut f32,n:usize)->usize {
    let triangles=unsafe {core::slice::from_raw_parts(ptr,9*n)};
    if triangles.iter().any(|p|!p.is_finite()) {return 0;}
    let ids=unsafe {core::slice::from_raw_parts_mut(ptr.add(9*n).cast::<u32>(),n)};for (i,id) in ids.iter_mut().enumerate() {*id=i as u32;}
    let nodes=unsafe {core::slice::from_raw_parts_mut(ptr.add(10*n),16*n)};let mut next=0;build(triangles,ids,nodes,0,n,&mut next);next
}
fn ray_box(b:&[f32],origin:&[f64;3],direction:&[f64;3],max:f64)->bool {
    let mut near: f64=0.0;let mut far=max;
    for a in 0..3 {if direction[a]==0.0 {if origin[a]<b[a] as f64||origin[a]>b[a+3] as f64 {return false;}}
        else {let x=(b[a] as f64-origin[a])/direction[a];let y=(b[a+3] as f64-origin[a])/direction[a];near=near.max(x.min(y));far=far.min(x.max(y));if near>far {return false;}}}true
}
fn cross(a:[f64;3],b:[f64;3])->[f64;3] {[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
fn dot(a:[f64;3],b:[f64;3])->f64 {a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bvh_ray(ptr:*const f32,n:usize,ox:f64,oy:f64,oz:f64,dx:f64,dy:f64,dz:f64,max:f64,out:*mut f64) {
    let triangles=unsafe {core::slice::from_raw_parts(ptr,9*n)};let ids=unsafe {core::slice::from_raw_parts(ptr.add(9*n).cast::<u32>(),n)};let nodes=unsafe {core::slice::from_raw_parts(ptr.add(10*n),16*n)};
    let origin=[ox,oy,oz];let direction=[dx,dy,dz];let mut best=max;let mut hit=-1.0;let mut stack=[0usize;64];let mut top=1;
    while top>0 {top-=1;let at=stack[top]*8;if !ray_box(&nodes[at..at+6],&origin,&direction,best) {continue;}
        if nodes[at+7]<0.0 {stack[top]=nodes[at+6] as usize;stack[top+1]=(-nodes[at+7]) as usize;top+=2;continue;}
        let start=nodes[at+6] as usize;let count=nodes[at+7] as usize;
        for &id in &ids[start..start+count] {let t=&triangles[id as usize*9..id as usize*9+9];let a=[t[0] as f64,t[1] as f64,t[2] as f64];let e1=[t[3] as f64-a[0],t[4] as f64-a[1],t[5] as f64-a[2]];let e2=[t[6] as f64-a[0],t[7] as f64-a[1],t[8] as f64-a[2]];
            let h=cross(direction,e2);let det=dot(e1,h);if det.abs()<1e-15 {continue;}let s=[origin[0]-a[0],origin[1]-a[1],origin[2]-a[2]];let u=dot(s,h)/det;if !(0.0..=1.0).contains(&u) {continue;}let q=cross(s,e1);let v=dot(direction,q)/det;if v<0.0||u+v>1.0 {continue;}let distance=dot(e2,q)/det;if distance>=0.0&&distance<=best {best=distance;hit=id as f64;}
        }
    }
    unsafe {*out=hit;*out.add(1)=best;}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn surface_friction_queue_and_atomic_failure() {
        let n=2;let mut d=vec![0.0;26*n];let mut order=vec![0;n];
        for i in 0..n {d[6*n+i]=2.0;d[9*n+i]=1.0;d[10*n+i]=0.5;d[12*n+i]=1.0;d[15*n+i]=1.0;}
        d[1]=1.1;d[6*n+1]=0.0;
        assert_eq!(surface(&mut d,&mut order,n,0.1,10.0),0);assert!((d[1]-d[0]-1.0).abs()<1e-5);assert_eq!(d[3*n],0.0);
        let saved=d[..6*n].to_vec();d[9*n]=f32::NAN;assert_ne!(surface(&mut d,&mut order,n,0.1,10.0),0);assert_eq!(&d[..6*n],saved.as_slice());
    }
    #[test] fn bvh_hit_and_miss() {
        let n=1;let mut d=vec![0.0;26*n];d[..9].copy_from_slice(&[0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0]);let mut out=[0.0;2];
        unsafe {assert_eq!(bvh_build(d.as_mut_ptr(),n),1);bvh_ray(d.as_ptr(),n,0.2,0.2,1.0,0.0,0.0,-1.0,10.0,out.as_mut_ptr());}assert_eq!(out,[0.0,1.0]);
        unsafe {bvh_ray(d.as_ptr(),n,2.0,2.0,1.0,0.0,0.0,-1.0,10.0,out.as_mut_ptr());}assert_eq!(out[0],-1.0);
    }
    #[test] fn hermite_endpoints() {let mut d=[0.0,10.0,2.0,3.0,0.0];unsafe {telemetry_sample(d.as_mut_ptr(),1,0.0,1.0);}assert_eq!(d[4],0.0);unsafe {telemetry_sample(d.as_mut_ptr(),1,1.0,1.0);}assert_eq!(d[4],10.0);}
}
