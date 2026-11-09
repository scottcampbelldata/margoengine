//! Clean-room local WFC: indexed cardinality-entropy heap, bit domains, SIMD direction unions.
use core::arch::wasm32::*;
#[link(wasm_import_module = "progress")]
extern "C" { fn report(decisions: u32, updates: u32, intersections: u32, attempts: u32); }

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u32 {
    let data = vec![0u32; n].into_boxed_slice();
    Box::into_raw(data) as *mut u32
}
#[no_mangle]
pub unsafe extern "C" fn release(p: *mut u32, n: usize) {
    drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(p, n)));
}
fn mix(mut n: u32) -> u32 {
    n = (n ^ (n >> 16)).wrapping_mul(0x7feb352d);
    n = (n ^ (n >> 15)).wrapping_mul(0x846ca68b);
    n ^ (n >> 16)
}
struct Heap { cells: Vec<usize>, positions: Vec<usize>, counts: Vec<u32>, ties: Vec<u32> }
impl Heap {
    fn less(&self, a: usize, b: usize) -> bool {
        let key = |i| if self.counts[i] > 1 { self.counts[i] } else { u32::MAX };
        (key(a),self.ties[a],a) < (key(b),self.ties[b],b)
    }
    fn swap(&mut self, a: usize, b: usize) {
        self.cells.swap(a,b); self.positions[self.cells[a]]=a; self.positions[self.cells[b]]=b;
    }
    fn update(&mut self, i: usize, n: u32) {
        self.counts[i]=n;
        let mut p=self.positions[i];
        while p>0 { let parent=(p-1)/2; if !self.less(self.cells[p],self.cells[parent]) {break;} self.swap(p,parent);p=parent; }
        loop { let mut child=p*2+1; if child>=self.cells.len(){break;}
            if child+1<self.cells.len() && self.less(self.cells[child+1],self.cells[child]) {child+=1;}
            if !self.less(self.cells[child],self.cells[p]){break;}self.swap(p,child);p=child;
        }
    }
}

/// Input is allocated by alloc and validated by the TypeScript adapter. Header, 8 direction masks/tile, pins, output.
#[no_mangle]
pub unsafe extern "C" fn solve(p: *mut u32) -> u32 {
    let header=core::slice::from_raw_parts_mut(p,12);
    let (w,h,d,t)=(header[0] as usize,header[1] as usize,header[2] as usize,header[3] as usize);
    let c=w*h*d; let pin_count=header[6] as usize;
    let rules=core::slice::from_raw_parts(p.add(12),8*t);
    let pins=core::slice::from_raw_parts(p.add(12+8*t),2*pin_count);
    let output=core::slice::from_raw_parts_mut(p.add(12+8*t+2*pin_count),c);
    let full=if t==32{u32::MAX}else{(1u32<<t)-1};
    let mut state=header[4];
    let ties: Vec<u32>=(0..c).map(|i|mix(i as u32^header[11])).collect();
    let mut wave=vec![full;c];let mut queued=vec![false;c];let mut queue=Vec::with_capacity(c);
    let mut propagated=0u32;
    for attempt in 1..=header[5] {
        header[10]=attempt;
        let mut heap=Heap{cells:(0..c).collect(),positions:(0..c).collect(),counts:vec![0;c],ties:ties.clone()};
        wave.fill(full);queued.fill(true);queue.clear();
        for i in 0..c{heap.update(i,t as u32);header[8]+=1;queue.push(i);}
        let mut bad=false;
        for pin in pins.chunks_exact(2) {
            let i=pin[0] as usize;let mask=1u32<<pin[1];
            if wave[i]&mask==0{bad=true;break;}wave[i]=mask;heap.update(i,1);header[8]+=1;
        }
        loop {
            while !bad && !queue.is_empty() {
                propagated=propagated.wrapping_add(1);
                if propagated%1024==0 {report(header[7],header[8],header[9],header[10]);}
                let i=queue.pop().unwrap();queued[i]=false;
                let mut lo=u32x4_splat(0);let mut hi=u32x4_splat(0);let mut bits=wave[i];
                while bits!=0 {
                    let k=bits.trailing_zeros() as usize;bits&=bits-1;
                    lo=v128_or(lo,v128_load(rules.as_ptr().add(k*8) as *const v128));
                    hi=v128_or(hi,v128_load(rules.as_ptr().add(k*8+4) as *const v128));
                }
                let mut support=[0u32;8];v128_store(support.as_mut_ptr() as *mut v128,lo);v128_store(support.as_mut_ptr().add(4) as *mut v128,hi);
                let (x,y,z)=(i%w,(i/w)%h,i/(w*h));
                for (direction,valid,j) in [(0,x+1<w,i+1),(1,x>0,i.wrapping_sub(1)),(2,y+1<h,i+w),(3,y>0,i.wrapping_sub(w)),(4,z+1<d,i+w*h),(5,z>0,i.wrapping_sub(w*h))] {
                    if !valid{continue;}header[9]+=1;
                    let next=wave[j]&support[direction];
                    if next!=wave[j] {
                        wave[j]=next;heap.update(j,next.count_ones());header[8]+=1;
                        if !queued[j]{queued[j]=true;queue.push(j);}
                        if next==0{bad=true;break;}
                    }
                }
            }
            if bad{break;}
            let cell=heap.cells[0];
            if heap.counts[cell]<=1 {for i in 0..c{output[i]=wave[i].trailing_zeros();}return 1;}
            state^=state<<13;state^=state>>17;state^=state<<5;
            let mut choice=state as f64/4294967296.0*heap.counts[cell] as f64;
            let mut bits=wave[cell];let mut tile=0;
            while bits!=0 {tile=bits.trailing_zeros();bits&=bits-1;choice-=1.0;if choice<=0.0{break;}}
            wave[cell]=1u32<<tile;heap.update(cell,1);header[8]+=1;header[7]+=1;
            if header[7]%256==0 {report(header[7],header[8],header[9],header[10]);}
            if !queued[cell]{queued[cell]=true;queue.push(cell);}
        }
    }
    0
}
