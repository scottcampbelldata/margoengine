// Partial coverage for a scatter ring (`Scatter.coverRing`), KB-SCATTER-SUBPIXEL1. A strip is drawn wider than it is by
// a filter's radius on each side, measured across it as the screen shows it, and every pixel it touches takes the
// share of a tent (cone) filter around its centre that the true strip covers, as alpha (prefiltered lines: Gupta and
// Sproull, "Filtering Edges for Gray-Scale Displays", SIGGRAPH 1981; Chan and Durand, "Fast Prefiltered Lines", GPU
// Gems 2, 2005), blended over what is drawn by Porter and Duff's over ("Compositing Digital Images", SIGGRAPH 1984).
// A tent of a whole number of pixels' radius sampled at pixel centres one apart sums to exactly the strip's width, so a
// blade thinner than a pixel adds its true share of colour and a wider one gets soft edges, with no lone pixels or
// broken runs. A strip too short to resolve along its length (a far blade a few pixels tall) takes the two-pixel tent
// instead, the prefiltering of far vegetation (Bruneton and Neyret, "Real-time Realistic Rendering and Lighting of
// Forests", Eurographics 2012): the pose mixes the two by a weight, which keeps the sum exact. Same-coloured layers
// blended by over give the same result in any order, so a covered ring needs no sorting and writes no depth while it
// blends; its depth is written afterwards, where it covers, by its coverage-depth stage (`coverCode` depth).
/**
 * Declares the coverage of a vertex, which a pose sets on a ring drawn with `coverRing`: x the signed distance in
 * pixels from the strip's centre line across it, y half the strip's true width in pixels, z the weight of the
 * two-pixel filter against the one-pixel one, w the coverage above which the strip writes depth (see `coverCode`'s
 * `depth`), the same over a strip and 0 to 1. The default covers fully and writes depth above half coverage.
 */
export const coverDeclaration = 'var<private> scatterCover:vec4f=vec4f(0.0,65536.0,0.0,0.5);\n';
/**
 * Marks both stages of a ring that `Scatter.coverRing` splits ('split'): the opaque stage (without `coverDeclaration`)
 * draws the part of each instance its covered stage covers fully (a strip's core, the filter's radius in from each
 * edge), writing depth, and the covered stage (with it) the whole of it, blended.
 */
export const splitDeclaration = 'const scatterSplit=true;\n';
/**
 * WGSL: `scatterTent` is the integral of a unit tent filter up to u, `scatterStrip` the share of a tent of radius r
 * pixels at distance s from a strip's centre line that the strip, h pixels either side of it, covers, and
 * `scatterCoverage` mixes the one- and two-pixel filters by `cover.z`.
 */
export const coverageShader =
  'fn scatterTent(u:f32)->f32 {let v=clamp(u,-1.0,1.0);return select(1.0-(1.0-v)*(1.0-v)*0.5,(1.0+v)*(1.0+v)*0.5,v<0.0);}\n' +
  'fn scatterStrip(s:f32,h:f32,r:f32)->f32 {return clamp(scatterTent((h-s)/r)-scatterTent((-h-s)/r),0.0,1.0);}\n' +
  'fn scatterCoverage(e:vec4f)->f32 {return mix(scatterStrip(e.x,e.y,1.0),scatterStrip(e.x,e.y,2.0),e.z);}\n';
