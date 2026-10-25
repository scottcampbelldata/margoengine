// @margoengine/compute/autodiff: reverse-mode automatic differentiation of element-wise expressions. The gradient of
// sum(output * seed) with respect to arrays the expression reads is built backwards over the same lazy expression
// tree (the vector-Jacobian product, A. Griewank and A. Walther, "Evaluating Derivatives", 2nd ed., SIAM 2008,
// chapter 3), as new lazy expressions. So each gradient runs as one fused kernel that recomputes the forward values
// it needs instead of storing them. Gradients flow back through broadcasting (summed over the broadcast axes) and
// through views (transposes, slices and broadcasts of an array add into the array's own elements). Works on both
// backends.
import { rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import { isFloat } from './dtype.js';
import { Expr, Operand, where, type Node, type OperandLike } from './expr.js';
import type { ComputeContext } from './context.js';

/** Options for {@link grad}. */
export interface GradOptions {
  /** Weights of the output's elements (broadcast to its shape): the gradient is of sum(output * seed). Default 1. */
  readonly seed?: OperandLike;
}

type Adjoint = Operand | number;
type OpNode = Node & { kind: 'op' };

const shapeOf = (node: Node): readonly number[] =>
  node.kind === 'leaf' ? node.array.shape : node.kind === 'scalar' ? [] : node.shape;
const dtypeOf = (node: Node) => (node.kind === 'leaf' ? node.array.dtype : node.dtype);

// Arithmetic on adjoints, which may be plain numbers (the seed) or expressions.
const mul = (g: Adjoint, x: OperandLike): Adjoint =>
  typeof g === 'number'
    ? typeof x === 'number'
      ? g * x
      : g === 1
        ? x
        : x.mul(g)
    : typeof x === 'number' && x === 1
      ? g
      : g.mul(x);
const neg = (g: Adjoint): Adjoint => (typeof g === 'number' ? -g : g.neg());
const add = (a: Adjoint | undefined, b: Adjoint): Adjoint =>
  a === undefined
    ? b
    : typeof a === 'number' && typeof b === 'number'
      ? a + b
      : typeof a === 'number'
        ? (b as Operand).add(a)
        : a.add(b);
const pick = (cond: Operand, g: Adjoint, otherwise: boolean): Adjoint =>
  otherwise ? where(cond, 0, g) : where(cond, g, 0);

/** The expression of a node, to build derivative expressions from. */
function operand(ctx: ComputeContext, node: Node): OperandLike {
  if (node.kind === 'leaf') return node.array;
  if (node.kind === 'scalar') return node.value;
  return new Expr(ctx, node as OpNode);
}

/** The contributions of one op node's adjoint `g` to its arguments (undefined: none). */
function backward(ctx: ComputeContext, node: OpNode, g: Adjoint): (Adjoint | undefined)[] {
  // The first argument is always an expression (methods are called on it); later ones may be plain numbers.
  const args = node.args.map((n) => operand(ctx, n)),
    a = args[0] as Operand,
    [, b, c] = args,
    y = new Expr(ctx, node);
  const sq = (x: OperandLike) => (typeof x === 'number' ? x * x : x.square());
  switch (node.op) {
    case 'add':
      return [g, g];
    case 'sub':
      return [g, neg(g)];
    case 'mul':
      return [mul(g, b), mul(g, a)];
    case 'div':
      return [mul(g, typeof b === 'number' ? 1 / b : b.reciprocal()), mul(neg(g), y.div(b))];
    case 'pow':
      return [
        mul(g, a.pow(typeof b === 'number' ? b - 1 : b.sub(1)).mul(b)),
        mul(g, where(a.gt(0), y.mul(a.log()), 0)),
      ];
    case 'minimum':
      return [pick(a.le(b), g, false), pick(a.le(b), g, true)];
    case 'maximum':
      return [pick(a.ge(b), g, false), pick(a.ge(b), g, true)];
    case 'clip':
      return [pick(a.ge(b).and(a.le(c)), g, false), pick(a.lt(b), g, false), pick(a.gt(c), g, false)];
    case 'atan2': {
      const r2 = a.square().add(sq(b));
      return [mul(g, r2.reciprocal().mul(b)), mul(neg(g), a.div(r2))];
    }
    case 'hypot':
      return [mul(g, where(y.eq(0), 0, a.div(y))), mul(g, where(y.eq(0), 0, y.reciprocal().mul(b)))];
    case 'neg':
      return [neg(g)];
    case 'abs':
      return [mul(g, a.sign())];
    case 'square':
      return [mul(g, a.mul(2))];
    case 'sqrt':
      return [mul(g, y.reciprocal().mul(0.5))];
    case 'rsqrt':
      return [mul(g, y.mul(y).mul(y).mul(-0.5))];
    case 'reciprocal':
      return [mul(neg(g), y.square())];
    case 'exp':
      return [mul(g, y)];
    case 'exp2':
      return [mul(g, y.mul(Math.LN2))];
    case 'expm1':
      return [mul(g, y.add(1))];
    case 'log':
      return [mul(g, a.reciprocal())];
    case 'log2':
      return [mul(g, a.mul(Math.LN2).reciprocal())];
    case 'log1p':
      return [mul(g, a.add(1).reciprocal())];
    case 'sin':
      return [mul(g, a.cos())];
    case 'cos':
      return [mul(neg(g), a.sin())];
    case 'tan':
      return [mul(g, y.square().add(1))];
    case 'asin':
      return [mul(g, a.square().neg().add(1).rsqrt())];
    case 'acos':
      return [mul(neg(g), a.square().neg().add(1).rsqrt())];
    case 'atan':
      return [mul(g, a.square().add(1).reciprocal())];
    case 'sinh':
      return [mul(g, a.cosh())];
    case 'cosh':
      return [mul(g, a.sinh())];
    case 'tanh':
      return [mul(g, y.square().neg().add(1))];
    case 'degrees':
      return [mul(g, 180 / Math.PI)];
    case 'radians':
      return [mul(g, Math.PI / 180)];
    case 'astype':
      return [isFloat(node.dtype) && isFloat(dtypeOf(node.args[0])) ? g : undefined];
    case 'where':
      return [undefined, pick(a, g, false), pick(a, g, true)];
    default:
      // Rounding, comparisons, logic and bit operations are flat or undefined almost everywhere: no gradient.
      return node.args.map(() => undefined);
  }
}

const sameShape = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((d, k) => d === b[k]);

/**
 * `g`, an adjoint over the elements of a node of shape `from` (a number or an expression that broadcasts to it), as
 * the adjoint of an argument of shape `to`: summed over the axes the argument was broadcast along. Arrays it makes
 * for the purpose go to `owned`.
 */
function reduceTo(
  ctx: ComputeContext,
  g: Adjoint,
  from: readonly number[],
  to: readonly number[],
  owned: GpuArray[],
): Adjoint {
  const shape = typeof g === 'number' ? [] : g.shape;
  if (sameShape(from, to) && (typeof g === 'number' || sameShape(shape, to))) return g;
  // Spread over `from` first, so a value constant along a broadcast axis is counted once per position.
  let full: Operand;
  if (typeof g !== 'number' && sameShape(shape, from)) full = g;
  else {
    const zeros = ctx.zeros(from);
    owned.push(zeros);
    full = zeros.add(g);
  }
  if (sameShape(from, to)) return full;
  const lead = from.length - to.length,
    axes = from.map((_, k) => k).filter((k) => k < lead || (to[k - lead] === 1 && from[k] !== 1)),
    summed = axes.length ? full.sum({ axis: axes, keepdims: true }) : full.eval();
  owned.push(summed);
  return summed.reshape(to.length ? [...to] : []);
}

/**
 * Gradients of sum(output * seed) with respect to each array in `wrt`, as f32 arrays of their shapes (zeros for an
 * array the output does not read). `output` is an element-wise expression; the gradient flows through its
 * arithmetic, maths and selections, through broadcasting and through views of the arrays. Rounding, comparisons and
 * bit operations have no gradient.
 * @example
 * const loss = w.mul(x).add(b).sub(y).square(); // per sample
 * const [dw, db] = grad(loss, [w, b]); // d(sum loss)/dw, d(sum loss)/db
 */
export function grad(output: Operand, wrt: readonly GpuArray[], options: GradOptions = {}): GpuArray<'f32'>[] {
  if (!(output instanceof Operand)) throw typeError('grad takes an output GpuArray or Expr', 'compute');
  if (!Array.isArray(wrt) || wrt.some((w) => !(w instanceof GpuArray)))
    throw typeError('grad takes the arrays to differentiate by as a list of GpuArrays', 'compute');
  const ctx = output.context;
  ctx.check();
  for (const w of wrt) {
    w.check(ctx);
    if (!isFloat(w.dtype)) throw typeError(`grad by an integer array (${w.dtype}) has no meaning; use f32`, 'compute');
  }
  const seed = options.seed ?? 1;
  if (seed instanceof Operand && seed.context !== ctx)
    throw typeError('grad seed belongs to another compute context', 'compute');
  if (typeof seed !== 'number' && !(seed instanceof Operand))
    throw typeError('grad seed must be a number, a GpuArray or an Expr', 'compute');
  // Post-order over the tree (shared subtrees once), reversed: each node after everything that reads it.
  const order: Node[] = [],
    seen = new Set<Node>();
  const visit = (node: Node) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'op') for (const arg of node.args) visit(arg);
    order.push(node);
  };
  const root = output.node();
  visit(root);
  const adjoint = new Map<Node, Adjoint>([[root, seed instanceof Operand ? seed.astype('f32') : seed]]);
  const owned: GpuArray[] = [];
  // Every path into a leaf, with the shape of the node that read it (the output's, for an output that is a leaf).
  const leaves: { array: GpuArray; g: Adjoint; from: readonly number[] }[] = [];
  if (root.kind === 'leaf') leaves.push({ array: root.array, g: adjoint.get(root)!, from: output.shape });
  for (let k = order.length - 1; k >= 0; k--) {
    const node = order[k],
      g = adjoint.get(node);
    if (g === undefined || node.kind !== 'op' || !isFloat(node.dtype)) continue;
    backward(ctx, node, g).forEach((contribution, i) => {
      if (contribution === undefined) return;
      const arg = node.args[i];
      if (arg.kind === 'leaf') leaves.push({ array: arg.array, g: contribution, from: node.shape });
      else if (arg.kind === 'op')
        // An argument narrower than this node (broadcast inside the tree) takes the sum over the broadcast axes.
        adjoint.set(arg, add(adjoint.get(arg), reduceTo(ctx, contribution, node.shape, shapeOf(arg), owned)));
    });
  }
  const result = wrt.map((w) => {
    let total: GpuArray | undefined;
    for (const { array: a, g, from } of leaves) {
      if (a !== w && a.storage !== w.storage) continue;
      if (!isFloat(a.dtype)) continue;
      const own = reduceTo(ctx, g, from, a.shape, owned),
        part =
          a === w
            ? typeof own === 'number'
              ? ctx.full(w.shape, own)
              : own.astype('f32').eval()
            : scatterView(ctx, own, a, w);
      total = total ? swapAdd(total, part) : part;
    }
    return (total ?? ctx.zeros(w.shape)) as GpuArray<'f32'>;
  });
  for (const a of owned) a.dispose();
  return result;
}

