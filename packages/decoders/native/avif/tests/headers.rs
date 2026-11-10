use margoengine_avif::bits::Bits;
use margoengine_avif::container::{File, Property};
use margoengine_avif::frame::Frame;
use margoengine_avif::obu::Obus;
use margoengine_avif::reconstruct::Reconstruction;
use margoengine_avif::sequence::Sequence;
use margoengine_avif::{Error, Result};

const FILES: &[(&str, &[u8], u32, u32, u32, bool, bool, bool)] = &[
    (
        "8bit420",
        include_bytes!("fixtures/fox.profile0.8bpc.yuv420.avif"),
        1204,
        800,
        8,
        true,
        true,
        false,
    ),
    (
        "10bit420",
        include_bytes!("fixtures/fox.profile0.10bpc.yuv420.avif"),
        1204,
        800,
        10,
        true,
        true,
        false,
    ),
    (
        "8bit444",
        include_bytes!("fixtures/fox.profile1.8bpc.yuv444.avif"),
        1204,
        800,
        8,
        false,
        false,
        false,
    ),
    (
        "10bit422",
        include_bytes!("fixtures/fox.profile2.10bpc.yuv422.avif"),
        1204,
        800,
        10,
        true,
        false,
        false,
    ),
    (
        "12bit444",
        include_bytes!("fixtures/fox.profile2.12bpc.yuv444.avif"),
        1204,
        800,
        12,
        false,
        false,
        false,
    ),
    (
        "12bitmono-odd",
        include_bytes!("fixtures/fox.profile2.12bpc.yuv420.monochrome.odd-width.odd-height.avif"),
        1203,
        799,
        12,
        true,
        true,
        true,
    ),
    (
        "transformed",
        include_bytes!("fixtures/kimono.mirror-vertical.rotate270.crop.avif"),
        1024,
        722,
        8,
        true,
        true,
        false,
    ),
];

#[test]
fn independent_avif_conformance_item_and_intra_headers() {
    for (name, data, width, height, depth, sub_x, sub_y, mono) in FILES {
        let file = File::parse(data).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(file.items[&file.primary].kind, *b"av01");
        let properties = file.item_properties(file.primary).unwrap();
        assert!(properties.iter().any(|p| matches!(p, Property::Spatial { width:w, height:h } if w == width && h == height)), "{name}");
        let bytes = file.item_data(file.primary, data.len()).unwrap();
        let mut sequence = None;
        let mut frame = None;
        let mut next_tile = 0;
        for obu in Obus::new(&bytes) {
            let obu = obu.unwrap();
            match obu.kind {
                1 => {
                    assert!(sequence.is_none());
                    let seq = Sequence::parse(obu.payload)
                        .unwrap_or_else(|e| panic!("{name} seq: {e:?}"));
                    assert!(seq.reduced && seq.still_picture);
                    assert_eq!(
                        (
                            seq.color.depth,
                            seq.color.sub_x,
                            seq.color.sub_y,
                            seq.color.monochrome
                        ),
                        (*depth, *sub_x, *sub_y, *mono)
                    );
                    sequence = Some(seq);
                }
                3 | 6 => {
                    let seq = sequence.as_ref().unwrap();
                    let mut b = Bits::new(obu.payload);
                    let parsed =
                        Frame::parse(&mut b, seq, obu.temporal_id, obu.spatial_id, 1 << 26)
                            .unwrap_or_else(|e| panic!("{name} frame: {e:?}"));
                    assert_eq!(
                        (parsed.upscaled_width, parsed.height),
                        (*width, *height),
                        "{name}"
                    );
                    if obu.kind == 3 {
                        b.trailing().unwrap();
                    } else {
                        b.align().unwrap();
                        let group = parsed
                            .tiles
                            .group(&obu.payload[b.position() / 8..], 0)
                            .unwrap();
                        next_tile = group.len();
                    }
                    frame = Some(parsed);
                }
                4 => {
                    let group = frame
                        .as_ref()
                        .unwrap()
                        .tiles
                        .group(obu.payload, next_tile)
                        .unwrap();
                    next_tile += group.len();
                }
                _ => {}
            }
        }
        let frame = frame.unwrap();
        assert_eq!(
            next_tile,
            (frame.tiles.columns.len() - 1) * (frame.tiles.rows.len() - 1)
        );
    }
}

