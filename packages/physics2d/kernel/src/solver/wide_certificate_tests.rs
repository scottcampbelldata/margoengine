// Controls retain the pre-trim certificate equations from own commit b09e80290.
// Inputs to each comparison are derived through the actual caller expressions below.
fn original_block_certificate(
    c: &Block, gaps: [F4; 2], biased: bool, max_push: F4, spring: (F4,F4,F4),
    bias: [F4; 2], intermediates: [F4; 5], answer: [F4; 2],
) -> M4 {
    let mut mask = c.live.and(finite(&intermediates)).and(finite(&answer))
        .and(finite(&[c.k11,c.k12,c.k22]));
    for i in 0..2 {
        mask=certify_potential(mask,if i==0 {c.k11}else{c.k22},gaps[i],biased,bias[i],spring.1,spring.2,answer[i],max_push);
    }
    mask
}
fn original_row_certificate(
    c: &Block, i: usize, gap: F4, biased: bool, max_push: F4,
    ms: F4, is: F4, values: [F4; 6],
) -> M4 {
    let kii=if i==0 {c.k11}else{c.k22};
    let mask=c.live.and(finite(&values)).and(finite(&[kii])).and(kii.ge(F4::splat(0.0)));
    certify_potential(mask,kii,gap,biased,values[0],ms,is,values[5],max_push)
}

const CERTIFICATE_EDGE_BITS: [u32; 22] = [
    0,0x80000000,1,0x80000001,0x007fffff,0x807fffff,0x00800000,0x80800000,
    0x3e000000,0xbe000000,0x3f800000,0xbf800000,0x40000000,0xc0000000,
    0x7f7fffff,0xff7fffff,0x7f800000,0xff800000,0x7fc00000,0xffc12345,
    0x7f800001,0xff800001,
];
fn certificate_sample(seed: &mut u32, case: usize, slot: usize) -> F4 {
    F4::new(core::array::from_fn(|lane| {
        *seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let bits=if case<4096 {CERTIFICATE_EDGE_BITS[(case+slot*7+lane*3)%CERTIFICATE_EDGE_BITS.len()]}
            else if case%3==0 { *seed } else {(*seed & 0x807fffff)|0x3f000000};
        f32::from_bits(bits)
    }))
}

#[test]
fn removed_block_finite_checks_preserve_masks_for_exact_caller_intermediates() {
    let mut seed=0x43525442;
    let (zero,cap,inv_h)=(F4::splat(0.0),F4::splat(3.0),F4::splat(240.0));
    let mut accepted=0;
    let mut rejected=0;
    for case in 0..32768 {
        let mut c=block(&[constraint(1.0,2,true,[0.0;2]);4]);
        c.live=M4::from_bits((case%15+1) as u32);
        c.k11=certificate_sample(&mut seed,case,0);
        c.k12=certificate_sample(&mut seed,case,1);
        c.k22=certificate_sample(&mut seed,case,2);
        let gaps=[certificate_sample(&mut seed,case,3),certificate_sample(&mut seed,case,4)];
        let spring=(certificate_sample(&mut seed,case,5),certificate_sample(&mut seed,case,6),certificate_sample(&mut seed,case,7));
        let ratio=spring.2/spring.1;
        for biased in [false,true] {
            let closed=|s:F4| if biased {F4::select(s.gt(zero),zero,ratio)}else{zero};
            let m11=c.k11+c.k11*closed(gaps[0]);
            let m22=c.k22+c.k22*closed(gaps[1]);
            let det=m11*m22-c.k12*c.k12;
            let bias=[row(spring,gaps[0],biased,inv_h,cap).0,row(spring,gaps[1],biased,inv_h,cap).0];
            let (l1,l2)=(certificate_sample(&mut seed,case,8),certificate_sample(&mut seed,case,9));
            let (v1,v2)=(certificate_sample(&mut seed,case,10),certificate_sample(&mut seed,case,11));
            let r1=c.k11*l1+c.k12*l2-v1-bias[0];
            let r2=c.k12*l1+c.k22*l2-v2-bias[1];
            let all=[(m22*r1-c.k12*r2)/det,(m11*r2-c.k12*r1)/det];
            // All four actual LCP answer shapes, including single-row and zero selections.
            for answer in [all,[r1/m11,zero],[zero,r2/m22],[zero,zero]] {
                let intermediates=[m11,m22,det,r1,r2];
                let old=original_block_certificate(&c,gaps,biased,cap,spring,bias,intermediates,answer).bits();
                let new=certify_block(&c,gaps,biased,cap,spring,bias,intermediates,answer).bits();
                assert_eq!(new,old,"case{case}, biased{biased}");
                accepted+=old.count_ones();
                rejected+=(c.live.bits() & !old).count_ones();
            }
        }
    }
    assert!(accepted>1000 && rejected>1000,"nonvacuous masks accepted{accepted} rejected{rejected}");
}

