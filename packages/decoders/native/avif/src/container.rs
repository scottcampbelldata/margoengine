//! Bounded AVIF item demultiplexing, from AVIF 1.2, HEIF and ISO/IEC 14496-12.
use crate::{Error, Result};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug)]
pub struct BoxRef<'a> {
    pub kind: [u8; 4],
    pub data: &'a [u8],
}
#[derive(Clone)]
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(size).ok_or(Error::Limit)?;
        let out = self.data.get(self.at..end).ok_or(Error::Truncated)?;
        self.at = end;
        Ok(out)
    }
    fn uint(&mut self, size: usize) -> Result<u64> {
        if size > 8 {
            return Err(Error::Invalid);
        }
        Ok(self
            .take(size)?
            .iter()
            .fold(0, |n, byte| n * 256 + *byte as u64))
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.uint(1)? as u8)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(self.uint(2)? as u16)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(self.uint(4)? as u32)
    }
    fn fourcc(&mut self) -> Result<[u8; 4]> {
        Ok(self.take(4)?.try_into().unwrap())
    }
    fn full(&mut self) -> Result<(u8, u32)> {
        Ok((self.u8()?, self.uint(3)? as u32))
    }
    fn string(&mut self) -> Result<&'a [u8]> {
        let length = self.data[self.at..]
            .iter()
            .position(|v| *v == 0)
            .ok_or(Error::Truncated)?;
        let out = self.take(length)?;
        self.take(1)?;
        Ok(out)
    }
    fn finish(&self) -> Result<()> {
        if self.at == self.data.len() {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
    fn rest(&self) -> &'a [u8] {
        &self.data[self.at..]
    }
    fn boxed(&mut self) -> Result<BoxRef<'a>> {
        let available = self.data.len() - self.at;
        let mut size = self.uint(4)?;
        let kind = self.fourcc()?;
        let header = if size == 1 {
            size = self.uint(8)?;
            16
        } else {
            8
        };
        if size == 0 {
            size = available as u64;
        }
        if size < header {
            return Err(Error::Invalid);
        }
        let length = usize::try_from(size - header).map_err(|_| Error::Limit)?;
        Ok(BoxRef {
            kind,
            data: self.take(length)?,
        })
    }
}
pub fn boxes(data: &[u8]) -> Result<Vec<BoxRef<'_>>> {
    let mut cursor = Cursor::new(data);
    let mut out = Vec::new();
    while !cursor.rest().is_empty() {
        out.push(cursor.boxed()?);
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub enum Property<'a> {
    Spatial {
        width: u32,
        height: u32,
    },
    Config(&'a [u8]),
    Pixels(Vec<u8>),
    Auxiliary(&'a [u8]),
    Color {
        primaries: u16,
        transfer: u16,
        matrix: u16,
        full_range: bool,
    },
    Icc(&'a [u8]),
    Aperture([u32; 8]),
    Rotation(u8),
    Mirror(u8),
    OperatingPoint(u8),
    Layer(u16),
    Metadata,
    Unknown([u8; 4]),
}
impl<'a> Property<'a> {
    fn parse(value: BoxRef<'a>) -> Result<Self> {
        let mut c = Cursor::new(value.data);
        let property = match &value.kind {
            b"ispe" => {
                if c.full()? != (0, 0) {
                    return Err(Error::Invalid);
                }
                let width = c.u32()?;
                let height = c.u32()?;
                if width == 0 || height == 0 {
                    return Err(Error::Invalid);
                }
                Self::Spatial { width, height }
            }
            b"av1C" => {
                if c.u8()? != 0x81 {
                    return Err(Error::Invalid);
                }
                let profile_level = c.u8()?;
                let config = c.u8()?;
                let delay = c.u8()?;
                if profile_level >> 5 > 2
                    || delay & 0xe0 != 0
                    || (delay & 0x10 == 0 && delay & 15 != 0)
                    || (config & 0x20 != 0 && config & 0x40 == 0)
                {
                    return Err(Error::Invalid);
                }
                return Ok(Self::Config(value.data));
            }
            b"pixi" => {
                if c.full()? != (0, 0) {
                    return Err(Error::Invalid);
                }
                let count = c.u8()? as usize;
                if count == 0 {
                    return Err(Error::Invalid);
                }
                Self::Pixels(c.take(count)?.to_vec())
            }
            b"auxC" => {
                if c.full()? != (0, 0) {
                    return Err(Error::Invalid);
                }
                return Ok(Self::Auxiliary(c.string()?));
            }
            b"colr" => match &c.fourcc()? {
                b"nclx" => {
                    let primaries = c.u16()?;
                    let transfer = c.u16()?;
                    let matrix = c.u16()?;
                    let range = c.u8()?;
                    if range & 127 != 0 {
                        return Err(Error::Invalid);
                    }
                    Self::Color {
                        primaries,
                        transfer,
                        matrix,
                        full_range: range & 128 != 0,
                    }
                }
                b"rICC" | b"prof" => return Ok(Self::Icc(c.rest())),
                _ => return Ok(Self::Unknown(value.kind)),
            },
            b"clap" => {
                let mut values = [0; 8];
                for n in &mut values {
                    *n = c.u32()?;
                }
                if [1, 3, 5, 7].iter().any(|i| values[*i] == 0) {
                    return Err(Error::Invalid);
                }
                Self::Aperture(values)
            }
            b"irot" => {
                let angle = c.u8()?;
                if angle > 3 {
                    return Err(Error::Invalid);
                }
                Self::Rotation(angle)
            }
            b"imir" => {
                let axis = c.u8()?;
                if axis > 1 {
                    return Err(Error::Invalid);
                }
                Self::Mirror(axis)
            }
            b"a1op" => {
                let point = c.u8()?;
                if point > 31 {
                    return Err(Error::Invalid);
                }
                Self::OperatingPoint(point)
            }
            b"lsel" => {
                let layer = c.u16()?;
                if layer > 3 && layer != 65535 {
                    return Err(Error::Invalid);
                }
                Self::Layer(layer)
            }
            b"pasp" => {
                if c.u32()? != c.u32()? {
                    return Err(Error::Unsupported);
                }
                Self::Metadata
            }
            // Descriptive metadata does not alter still-image reconstruction.
            b"clli" | b"mdcv" | b"cclv" | b"amve" | b"a1lx" => return Ok(Self::Metadata),
            _ => return Ok(Self::Unknown(value.kind)),
        };
        c.finish()?;
        Ok(property)
    }
}
#[derive(Clone, Debug)]
pub struct Item {
    pub kind: [u8; 4],
    pub hidden: bool,
    pub protected: bool,
    /// 1-based index into the property container, and its essential bit.
    pub properties: Vec<(usize, bool)>,
    pub references: BTreeMap<[u8; 4], Vec<u32>>,
}
#[derive(Clone, Debug)]
struct Location {
    method: u16,
    reference: u16,
    base: u64,
    extents: Vec<(u64, u64, u64)>,
}
pub struct File<'a> {
    data: &'a [u8],
    idat: Option<&'a [u8]>,
    pub primary: u32,
    pub items: BTreeMap<u32, Item>,
    pub properties: Vec<Property<'a>>,
    locations: BTreeMap<u32, Location>,
}
impl<'a> File<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self> {
        let top = boxes(data)?;
        let ftyp = single(&top, b"ftyp")?.ok_or(Error::Invalid)?;
        let mut brand = Cursor::new(ftyp.data);
        let major = brand.fourcc()?;
        brand.u32()?;
        let mut avif = major == *b"avif";
        while !brand.rest().is_empty() {
            avif |= brand.fourcc()? == *b"avif";
        }
        if !avif {
            return Err(Error::Unsupported);
        }
        let meta = single(&top, b"meta")?.ok_or(Error::Invalid)?;
        let mut meta_data = Cursor::new(meta.data);
        if meta_data.full()? != (0, 0) {
            return Err(Error::Invalid);
        }
        let children = boxes(meta_data.rest())?;
        let pitm = single(&children, b"pitm")?.ok_or(Error::Invalid)?;
        let mut primary_data = Cursor::new(pitm.data);
        let (version, flags) = primary_data.full()?;
        if version > 1 || flags != 0 {
            return Err(Error::Invalid);
        }
        let primary = primary_data.uint(if version == 0 { 2 } else { 4 })? as u32;
        primary_data.finish()?;
        let mut file = Self {
            data,
            idat: single(&children, b"idat")?.map(|v| v.data),
            primary,
            items: BTreeMap::new(),
            properties: Vec::new(),
            locations: BTreeMap::new(),
        };
        file.infos(single(&children, b"iinf")?.ok_or(Error::Invalid)?.data)?;
        file.locations(single(&children, b"iloc")?.ok_or(Error::Invalid)?.data)?;
        if let Some(value) = single(&children, b"iref")? {
            file.references(value.data)?;
        }
        let iprp = single(&children, b"iprp")?.ok_or(Error::Invalid)?;
        let iprp_children = boxes(iprp.data)?;
        let ipco = single(&iprp_children, b"ipco")?.ok_or(Error::Invalid)?;
        for property in boxes(ipco.data)? {
            file.properties.push(Property::parse(property)?);
        }
        for association in iprp_children.iter().filter(|value| value.kind == *b"ipma") {
            file.associations(association.data)?;
        }
        if primary == 0 || !file.items.contains_key(&primary) {
            return Err(Error::Invalid);
        }
        for location in file.locations.values() {
            if location.reference != 0 {
                return Err(Error::Unsupported);
            }
            let size = match location.method {
                0 => data.len(),
                1 => file.idat.ok_or(Error::Invalid)?.len(),
                _ => continue,
            } as u64;
            for (_, offset, length) in &location.extents {
                let start = location.base.checked_add(*offset).ok_or(Error::Limit)?;
                let end = start.checked_add(*length).ok_or(Error::Limit)?;
                if start > size || end > size {
                    return Err(Error::Truncated);
                }
            }
        }
        Ok(file)
    }
    fn infos(&mut self, data: &[u8]) -> Result<()> {
        let mut c = Cursor::new(data);
        let (version, flags) = c.full()?;
        if version > 1 || flags != 0 {
            return Err(Error::Invalid);
        }
        let count = c.uint(if version == 0 { 2 } else { 4 })?;
        let infos = boxes(c.rest())?;
        if count != infos.len() as u64 {
            return Err(Error::Invalid);
        }
        for value in infos {
            if value.kind != *b"infe" {
                return Err(Error::Invalid);
            }
            let mut c = Cursor::new(value.data);
            let (version, flags) = c.full()?;
            if !(2..=3).contains(&version) || flags & !1 != 0 {
                return Err(Error::Unsupported);
            }
            let id = c.uint(if version == 2 { 2 } else { 4 })? as u32;
            let protected = c.u16()? != 0;
            let kind = c.fourcc()?;
            c.string()?;
            if id == 0
                || self
                    .items
                    .insert(
                        id,
                        Item {
                            kind,
                            hidden: flags & 1 != 0,
                            protected,
                            properties: Vec::new(),
                            references: BTreeMap::new(),
                        },
                    )
                    .is_some()
            {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
    fn locations(&mut self, data: &[u8]) -> Result<()> {
        let mut c = Cursor::new(data);
        let (version, flags) = c.full()?;
        if version > 2 || flags != 0 {
            return Err(Error::Invalid);
        }
        let sizes = c.u8()?;
        let offset_size = (sizes >> 4) as usize;
        let length_size = (sizes & 15) as usize;
        let sizes = c.u8()?;
        let base_size = (sizes >> 4) as usize;
        let index_size = if version > 0 {
            (sizes & 15) as usize
        } else {
            0
        };
        if [offset_size, length_size, base_size, index_size]
            .iter()
            .any(|size| ![0, 4, 8].contains(size))
        {
            return Err(Error::Invalid);
        }
        let count = c.uint(if version < 2 { 2 } else { 4 })?;
        for _ in 0..count {
            let id = c.uint(if version < 2 { 2 } else { 4 })? as u32;
            let method = if version > 0 { c.u16()? } else { 0 };
            if method > 2 {
                return Err(Error::Invalid);
            }
            let reference = c.u16()?;
            let base = c.uint(base_size)?;
            let count = c.u16()?;
            let mut extents = Vec::new();
            for _ in 0..count {
                extents.push((
                    c.uint(index_size)?,
                    c.uint(offset_size)?,
                    c.uint(length_size)?,
                ));
            }
            if !self.items.contains_key(&id)
                || self
                    .locations
                    .insert(
                        id,
                        Location {
                            method,
                            reference,
                            base,
                            extents,
                        },
                    )
                    .is_some()
            {
                return Err(Error::Invalid);
            }
        }
        c.finish()
    }
    fn references(&mut self, data: &[u8]) -> Result<()> {
        let mut c = Cursor::new(data);
        let (version, flags) = c.full()?;
        if version > 1 || flags != 0 {
            return Err(Error::Invalid);
        }
        let id_size = if version == 0 { 2 } else { 4 };
        for value in boxes(c.rest())? {
            let mut r = Cursor::new(value.data);
            let from = r.uint(id_size)? as u32;
            let count = r.u16()?;
            let mut to = Vec::new();
            for _ in 0..count {
                let target = r.uint(id_size)? as u32;
                if !self.items.contains_key(&target) {
                    return Err(Error::Invalid);
                }
                to.push(target);
            }
            r.finish()?;
            let item = self.items.get_mut(&from).ok_or(Error::Invalid)?;
            if item.references.insert(value.kind, to).is_some() {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
    fn associations(&mut self, data: &[u8]) -> Result<()> {
        let mut c = Cursor::new(data);
        let (version, flags) = c.full()?;
        if version > 1 || flags & !1 != 0 {
            return Err(Error::Invalid);
        }
        let count = c.u32()?;
        for _ in 0..count {
            let id = c.uint(if version == 0 { 2 } else { 4 })? as u32;
            let count = c.u8()?;
            let item = self.items.get_mut(&id).ok_or(Error::Invalid)?;
            for _ in 0..count {
                let raw = c.uint(if flags == 0 { 1 } else { 2 })?;
                let essential = 1 << if flags == 0 { 7 } else { 15 };
                let index = (raw & (essential - 1)) as usize;
                if index > self.properties.len() {
                    return Err(Error::Invalid);
                }
                if index > 0 {
                    if item
                        .properties
                        .iter()
                        .any(|(previous, _)| *previous == index)
                    {
                        return Err(Error::Invalid);
                    }
                    item.properties.push((index, raw & essential != 0));
                }
            }
        }
        c.finish()
    }
    pub fn item_properties(&self, id: u32) -> Result<Vec<&Property<'a>>> {
        let item = self.items.get(&id).ok_or(Error::Invalid)?;
        if item.protected {
            return Err(Error::Unsupported);
        }
        let mut properties = Vec::new();
        for (index, essential) in &item.properties {
            let property = &self.properties[index - 1];
            if *essential && matches!(property, Property::Unknown(_)) {
                return Err(Error::Unsupported);
            }
            properties.push(property);
        }
        Ok(properties)
    }
    /// Resolve file/idat/item-relative extents. Cycles and repeated materialization are bounded.
    pub fn item_data(&self, id: u32, max_bytes: usize) -> Result<Vec<u8>> {
        // An identity derivation has no payload and does not require an iloc entry (HEIF).
        if self
            .items
            .get(&id)
            .is_some_and(|item| item.kind == *b"iden")
            && !self.locations.contains_key(&id)
        {
            return Ok(Vec::new());
        }
        let mut budget = max_bytes;
        self.materialize(id, &mut Vec::new(), &mut budget)
    }
    fn materialize(&self, id: u32, path: &mut Vec<u32>, budget: &mut usize) -> Result<Vec<u8>> {
        if path.contains(&id) || path.len() >= 32 {
            return Err(Error::Invalid);
        }
        let location = self.locations.get(&id).ok_or(Error::Invalid)?;
        if location.reference != 0 {
            return Err(Error::Unsupported);
        }
        path.push(id);
        let mut out = Vec::new();
        for (index, offset, length) in &location.extents {
            let relative;
            let source = match location.method {
                0 => self.data,
                1 => self.idat.ok_or(Error::Invalid)?,
                2 => {
                    let targets = self
                        .items
                        .get(&id)
                        .and_then(|item| item.references.get(b"iloc"))
                        .ok_or(Error::Invalid)?;
                    let target = if *index == 0 { 1 } else { *index };
                    let target = targets
                        .get(usize::try_from(target - 1).map_err(|_| Error::Limit)?)
                        .ok_or(Error::Invalid)?;
                    relative = self.materialize(*target, path, budget)?;
                    &relative
                }
                _ => return Err(Error::Invalid),
            };
            let start = usize::try_from(location.base.checked_add(*offset).ok_or(Error::Limit)?)
                .map_err(|_| Error::Limit)?;
            let size = if *length == 0 {
                source.len().checked_sub(start).ok_or(Error::Truncated)?
            } else {
                usize::try_from(*length).map_err(|_| Error::Limit)?
            };
            let end = start.checked_add(size).ok_or(Error::Limit)?;
            let extent = source.get(start..end).ok_or(Error::Truncated)?;
            *budget = budget.checked_sub(size).ok_or(Error::Limit)?;
            out.extend_from_slice(extent);
        }
        path.pop();
        Ok(out)
    }
    pub fn alpha(&self, master: u32) -> Result<Option<u32>> {
        let mut alpha = None;
        for (id, item) in &self.items {
            if item
                .references
                .get(b"auxl")
                .is_some_and(|refs| refs.contains(&master))
                && self.item_properties(*id)?.iter().any(|p| {
                    matches!(p, Property::Auxiliary(name)
                    if *name == b"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha")
                })
            {
                if alpha.is_some() {
                    return Err(Error::Invalid);
                }
                alpha = Some(*id);
            }
        }
        Ok(alpha)
    }
}
fn single<'a, 'b>(boxes: &'b [BoxRef<'a>], kind: &[u8; 4]) -> Result<Option<&'b BoxRef<'a>>> {
    let mut found = boxes.iter().filter(|value| &value.kind == kind);
    let first = found.next();
    if found.next().is_some() {
        return Err(Error::Invalid);
    }
    Ok(first)
}
