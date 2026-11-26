use super::tensor::{V, ZERO, add, floor, sub};
use super::{at, at_mut};

#[repr(C)]
pub(crate) struct Node {
    pub(crate) coord: [i32; 3],
    padding: i32,
    pub(crate) mass: f64,
    pub(crate) momentum: V,
}

#[derive(Clone, Copy)]
struct Axis {
    base: i32,
    weights: V,
}

impl Axis {
    fn at(position: f64, spacing: f64) -> Self {
        let x = position / spacing;
        let base = floor(x - 0.5);
        let f = x - base;
        let end = 1.5 - f;
        let middle = f - 1.0;
        let start = f - 0.5;
        Self {
            base: base as i32,
            weights: [0.5 * end * end, 0.75 - middle * middle, 0.5 * start * start],
        }
    }
}

pub(crate) fn stencil(position: V, spacing: f64, mut run: impl FnMut([i32; 3], f64, V)) {
    let [x, y, z] = position.map(|axis| Axis::at(axis, spacing));
    for k in 0..3 {
        for j in 0..3 {
            for i in 0..3 {
                let weight = x.weights[i] * y.weights[j] * z.weights[k];
                if weight > 0.0 {
                    let index = [x.base + i as i32, y.base + j as i32, z.base + k as i32];
                    let offset = sub(index.map(|axis| axis as f64 * spacing), position);
                    run(index, weight, offset);
                }
            }
        }
    }
}

// A power-of-two sparse page has at least twice the worst-case number of occupied nodes.
pub(crate) fn slot(nodes: &[Node], coord: [i32; 3]) -> usize {
    let [x, y, z] = coord.map(|v| v as u32);
    let hash = x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663) ^ z.wrapping_mul(83492791);
    let mask = nodes.len() - 1;
    let mut index = hash as usize & mask;
    loop {
        let node = at(nodes, index);
        if node.mass == 0.0 || node.coord == coord {
            return index;
        }
        index = (index + 1) & mask;
    }
}

pub(crate) fn deposit(
    nodes: &mut [Node],
    active: &mut [u32],
    count: &mut usize,
    coord: [i32; 3],
    mass: f64,
    momentum: V,
) {
    if mass == 0.0 {
        return;
    }
    let index = slot(nodes, coord);
    let node = at_mut(nodes, index);
    if node.mass == 0.0 {
        *at_mut(active, *count) = index as u32;
        *count += 1;
        node.coord = coord;
        node.momentum = ZERO;
    }
    node.mass += mass;
    node.momentum = add(node.momentum, momentum);
}

pub(crate) fn clear(nodes: &mut [Node], active: &[u32]) {
    for &index in active {
        at_mut(nodes, index as usize).mass = 0.0;
    }
}

pub(crate) fn gather(nodes: &[Node], coord: [i32; 3]) -> V {
    let node = at(nodes, slot(nodes, coord));
    if node.mass > 0.0 { node.momentum } else { ZERO }
}