#[test]
fn removed_row_finite_checks_preserve_masks_for_exact_caller_values() {
    let mut seed=0x43525452;
    let (zero,cap,inv_h)=(F4::splat(0.0),F4::splat(3.0),F4::splat(240.0));
    let mut accepted=0;
    let mut rejected=0;
    for case in 0..32768 {
        let mut c=block(&[constraint(1.0,2,false,[0.0;2]);4]);
        c.live=M4::from_bits((case%15+1) as u32);
        c.k11=certificate_sample(&mut seed,case,0);
        c.k22=certificate_sample(&mut seed,case,1);
        let gap=certificate_sample(&mut seed,case,2);
        let spring=(certificate_sample(&mut seed,case,3),certificate_sample(&mut seed,case,4),certificate_sample(&mut seed,case,5));
        let vn=certificate_sample(&mut seed,case,6);
        let normal_mass=certificate_sample(&mut seed,case,7);
        let old=certificate_sample(&mut seed,case,8);
        for biased in [false,true] {
            let (bias,ms,is)=row(spring,gap,biased,inv_h,cap);
            let impulse=-normal_mass*ms*(vn+bias)-is*old;
            let sum=old+impulse;
            let total=F4::select(sum.gt(zero),sum,zero);
            let values=[bias,vn,normal_mass,impulse,sum,total];
            for i in 0..2 {
                let before=original_row_certificate(&c,i,gap,biased,cap,ms,is,values).bits();
                let after=certify_row(&c,i,gap,biased,cap,ms,is,values).bits();
                assert_eq!(after,before,"case{case}, biased{biased}, point{i}");
                accepted+=before.count_ones();
                rejected+=(c.live.bits() & !before).count_ones();
            }
        }
    }
    assert!(accepted>1000 && rejected>1000,"nonvacuous masks accepted{accepted} rejected{rejected}");
}

#[test]
fn reduced_row_certificate_retains_sum_raw_diagonal_and_used_soft_domain_guards() {
    let mut c=block(&[constraint(1.0,2,false,[0.0;2]);4]);
    c.k11=F4::new([1.0,f32::INFINITY,1.0,1.0]);
    let gap=F4::new([0.0,0.0,0.0,0.01]);
    let zero=F4::splat(0.0);
    let cap=F4::splat(3.0);
    let spring=(zero,F4::new([1.0,1.0,0.0,f32::NAN]),F4::new([0.0,0.0,0.0,f32::NAN]));
    let (bias,ms,is)=row(spring,gap,true,F4::splat(240.0),cap);
    let vn=F4::new([-1.0,0.0,0.0,0.0]);
    let normal_mass=F4::new([f32::MAX,0.0,1.0,1.0]);
    let old=F4::new([f32::MAX,0.0,0.0,0.0]);
    let impulse=-normal_mass*ms*(vn+bias)-is*old;
    let sum=old+impulse;
    let total=F4::select(sum.gt(zero),sum,zero);
    let values=[bias,vn,normal_mass,impulse,sum,total];
    assert!(impulse.get().iter().all(|x|x.is_finite()));
    assert!(!sum.get()[0].is_finite(),"finite old and impulse overflow when added");
    let old=original_row_certificate(&c,0,gap,true,cap,ms,is,values).bits();
    let new=certify_row(&c,0,gap,true,cap,ms,is,values).bits();
    assert_eq!(new,old);
    assert_eq!(new,8,"overflow sum, raw infinite K and used invalid soft domain refuse; unused open NaN spring stays admissible");
}
