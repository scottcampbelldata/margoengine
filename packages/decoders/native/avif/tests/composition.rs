//! Original BMFF derivations around an openly licensed standard coded sample.
use margoengine_avif::{
    Error,
    container::{File, Property},
    image::{Limits, decode},
};
fn bx(kind: &[u8; 4], bytes: &[u8]) -> Vec<u8> {
    let mut out = ((bytes.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend(bytes);
    out
}
fn full(kind: &[u8; 4], version: u8, bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![version, 0, 0, 0];
    out.extend(bytes);
    bx(kind, &out)
}
fn derived(grid: bool, cycle: bool, bad_pixi: bool) -> Vec<u8> {
    derived_obus(grid, cycle, bad_pixi, |_, _| {})
}
fn derived_obus(
    grid: bool,
    cycle: bool,
    bad_pixi: bool,
    rewrite: impl FnOnce(&mut Vec<u8>, &mut Vec<u8>),
) -> Vec<u8> {
    let original = include_bytes!("fixtures/white_1x1.avif");
    let file = File::parse(original).unwrap();
    let mut coded = file.item_data(file.primary, original.len()).unwrap();
    let mut config = file
        .item_properties(file.primary)
        .unwrap()
        .iter()
        .find_map(|p| {
            if let Property::Config(data) = p {
                Some(data.to_vec())
            } else {
                None
            }
        })
        .unwrap();
    rewrite(&mut coded, &mut config);
    let mut children = full(
        b"hdlr",
        0,
        &[
            0, 0, 0, 0, b'p', b'i', b'c', b't', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
    );
    children.extend(full(b"pitm", 0, &[0, 2]));
    let mut info = 2u16.to_be_bytes().to_vec();
    for (id, kind) in [
        (1u16, *b"av01"),
        (2, if grid { *b"grid" } else { *b"iden" }),
    ] {
        let mut bytes = id.to_be_bytes().to_vec();
        bytes.extend([0, 0]);
        bytes.extend(kind);
        bytes.push(0);
        info.extend(full(b"infe", 2, &bytes));
    }
    children.extend(full(b"iinf", 0, &info));
    let mut loc = vec![0x44, 0, 0, if grid { 2 } else { 1 }];
    for (id, offset, size) in [(1u16, 0u32, coded.len() as u32)]
        .into_iter()
        .chain(grid.then_some((2, coded.len() as u32, 8)))
    {
        loc.extend(id.to_be_bytes());
        loc.extend([0, 1, 0, 0, 0, 1]);
        loc.extend(offset.to_be_bytes());
        loc.extend(size.to_be_bytes());
    }
    children.extend(full(b"iloc", 1, &loc));
    let refs = if grid {
        vec![0, 2, 0, 2, 0, 1, 0, 1]
    } else {
        vec![0, 2, 0, 1, 0, if cycle { 2 } else { 1 }]
    };
    children.extend(full(b"iref", 0, &bx(b"dimg", &refs)));
    let mut props = full(b"ispe", 0, &[0, 0, 0, 1, 0, 0, 0, 1]);
    props.extend(bx(b"av1C", &config));
    props.extend(full(b"pixi", 0, &[3, if bad_pixi { 10 } else { 8 }, 8, 8]));
    let mut colr = b"nclx".to_vec();
    for property in file.item_properties(file.primary).unwrap() {
        if let Property::Color {
            primaries,
            transfer,
            matrix,
            full_range,
        } = property
        {
            colr.extend(primaries.to_be_bytes());
            colr.extend(transfer.to_be_bytes());
            colr.extend(matrix.to_be_bytes());
            colr.push(u8::from(*full_range) << 7);
        }
    }
    props.extend(bx(b"colr", &colr));
    props.extend(full(
        b"ispe",
        0,
        &[0, 0, 0, if grid { 2 } else { 1 }, 0, 0, 0, 1],
    ));
    let mut iprp = bx(b"ipco", &props);
    iprp.extend(full(
        b"ipma",
        0,
        &[0, 0, 0, 2, 0, 1, 4, 1, 0x82, 3, 4, 0, 2, 1, 5],
    ));
    children.extend(bx(b"iprp", &iprp));
    let mut data = coded;
    if grid {
        data.extend([0, 0, 0, 1, 0, 2, 0, 1]);
    }
    children.extend(bx(b"idat", &data));
    let mut out = bx(b"ftyp", b"mif1\0\0\0\0avif");
    out.extend(full(b"meta", 0, &children));
    out
}
const LIMITS: Limits = Limits {
    pixels: 1 << 26,
    memory: 512 << 20,
};
#[test]
fn final_item_obu_may_omit_size_but_config_obus_must_keep_it() {
    use margoengine_avif::{bits::leb128, obu::Obus};
    let expected = decode(&derived(false, false, false), LIMITS).unwrap();
    for extension in [false, true] {
        let bytes = derived_obus(false, false, false, |coded, _| {
            let mut at = 0;
            let mut last = 0;
            let mut size_at = 0;
            let mut payload_at = 0;
            while at < coded.len() {
                last = at;
                at += 1 + usize::from(coded[at] & 4 != 0);
                size_at = at;
                let size = leb128(coded, &mut at).unwrap() as usize;
                payload_at = at;
                at += size;
            }
            assert_eq!(at, coded.len());
            assert!(matches!((coded[last] >> 3) & 15, 4 | 6));
            coded.drain(size_at..payload_at);
            coded[last] &= !2;
            if extension {
                coded[last] |= 4;
                coded.insert(last + 1, 0);
            }
        });
        let actual = decode(&bytes, LIMITS).unwrap();
        assert_eq!(
            (actual.width, actual.height),
            (expected.width, expected.height)
        );
        assert_eq!(actual.rgba, expected.rgba);
    }
    for sized in [true, false] {
        let bytes = derived_obus(false, false, false, |coded, config| {
            let obus = Obus::new(coded)
                .collect::<margoengine_avif::Result<Vec<_>>>()
                .unwrap();
            let sequence = obus.iter().find(|obu| obu.kind == 1).unwrap();
            config.truncate(4);
            config.push(if sized { 0x0a } else { 0x08 });
            assert!(sequence.payload.len() < 128);
            if sized {
                config.push(sequence.payload.len() as u8);
            }
            config.extend(sequence.payload);
        });
        if sized {
            assert_eq!(decode(&bytes, LIMITS).unwrap().rgba, expected.rgba);
        } else {
            assert_eq!(decode(&bytes, LIMITS).err(), Some(Error::Invalid));
        }
    }
}
#[test]
fn payloadless_identity_and_shared_grid_items_compose() {
    let image = decode(&derived(false, false, false), LIMITS).unwrap();
    // The independently decoded standard sample contains Y=253, U=V=128, full range.
    assert_eq!((image.width, image.height), (1, 1));
    assert_eq!(image.rgba, [65021, 65021, 65021, 65535]);
    let image = decode(&derived(true, false, false), LIMITS).unwrap();
    assert_eq!((image.width, image.height), (2, 1));
    assert_eq!(
        image.rgba,
        [65021, 65021, 65021, 65535, 65021, 65021, 65021, 65535]
    );
}
#[test]
fn cycles_conflicting_pixel_depths_and_padded_workspace_limits_reject() {
    assert_eq!(
        decode(&derived(false, true, false), LIMITS).err(),
        Some(Error::Invalid)
    );
    assert_eq!(
        decode(&derived(false, false, true), LIMITS).err(),
        Some(Error::Invalid)
    );
    assert_eq!(
        decode(
            &derived(false, false, false),
            Limits {
                pixels: 100,
                memory: 1024 * 1024
            }
        )
        .err(),
        Some(Error::Limit)
    );
}
#[test]
fn reserved_obu_header_bits_preserve_item_and_config_pixels() {
    use margoengine_avif::bits::leb128;
    let expected = decode(&derived(false, false, false), LIMITS).unwrap();
    for add_extension in [false, true] {
        let bytes = derived_obus(false, false, false, |coded, config| {
            let mut rewritten = Vec::new();
            let mut at = 0;
            while at < coded.len() {
                let start = rewritten.len();
                let mut header = coded[at] | 1;
                at += 1;
                let kind = (header >> 3) & 15;
                let extension = if header & 4 != 0 {
                    let extension = coded[at] | 7;
                    at += 1;
                    Some(extension)
                } else if add_extension && matches!(kind, 3 | 4 | 6 | 7 | 15) {
                    header |= 4;
                    Some(7)
                } else {
                    None
                };
                rewritten.push(header);
                rewritten.extend(extension);
                let size_at = at;
                let size = leb128(coded, &mut at).unwrap() as usize;
                rewritten.extend(&coded[size_at..at + size]);
                at += size;
                if kind == 1 {
                    config.truncate(4);
                    config.extend(&rewritten[start..]);
                }
            }
            *coded = rewritten;
        });
        let actual = decode(&bytes, LIMITS).unwrap();
        assert_eq!(
            (actual.width, actual.height),
            (expected.width, expected.height)
        );
        assert_eq!(actual.rgba, expected.rgba);
    }
}
