const { abs } = Math;

/**
 * Solves x(s) = t on a cubic from (0, 0) to (1, 1) with handle x values `x1` and `x2` in 0..1, where x only rises.
 * Newton iterations with a bisection fallback, accurate to about 1e-6.
 */
export function bezierSolver(x1: number, x2: number): (t: number) => number {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = x(s) - t;
      if (abs(err) < 1e-7) return s;
      const d = dx(s);
      if (abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0,
      hi = 1;
    s = t;
    for (let i = 0; i < 40 && hi - lo > 1e-9; i++) {
      if (x(s) < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
}
