//! HEIF 'prem' item references (ISO/IEC 23008-12 item reference type 'prem'; AVIF v1.1.0 section 4: from the colour
//! item to the one alpha auxiliary item it was premultiplied by). Derived from an openly licensed conformance sample.
use margoengine_avif::{
    Error,
    image::{Limits, decode},
};
const LIMITS: Limits = Limits {
    pixels: 1 << 26,
    memory: 512 << 20,
};
const SAMPLE: &[u8] = include_bytes!("fixtures/abc_color_irot_alpha_irot.avif");
fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}
fn put_u32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_be_bytes());
}
fn child(b: &[u8], start: usize, end: usize, kind: &[u8; 4]) -> usize {
    let mut at = start;
    while at < end {
        if &b[at + 4..at + 8] == kind {
            return at;
        }
        at += u32_at(b, at) as usize;
    }
    panic!("no {:?}", kind);
}
fn read(b: &[u8], at: &mut usize, size: usize) -> u64 {
    let v = b[*at..*at + size]
        .iter()
        .fold(0u64, |s, x| (s << 8) | *x as u64);
    *at += size;
    v
}
// Shift every absolute iloc offset at or past `from` by `by` (the sample stores items in an mdat after meta).
fn shift_iloc(b: &mut [u8], iloc: usize, from: u64, by: u64) {
    let version = b[iloc + 8];
    let mut at = iloc + 12;
    let sizes = read(b, &mut at, 1);
    let (offset, length) = ((sizes >> 4) as usize, (sizes & 15) as usize);
    let sizes = read(b, &mut at, 1);
    let (base, index) = (
        (sizes >> 4) as usize,
        if version > 0 {
            (sizes & 15) as usize
        } else {
            0
        },
    );
    let count = read(b, &mut at, if version < 2 { 2 } else { 4 });
    for _ in 0..count {
        at += if version < 2 { 2 } else { 4 };
        let method = if version > 0 {
            read(b, &mut at, 2) & 15
        } else {
            0
        };
        at += 2;
        let base_at = at;
        let base_value = read(b, &mut at, base);
        let patch = |b: &mut [u8], at: usize, size: usize, v: u64| {
            for i in 0..size {
                b[at + i] = ((v + by) >> (8 * (size - 1 - i))) as u8;
            }
        };
        if method == 0 && base > 0 && base_value >= from {
            patch(b, base_at, base, base_value);
        }
        let extents = read(b, &mut at, 2);
        for _ in 0..extents {
            at += index;
            let offset_at = at;
            let value = read(b, &mut at, offset);
            if method == 0 && base_value == 0 && offset > 0 && value >= from {
                patch(b, offset_at, offset, value);
            }
            at += length;
        }
    }
}
/// The sample with one more iref entry `kind` from the primary item to `to`; `rename_auxl` hides its alpha link.
fn with_reference(kind: &[u8; 4], to: &[u16], rename_auxl: bool) -> Vec<u8> {
    let mut b = SAMPLE.to_vec();
    let meta = child(&b, 0, b.len(), b"meta");
    let meta_end = meta + u32_at(&b, meta) as usize;
    let iref = child(&b, meta + 12, meta_end, b"iref");
    assert_eq!(b[iref + 8], 0, "the sample's iref uses 16-bit item ids");
    let pitm = child(&b, meta + 12, meta_end, b"pitm");
    let primary = u16::from_be_bytes([b[pitm + 12], b[pitm + 13]]);
    let mut entry = (12 + 2 * to.len() as u32).to_be_bytes().to_vec();
    entry.extend(kind);
    entry.extend(primary.to_be_bytes());
    entry.extend((to.len() as u16).to_be_bytes());
    for id in to {
        entry.extend(id.to_be_bytes());
    }
    let by = entry.len();
    let iref_end = iref + u32_at(&b, iref) as usize;
    if rename_auxl {
        let auxl = child(&b, iref + 12, iref_end, b"auxl");
        b[auxl + 4..auxl + 8].copy_from_slice(b"xaux");
    }
    let iloc = child(&b, meta + 12, meta_end, b"iloc");
    shift_iloc(&mut b, iloc, meta_end as u64, by as u64);
    b.splice(iref_end..iref_end, entry);
    let (iref_size, meta_size) = (u32_at(&b, iref), u32_at(&b, meta));
    put_u32(&mut b, iref, iref_size + by as u32);
    put_u32(&mut b, meta, meta_size + by as u32);
    b
}
fn alpha_id() -> u16 {
    let b = SAMPLE;
    let meta = child(b, 0, b.len(), b"meta");
    let end = meta + u32_at(b, meta) as usize;
    let iref = child(b, meta + 12, end, b"iref");
    let auxl = child(b, iref + 12, iref + u32_at(b, iref) as usize, b"auxl");
    u16::from_be_bytes([b[auxl + 8], b[auxl + 9]])
}
#[test]
fn a_prem_reference_to_the_one_alpha_item_decodes_premultiplied() {
    let straight = decode(SAMPLE, LIMITS).unwrap();
    // A harmless unknown reference type proves the rewrite keeps every item readable.
    assert_eq!(
        decode(&with_reference(b"xtra", &[alpha_id()], false), LIMITS)
            .unwrap()
            .rgba,
        straight.rgba
    );
    let premultiplied = decode(&with_reference(b"prem", &[alpha_id()], false), LIMITS).unwrap();
    assert_eq!(premultiplied.rgba.len(), straight.rgba.len());
    assert_ne!(premultiplied.rgba, straight.rgba);
}
#[test]
fn malformed_prem_references_reject_instead_of_reading_as_straight_alpha() {
    let alpha = alpha_id();
    let meta = child(SAMPLE, 0, SAMPLE.len(), b"meta");
    let pitm = child(
        SAMPLE,
        meta + 12,
        meta + u32_at(SAMPLE, meta) as usize,
        b"pitm",
    );
    let primary = u16::from_be_bytes([SAMPLE[pitm + 12], SAMPLE[pitm + 13]]);
    for (to, hide_alpha) in [
        (vec![alpha], true),           // no auxiliary alpha item
        (vec![alpha, alpha], false),   // several targets
        (vec![alpha, primary], false), // several targets
        (vec![primary], false),        // a target other than the alpha item
        (vec![], false),               // no target
    ] {
        assert_eq!(
            decode(&with_reference(b"prem", &to, hide_alpha), LIMITS).err(),
            Some(Error::Invalid),
            "prem to {to:?}, alpha hidden {hide_alpha}"
        );
    }
}
