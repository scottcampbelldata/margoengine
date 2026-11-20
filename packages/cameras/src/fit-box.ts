import type { Vec3 } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';

// The closest perspective view of a box that keeps every corner in the frame (GAP-FILM-FITBOX, 2026-11-16).
//
// Core's fitToBoundingBox frames the box's bounding sphere, which leaves a long, flat or deep model small in the frame
// (a car side-on in a 16:9 shot: 13 % of the frame, 48 % here; packages/cameras/test/fit-box.test.js). Here the view
// direction and field of view stay and the eye moves to the nearest point from which the eight corners lie inside the
// frame shrunk by `padding`, centred.
//
// Each side plane of the view frustum passes through the eye; a set of points lies inside the frustum when it lies on
// the inner side of all four planes. For a fixed direction, a plane's offset is set by its support value over the
// corners, max over p of (n . p) (the support function of a convex set: R. Schneider, "Convex Bodies: The
// Brunn-Minkowski Theory", 2nd ed., 2014, section 1.7). The left and right planes, each at their support value, meet in
// a line that fixes the eye's sideways offset and the farthest-forward depth the horizontal extent allows; the top and
// bottom planes do the same vertically. The eye takes the smaller of the two depths, so the tighter axis touches its two
// planes. The eye-target formulation of the view follows J. Blinn, "Where am I? What am I looking at?", IEEE Computer
// Graphics and Applications 8(4), 1988.
//
// Centring (KB-FITBOX-CENTRE1): equal slack at the looser axis's two planes is not the box centred on screen, because
// the corners nearest those planes sit at different depths (a plate seen from 25 degrees above sat 24.8 px high in a
// 1280x720 frame). With the depth fixed, a sideways eye offset o changes no corner's depth d_i, so a corner's screen
// coordinate (a_i - o) / d_i is linear in o; its highest value A(o) = max (a_i - o) / d_i falls and its lowest
// -B(o) = -max (o - a_i) / d_i rises with o, both piecewise linear (S. Boyd and L. Vandenberghe, "Convex Optimization",
// Cambridge University Press, 2004, section 3.2.3: the pointwise maximum of linear functions). The centred offset solves
// A(o) = B(o); at it one corner j sets A and one corner k sets B, so o = (a_j d_k + a_k d_j) / (d_j + d_k) for some pair,
// and the eye takes the pair whose candidate makes A - B smallest in size. The crossing minimises max(A, B), so the
// centred box stays inside the padded frame; on the tighter axis it is the plane-touching offset itself.

/** The view {@link fitBox} keeps: its direction (`target - position`), vertical field of view and screen up. */
export interface BoxFitView {
  position: ArrayLike<number>;
  target: ArrayLike<number>;
  /** Vertical field of view in degrees, as core's `Camera.fov`. */
  fov: number;
  /** Screen up, not parallel to the view. Default [0, 1, 0], as core's `Camera.up`. */
  up?: ArrayLike<number>;
}

/** Options of {@link fitBox}. */
export interface BoxFitOptions {
  /** Width / height of the frame. Default 1. */
  aspect?: number;
  /** At least 1: the box fills 1 / padding of the frame's width or height, whichever binds. Default 1.1. */
  padding?: number;
}