const swapAdd = (a: GpuArray, b: GpuArray): GpuArray => {
  const out = a.add(b).eval();
  a.dispose();
  b.dispose();
  return out;
};

// Adds the gradient of a view `view` (values `g`, the view's shape) into the elements of `w`, whose buffer it reads.
function scatterView(ctx: ComputeContext, g: Adjoint, view: GpuArray, w: GpuArray): GpuArray {
  if (!w.contiguous || w.offset !== 0)
    throw rangeError('grad by a view is not supported; pass the array the views came from', 'compute');
  // Element offset of each view element in the shared buffer: offset + sum of coordinate * stride.
  const i = ctx.arange(0, view.size, 1, 'i32'),
    shape = view.shape;
  let position: Operand = i.mul(0).add(view.offset),
    inner = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    if (shape[k] > 1 && view.strides[k] !== 0)
      position = position.add(i.floorDiv(inner).mod(shape[k]).mul(view.strides[k]));
    inner *= shape[k];
  }
  const owner = typeof g === 'number' ? undefined : (g as Operand).astype('f32').eval(),
    out = ctx.zeros([w.size]);
  ctx.scatter(out, position, owner ? owner.reshape(view.size) : (g as number), { op: 'add' });
  owner?.dispose();
  i.dispose();
  return out.transfer([...w.shape]);
}

/** The value sum(output * seed) (shape []) and its gradients with respect to `wrt` (see {@link grad}). */
export function valueAndGrad(
  output: Operand,
  wrt: readonly GpuArray[],
  options: GradOptions = {},
): { value: GpuArray; grads: GpuArray<'f32'>[] } {
  const seed = options.seed ?? 1,
    weighted = typeof seed === 'number' && seed === 1 ? output : output.mul(seed);
  return { value: weighted.sum(), grads: grad(output, wrt, options) };
}
