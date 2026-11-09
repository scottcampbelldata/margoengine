use margoengine_draco::{Limits, decode};

fn num(data: &[u8], at: &mut usize) -> u32 {
    let value = u32::from_le_bytes(data[*at..*at + 4].try_into().unwrap());
    *at += 4;
    value
}
fn blob<'a>(data: &'a [u8], at: &mut usize) -> &'a [u8] {
    let count = num(data, at) as usize;
    let value = &data[*at..*at + count];
    *at += count;
    value
}

#[test]
fn metadata_long_value_preserves_the_following_geometry() {
    let g = decode(
        include_bytes!("fixtures/metadata-long.drc"),
        Limits::default(),
    )
    .unwrap();
    assert_eq!(g.points, 3);
    assert_eq!(g.attributes.len(), 1);
    assert_eq!(g.attributes[0].unique_id, 13);
    assert_eq!(
        g.attributes[0].data,
        [2.5_f32, -7.25, 11.125]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>()
    );
}

#[test]
fn metadata_names_binary_values_file_roots_and_deep_children_are_preserved() {
    let data = include_bytes!("fixtures/metadata.bin");
    let mut at = 0;
    let count = num(data, &mut at);
    assert_eq!(count, 41);
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let expected = blob(data, &mut at);
        let g = decode(input, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let mut pos = 8;
        assert_eq!(g.points, num(expected, &mut pos) as usize, "{name}");
        assert_eq!(num(expected, &mut pos), 0);
        assert_eq!(num(expected, &mut pos), 0);
        assert_eq!(num(expected, &mut pos), 1);
        assert_eq!(g.attributes.len(), 1);
        assert_eq!(expected[pos..pos + 4], [4, 9, 1, 0]);
        pos += 4;
        assert_eq!(g.attributes[0].unique_id, num(expected, &mut pos), "{name}");
        assert_eq!(g.attributes[0].data, blob(expected, &mut pos), "{name}");
        let metadata = g.metadata.unwrap();
        assert_eq!(num(expected, &mut pos), 0x4154_454d);
        assert_eq!(
            metadata.nodes.len(),
            num(expected, &mut pos) as usize,
            "{name}"
        );
        assert_eq!(
            metadata.attributes.len(),
            num(expected, &mut pos) as usize,
            "{name}"
        );
        assert_eq!(metadata.file, num(expected, &mut pos) as usize, "{name}");
        for (id, root) in metadata.attributes {
            assert_eq!(id, num(expected, &mut pos), "{name}");
            assert_eq!(root, num(expected, &mut pos) as usize, "{name}");
        }
        for node in metadata.nodes {
            assert_eq!(
                node.entries.len(),
                num(expected, &mut pos) as usize,
                "{name}"
            );
            assert_eq!(
                node.children.len(),
                num(expected, &mut pos) as usize,
                "{name}"
            );
            for entry in node.entries {
                assert_eq!(entry.key, blob(expected, &mut pos), "{name}");
                assert_eq!(entry.value, blob(expected, &mut pos), "{name}");
            }
            for (key, child) in node.children {
                assert_eq!(key, blob(expected, &mut pos), "{name}");
                assert_eq!(child, num(expected, &mut pos) as usize, "{name}");
            }
        }
        assert_eq!(pos, expected.len());
        if input.len() < 2048 {
            for end in 0..input.len() {
                assert!(
                    decode(&input[..end], Limits::default()).is_err(),
                    "{name}: prefix {end}"
                );
            }
        }
    }
    assert_eq!(at, data.len());
}