#[test]
fn conformance_headers_reject_truncated_prefixes_without_panics() {
    for (name, bytes, ..) in FILES {
        for length in 0..bytes.len().min(512) {
            let result = std::panic::catch_unwind(|| File::parse(&bytes[..length]));
            assert!(result.is_ok(), "{name} at {length}");
            assert!(
                result.unwrap().is_err(),
                "{name} accepted truncated file at {length}"
            );
        }
        let file = File::parse(bytes).unwrap();
        let stream = file.item_data(file.primary, bytes.len()).unwrap();
        let obus = Obus::new(&stream).collect::<Result<Vec<_>>>().unwrap();
        let seq_obu = obus.iter().find(|o| o.kind == 1).unwrap();
        for length in 0..seq_obu.payload.len() {
            assert!(
                Sequence::parse(&seq_obu.payload[..length]).is_err(),
                "{name} sequence prefix {length}"
            );
        }
        assert_eq!(file.item_data(file.primary, 1), Err(Error::Limit));
    }
}

#[test]
fn header_pixel_limit_is_checked_before_image_allocation() {
    let file = File::parse(FILES[0].1).unwrap();
    let stream = file.item_data(file.primary, FILES[0].1.len()).unwrap();
    let obus = Obus::new(&stream).collect::<Result<Vec<_>>>().unwrap();
    let sequence = Sequence::parse(obus.iter().find(|o| o.kind == 1).unwrap().payload).unwrap();
    let frame = obus.iter().find(|o| o.kind == 3 || o.kind == 6).unwrap();
    assert!(matches!(
        Frame::parse(&mut Bits::new(frame.payload), &sequence, 0, 0, 1),
        Err(Error::Limit)
    ));
}

#[test]
fn conformance_intra_tiles_consume_their_exact_entropy_payloads() {
    for (name, data, ..) in FILES {
        let file = File::parse(data).unwrap();
        let bytes = file.item_data(file.primary, data.len()).unwrap();
        let mut sequence = None;
        let mut frame = None;
        let mut output = None;
        let mut next = 0;
        for obu in Obus::new(&bytes) {
            let obu = obu.unwrap();
            match obu.kind {
                1 => sequence = Some(Sequence::parse(obu.payload).unwrap()),
                3 | 6 => {
                    let seq = sequence.as_ref().unwrap();
                    let mut b = Bits::new(obu.payload);
                    let header =
                        Frame::parse(&mut b, seq, obu.temporal_id, obu.spatial_id, 1 << 26)
                            .unwrap();
                    let mut reconstructed = Reconstruction::new(seq, &header);
                    if obu.kind == 6 {
                        b.align().unwrap();
                        for (id, data) in header
                            .tiles
                            .group(&obu.payload[b.position() / 8..], next)
                            .unwrap()
                        {
                            reconstructed
                                .tile(seq, &header, id, data)
                                .unwrap_or_else(|e| panic!("{name} tile {id}: {e:?}"));
                            next += 1;
                        }
                    }
                    frame = Some(header);
                    output = Some(reconstructed);
                }
                4 => {
                    let seq = sequence.as_ref().unwrap();
                    let header = frame.as_ref().unwrap();
                    for (id, data) in header.tiles.group(obu.payload, next).unwrap() {
                        output
                            .as_mut()
                            .unwrap()
                            .tile(seq, header, id, data)
                            .unwrap_or_else(|e| panic!("{name} tile {id}: {e:?}"));
                        next += 1;
                    }
                }
                _ => {}
            }
        }
        assert!(next > 0);
    }
}
