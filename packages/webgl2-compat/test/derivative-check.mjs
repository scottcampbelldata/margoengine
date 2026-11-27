// The exact values of the derivativeBranch cases of features.html that take derivatives of polynomials of the pixel
// centre, so the WebGL2 layer is judged against the mathematics and not against one GPU's native answer
// (docs/known-bugs.md KB-AMD-HELPERDERIV1: an AMD driver's native WebGPU gets the helper-function case wrong).
// Screen derivatives are differences inside a 2 x 2 quad (W3C, "WebGPU Shading Language", "Derivatives"). With
// r = 0.5 x^2 + 1.5 y^2 the x difference depends on x alone and the y difference on y alone, so the fine and coarse
// forms agree and every value is a whole number, exact in f32.

/** The difference of `f` across the quad that pixel `n` lies in, along one axis (pixel centres at n + 0.5). */
const across = (f, n) => {
  const first = n - (n % 2) + 0.5;
  return f(first + 1) - f(first);
};

/**
 * The output of every polynomial case of derivativeBranch on a `width` x `height` target: pixels whose x + y is odd
 * hold -1; the others hold the case's two values, the first value summed x % 3 + 1 times, and 1.
 */
export function derivativeExpected(width = 8, height = 4) {
  const pixels = (values) => {
    const out = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if ((x + y) % 2) {
          out.push(-1, -1, -1, -1);
          continue;
        }
        const dx = across((v) => 0.5 * v * v, x),
          dy = across((v) => 1.5 * v * v, y),
          [first, second, summed] = values(dx, dy);
        out.push(first, second, summed * ((x % 3) + 1), 1);
      }
    return out;
  };
  const forms = {};
  const kinds = { dpdx: (dx) => dx, dpdy: (_, dy) => dy, fwidth: (dx, dy) => Math.abs(dx) + Math.abs(dy) };
  for (const [name, d] of Object.entries(kinds))
    for (const precision of ['', 'Fine', 'Coarse'])
      forms[name + precision] = pixels((dx, dy) => [d(dx, dy), 0, d(dx, dy)]);
  // dpdx(vec3(r, 2 r, y^2)): the third component does not change along x.
  forms.vector = pixels((dx) => [2 * dx, 0, dx]);
  forms.helper = pixels((dx, dy) => [dx, dy, dx]);
  return forms;
}
