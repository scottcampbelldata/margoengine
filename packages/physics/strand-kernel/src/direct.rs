// Block Schur solve for one open chain. Its constraints touch only adjacent nodes,
// so elimination leaves one dense six-by-six block per link.
use super::{Material, Q, State, V, slot, slot_mut, sqrt};

const SIZE: usize = 6;
type Vector = [f64; SIZE];
type Matrix = [Vector; SIZE];

#[repr(C)]
#[derive(Clone, Copy)]
struct Gradient {
    position: V,
    angle: V,
}

impl Gradient {
    const ZERO: Self = Self {
        position: V::ZERO,
        angle: V::ZERO,
    };

    fn scale(self, scale: f64) -> Self {
        Self {
            position: self.position.scale(scale),
            angle: self.angle.scale(scale),
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            position: self.position.add(other.position),
            angle: self.angle.add(other.angle),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Row {
    left: Gradient,
    right: Gradient,
    compliance: f64,
    rhs: f64,
    reciprocal_scale: f64,
}

#[repr(C)]
pub(crate) struct Block {
    rows: [Row; SIZE],
    upper: Matrix,
    value: Vector,
    lambda: Vector,
}

const _: [(); 138 * 8] = [(); core::mem::size_of::<Block>()];

fn metric(a: Gradient, b: Gradient, material: &Material, tangent: V) -> f64 {
    let a_twist = a.angle.dot(tangent);
    let b_twist = b.angle.dot(tangent);
    let a_bend = a.angle.subtract(tangent.scale(a_twist));
    let b_bend = b.angle.subtract(tangent.scale(b_twist));
    a.position.dot(b.position) * material.inverse_mass
        + a_bend.dot(b_bend) * material.inverse_bend
        + a_twist * b_twist * material.inverse_twist
}

struct Link<'a> {
    a: &'a Material,
    b: &'a Material,
    tangent_a: V,
    tangent_b: V,
    inverse_dt2: f64,
}

impl Link<'_> {
    fn normalize(
        &self,
        left: Gradient,
        right: Gradient,
        strain: f64,
        compliance: f64,
        lambda: f64,
    ) -> Row {
        let compliance = compliance * self.inverse_dt2;
        let diagonal = metric(left, left, self.a, self.tangent_a)
            + metric(right, right, self.b, self.tangent_b)
            + compliance;
        let s = 1.0 / sqrt(diagonal);
        Row {
            left: left.scale(s),
            right: right.scale(s),
            compliance: compliance * s * s,
            rhs: -(strain + compliance * lambda) * s,
            reciprocal_scale: s,
        }
    }

    fn stretch_row(&self, director: V, edge: V, target: f64, compliance: f64, lambda: f64) -> Row {
        let displacement = director.scale(1.0 / self.a.length);
        self.normalize(
            Gradient {
                position: displacement.scale(-1.0),
                angle: director.cross(edge),
            },
            Gradient {
                position: displacement,
                angle: V::ZERO,
            },
            director.dot(edge) - target,
            compliance,
            lambda,
        )
    }

    fn bend_row(&self, natural: Q, error: Q, axis: V, compliance: f64, lambda: f64) -> Row {
        let sign = if error.w < 0.0 { -1.0 } else { 1.0 };
        let angular = natural
            .rotate(axis.scale(error.w).add(error.v.cross(axis)))
            .scale(sign);
        self.normalize(
            Gradient {
                position: V::ZERO,
                angle: angular.scale(-1.0),
            },
            Gradient {
                position: V::ZERO,
                angle: angular,
            },
            2.0 * sign * error.v.dot(axis),
            compliance,
            lambda,
        )
    }
}

fn build_rows(
    block: &mut Block,
    a: &State,
    b: &State,
    ma: &Material,
    mb: &Material,
    dt: f64,
    bend: bool,
) {
    let link = Link {
        a: ma,
        b: mb,
        tangent_a: a.frame.rotate(V::Z),
        tangent_b: b.frame.rotate(V::Z),
        inverse_dt2: 1.0 / (dt * dt),
    };
    let edge = b.position.subtract(a.position).scale(1.0 / ma.length);
    block.rows[0] = link.stretch_row(a.frame.rotate(V::X), edge, 0.0, ma.shear, block.lambda[0]);
    block.rows[1] = link.stretch_row(a.frame.rotate(V::Y), edge, 0.0, ma.shear, block.lambda[1]);
    block.rows[2] = link.stretch_row(link.tangent_a, edge, 1.0, ma.axial, block.lambda[2]);
    if bend {
        let natural = a.frame.mul(ma.natural);
        let error = natural.conjugate().mul(b.frame);
        block.rows[3] = link.bend_row(natural, error, V::X, ma.bend, block.lambda[3]);
        block.rows[4] = link.bend_row(natural, error, V::Y, ma.bend, block.lambda[4]);
        block.rows[5] = link.bend_row(natural, error, V::Z, ma.twist, block.lambda[5]);
    } else {
        for index in 3..SIZE {
            let row = slot_mut(&mut block.rows, index);
            // Every field is f64. A zeroed gradient keeps this placeholder row independent.
            unsafe { core::ptr::write_bytes(row, 0, 1) };
            row.compliance = 1.0;
            row.reciprocal_scale = 1.0;
        }
    }
}

fn entry(matrix: &Matrix, row: usize, column: usize) -> f64 {
    *slot(slot(matrix, row), column)
}

fn set(matrix: &mut Matrix, row: usize, column: usize, value: f64) {
    *slot_mut(slot_mut(matrix, row), column) = value;
}

fn factor(matrix: &mut Matrix) -> bool {
    // In-place Cholesky of this positive Schur block.
    for row in 0..SIZE {
        for col in 0..=row {
            let mut value = entry(matrix, row, col);
            for k in 0..col {
                value -= entry(matrix, row, k) * entry(matrix, col, k);
            }
            if row == col {
                if !(value > 0.0 && value.is_finite()) {
                    return false;
                }
                set(matrix, row, col, sqrt(value));
            } else {
                set(matrix, row, col, value / entry(matrix, col, col));
            }
        }
    }
    true
}

fn solve(factor: &Matrix, mut values: Vector) -> Vector {
    for i in 0..SIZE {
        let mut value = *slot(&values, i);
        for j in 0..i {
            value -= entry(factor, i, j) * *slot(&values, j);
        }
        *slot_mut(&mut values, i) = value / entry(factor, i, i);
    }
    for i in (0..SIZE).rev() {
        let mut value = *slot(&values, i);
        for j in i + 1..SIZE {
            value -= entry(factor, j, i) * *slot(&values, j);
        }
        *slot_mut(&mut values, i) = value / entry(factor, i, i);
    }
    values
}

fn project_chain(
    nodes: &mut [State],
    material: &[Material],
    blocks: &mut [Block],
    dt: f64,
) -> bool {
    let edges = nodes.len() - 1;
    for i in 0..edges {
        build_rows(
            slot_mut(blocks, i),
            slot(nodes, i),
            slot(nodes, i + 1),
            slot(material, i),
            slot(material, i + 1),
            dt,
            i + 1 < edges,
        );
    }

    for i in 0..edges {
        let ma = slot(material, i);
        let mb = slot(material, i + 1);
        let tangent_a = slot(nodes, i).frame.rotate(V::Z);
        let tangent_b = slot(nodes, i + 1).frame.rotate(V::Z);
        let current = slot(blocks, i);
        let mut diagonal = [[0.0; SIZE]; SIZE];
        let mut rhs = [0.0; SIZE];

        for row in 0..SIZE {
            let a = slot(&current.rows, row);
            *slot_mut(&mut rhs, row) = a.rhs;
            for col in 0..=row {
                let b = slot(&current.rows, col);
                let value = metric(a.left, b.left, ma, tangent_a)
                    + metric(a.right, b.right, mb, tangent_b)
                    + if row == col { a.compliance } else { 0.0 };
                set(&mut diagonal, row, col, value);
            }
        }

        if i > 0 {
            let previous = slot(blocks, i - 1);
            for row in 0..SIZE {
                let left = slot(&current.rows, row).left;
                for k in 0..SIZE {
                    let lower = metric(left, slot(&previous.rows, k).right, ma, tangent_a);
                    if lower == 0.0 {
                        continue;
                    }
                    *slot_mut(&mut rhs, row) -= lower * *slot(&previous.value, k);
                    for col in 0..=row {
                        let value =
                            entry(&diagonal, row, col) - lower * entry(&previous.upper, k, col);
                        set(&mut diagonal, row, col, value);
                    }
                }
            }
        }

        if !factor(&mut diagonal) {
            return false;
        }
        let mut upper = [[0.0; SIZE]; SIZE];
        if i + 1 < edges {
            let next = slot(blocks, i + 1);
            for col in 0..SIZE {
                let left = slot(&next.rows, col).left;
                let mut field = [0.0; SIZE];
                for row in 0..SIZE {
                    *slot_mut(&mut field, row) =
                        metric(slot(&current.rows, row).right, left, mb, tangent_b);
                }
                let scaled = solve(&diagonal, field);
                for row in 0..SIZE {
                    set(&mut upper, row, col, *slot(&scaled, row));
                }
            }
        }

        let block = slot_mut(blocks, i);
        block.upper = upper;
        block.value = solve(&diagonal, rhs);
    }

    for i in (0..edges).rev() {
        if i + 1 < edges {
            let next = slot(blocks, i + 1).value;
            let block = slot_mut(blocks, i);
            for row in 0..SIZE {
                let mut value = *slot(&block.value, row);
                for col in 0..SIZE {
                    value -= entry(&block.upper, row, col) * *slot(&next, col);
                }
                *slot_mut(&mut block.value, row) = value;
            }
        }
        let block = slot_mut(blocks, i);
        for j in 0..SIZE {
            *slot_mut(&mut block.lambda, j) +=
                *slot(&block.value, j) * slot(&block.rows, j).reciprocal_scale;
        }
    }

    for (i, node) in nodes.iter_mut().enumerate() {
        let mat = slot(material, i);
        if mat.inverse_mass == 0.0 && mat.inverse_bend == 0.0 {
            continue;
        }
        let mut correction = Gradient::ZERO;
        if i > 0 {
            let block = slot(blocks, i - 1);
            for j in 0..SIZE {
                correction =
                    correction.add(slot(&block.rows, j).right.scale(*slot(&block.value, j)));
            }
        }
        if i < edges {
            let block = slot(blocks, i);
            for j in 0..SIZE {
                correction =
                    correction.add(slot(&block.rows, j).left.scale(*slot(&block.value, j)));
            }
        }
        node.position = node
            .position
            .add(correction.position.scale(mat.inverse_mass));
        if mat.inverse_bend == 0.0 {
            continue;
        }
        let tangent = node.frame.rotate(V::Z);
        let axial = tangent.scale(tangent.dot(correction.angle));
        let bend = correction.angle.subtract(axial).scale(mat.inverse_bend);
        let twist = axial.scale(mat.inverse_twist);
        node.frame = node.frame.correct(bend.add(twist));
    }
    true
}

pub(crate) fn clear(blocks: &mut [Block]) {
    for block in blocks {
        block.lambda.fill(0.0);
    }
}

pub(crate) fn project(
    nodes: &mut [State],
    material: &[Material],
    blocks: &mut [Block],
    start: usize,
    end: usize,
    dt: f64,
) -> bool {
    project_chain(
        nodes
            .get_mut(start..end)
            .unwrap_or_else(|| super::unreachable()),
        material
            .get(start..end)
            .unwrap_or_else(|| super::unreachable()),
        blocks
            .get_mut(start..end)
            .unwrap_or_else(|| super::unreachable()),
        dt,
    )
}