/**
 * The colour stage of a ring drawn with partial coverage (`Scatter.coverRing`): the vertex passes `scatterCover` (see
 * `coverDeclaration`) to the fragment, which writes the tent-filtered share of the true strip at its pixel as alpha.
 * `at` is a free varying location of a lit stage; `lit` false takes the unlit stage of index.ts. Undefined when the
 * fragment stage is not the one-colour stage this wraps (a multiple render target one), so the ring stays opaque.
 *
 * `depth` true makes the ring's coverage-depth stage instead (KB-SCENES-DUNE-GTAO1): a fragment whose coverage is above
 * `scatterCover.w` is kept and every other one discarded, for a pass after the blended one that writes depth and no
 * colour (the alpha-tested depth pass of hair and foliage drawn by blending: Nguyen and Donnelly, "Hair Animation and
 * Rendering in the Nalu Demo", GPU Gems 2, 2005). Effects that read depth (ambient occlusion, which finds occluders
 * only there: Jimenez, Wu, Pesce and Jarabo 2016; depth of field; fog) and meshes drawn later then see the strip where
 * it covers, while its colour stays the blended coverage. A pose that sets w to a hash of the strip (an object-space
 * hashed alpha test: Wyman and McGuire, "Hashed Alpha Testing", I3D 2017) writes depth at a pixel with the chance of
 * its coverage, so overlapping strips leave a pixel's depth bare with the chance over leaves its colour bare, the
 * product of one less each coverage (stochastic transparency: Enderton, Sintorn, Shirley and Luebke, I3D 2010), and
 * the pattern holds still as the camera moves.
 */
export function coverCode(code: string, lit: boolean, at = 0, depth = false): string | undefined {
  const one = (text: string, from: string | RegExp, to: string) => {
    const n = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from, 'g')) ?? []).length;
    return n === 1 ? text.replace(from, to) : undefined;
  };
  if (!lit) {
    const a = one(code, /(@location\(3\)(?:[^,}()]|\([^()]*\))*shade:f32)\}/, '$1,@location(4) cover:vec4f}');
    const b = a && one(a, 'pose.ground,pose.shade);', 'pose.ground,pose.shade,scatterCover);');
    const kept = depth
      ? 'if(scatterCoverage(i.cover)<=i.cover.w){discard;}return vec4f(color,1);}'
      : 'return vec4f(color,scatterCoverage(i.cover));}';
    const c = b && one(b, 'return vec4f(color,1);}', kept);
    return c && coverDeclaration + coverageShader + c;
  }
  // A capture stage (`captureStage`) returns the hook's MargoSSR: only its coverage-depth form exists, kept where the
  // strip's coverage passes the pose's threshold, as the depth pass after the blended colour keeps it.
  const head = /@fragment fn fragment\(((?:[^()]|\([^()]*\))*)\)->(@location\(0\) vec4f|MargoSSR) \{/.exec(code);
  const struct = /struct Output \{[^}]+\}/.exec(code)?.[0];
  if (!head || !struct || !/@vertex fn vertex\([\s\S]*?return o;/.test(code)) return undefined;
  const captured = head[2] === 'MargoSSR';
  if (captured && !depth) return undefined;
  const params = head[1].split(',').map((x) => x.replace(/@\w+(\([^)]*\))?\s*/g, '').trim());
  const names = params.map((x) => x.split(':')[0].trim());
  // The varyings are the parameter of type Output, whatever the stage names it (core's shader i, PbrMaterial's varyings).
  const varyings = names[params.findIndex((x) => x.split(':')[1]?.trim() === 'Output')];
  if (!varyings) return undefined;
  // The fragment is kept whole as a function (a discard there still ends the fragment) and wrapped: its colour, with
  // its alpha scaled by the coverage (or, for depth, kept above the threshold).
  const cover = `${varyings}.cover`,
    kept = captured
      ? `if(scatterCoverage(${cover})<=${cover}.w){discard;}return c;}`
      : depth
        ? `if(c.a*scatterCoverage(${cover})<=${cover}.w){discard;}return c;}`
        : `return vec4f(c.rgb,c.a*scatterCoverage(${cover}));}`,
    output = captured ? 'MargoSSR' : '@location(0) vec4f';
  return (
    coverDeclaration +
    coverageShader +
    code
      .replace(struct, struct.slice(0, -1) + `,@location(${at}) cover:vec4f}`)
      .replace(/(@vertex fn vertex\([\s\S]*?)return o;/, '$1o.cover=scatterCover;return o;')
      .replace(head[0], `fn scatterOpaque(${params.join(',')})->${captured ? 'MargoSSR' : 'vec4f'} {`) +
    `\n@fragment fn fragment(${head[1]})->${output} {let c=scatterOpaque(${names.join(',')});${kept}\n`
  );
}

/** Porter and Duff's over: one strip of a covered ring over what is drawn. */
export const coverBlend: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