/** Where {@link fitBox} puts the camera. */
export interface BoxFit {
  position: Vec3;
  /** On the view axis, level with the box's centre. */
  target: Vec3;
  /** From `position` to `target`. */
  distance: number;
  /** The nearest corner's depth along the view, so a caller can check it against `camera.near`. */
  nearest: number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** The eye offset along `axis` that centres the box's corners on screen, seen from depth `ef` along `f`. */
function centred(axis: Vec3, b: number[], f: Vec3, ef: number): number {
  const a: number[] = [],
    d: number[] = [];
  for (const x of [b[0], b[3]])
    for (const y of [b[1], b[4]])
      for (const z of [b[2], b[5]]) {
        a.push(dot(axis, [x, y, z]));
        d.push(dot(f, [x, y, z]) - ef);
      }
  let best = 0,
    gap = Infinity;
  for (let j = 0; j < 8; j++)
    for (let k = 0; k < 8; k++) {
      const o = (a[j] * d[k] + a[k] * d[j]) / (d[j] + d[k]);
      let high = -Infinity,
        low = -Infinity;
      for (let i = 0; i < 8; i++) {
        high = Math.max(high, (a[i] - o) / d[i]);
        low = Math.max(low, (o - a[i]) / d[i]);
      }
      if (Math.abs(high - low) < gap) {
        gap = Math.abs(high - low);
        best = o;
      }
    }
  return best;
}

/**
 * The closest camera position, along the view's own direction, from which all eight corners of `bounds`
 * (`[minX, minY, minZ, maxX, maxY, maxZ]`, as `model.bounds`) sit inside the frame shrunk by `padding`, centred. Pure:
 * apply it with `camera.position = fit.position; camera.target = fit.target`, or use
 * `CameraProjection.fit(bounds, { framing: 'box' })` to animate it.
 */
export function fitBox(
  view: BoxFitView,
  bounds: ArrayLike<number>,
  { aspect = 1, padding = 1.1 }: BoxFitOptions = {},
): BoxFit {
  const b = Array.from(bounds),
    up = view.up ?? [0, 1, 0];
  const values = [
    ...b,
    view.fov,
    aspect,
    padding,
    ...Array.from(view.position),
    ...Array.from(view.target),
    ...Array.from(up),
  ];
  if (
    b.length !== 6 ||
    view.position.length !== 3 ||
    view.target.length !== 3 ||
    up.length !== 3 ||
    !values.every(Number.isFinite) ||
    b[0] > b[3] ||
    b[1] > b[4] ||
    b[2] > b[5] ||
    !(view.fov > 0 && view.fov < 180) ||
    !(aspect > 0) ||
    !(padding >= 1)
  )
    throw rangeError(
      'Invalid fitBox; pass bounds [minX, minY, minZ, maxX, maxY, maxZ] with min <= max, fov between 0 and 180, aspect > 0 and padding >= 1, all finite',
      'camera',
    );
  if (b[0] === b[3] && b[1] === b[4] && b[2] === b[5])
    throw rangeError('Invalid fitBox; the bounds are a single point, pass a box with extent', 'camera');
  const forward: Vec3 = [
      view.target[0] - view.position[0],
      view.target[1] - view.position[1],
      view.target[2] - view.position[2],
    ],
    side = cross(forward, up);
  if (
    !(Math.hypot(...forward) > 0) ||
    !(Math.hypot(...side) > 1e-12 * Math.hypot(...forward) * Math.hypot(up[0], up[1], up[2]))
  )
    throw rangeError(
      'Invalid fitBox view; position and target must differ and the view must not be parallel to up',
      'camera',
    );
  const f = unit(forward),
    r = unit(side),
    u = cross(r, f),
    ty = Math.tan((view.fov * Math.PI) / 360) / padding,
    tx = ty * aspect;
  let left = -Infinity,
    right = -Infinity,
    bottom = -Infinity,
    top = -Infinity;
  for (const x of [b[0], b[3]])
    for (const y of [b[1], b[4]])
      for (const z of [b[2], b[5]]) {
        const p = [x, y, z],
          pr = dot(r, p),
          pu = dot(u, p),
          pf = dot(f, p);
        right = Math.max(right, pr - tx * pf);
        left = Math.max(left, -pr - tx * pf);
        top = Math.max(top, pu - ty * pf);
        bottom = Math.max(bottom, -pu - ty * pf);
      }
  const ef = Math.min(-(right + left) / (2 * tx), -(top + bottom) / (2 * ty)),
    er = centred(r, b, f, ef),
    eu = centred(u, b, f, ef),
    centre = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2],
    distance = dot(f, centre) - ef,
    position = [0, 1, 2].map((i) => r[i] * er + u[i] * eu + f[i] * ef) as unknown as Vec3,
    target = position.map((v, i) => v + f[i] * distance) as unknown as Vec3;
  let nearest = Infinity;
  for (const x of [b[0], b[3]])
    for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) nearest = Math.min(nearest, dot(f, [x, y, z]) - ef);
  return { position, target, distance, nearest };
}
