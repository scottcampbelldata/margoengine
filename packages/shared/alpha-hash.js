// Hashed alpha testing (Wyman and McGuire 2017, "Hashed Alpha Testing", I3D): the alpha test compares against a noise
// value instead of a fixed cutoff, so opacity comes out as coverage. The noise is a hash of the object-space position
// at a grid about one pixel (or shadow-map texel) across, which keeps it on the surface as the object, camera or light
// moves; two power-of-two grids are blended so the pattern does not pop as the distance changes, and the blend's sum is
// remapped back to a uniform distribution (the paper's CDF correction). The cell hash is pcg3d (Jarzynski and Olano 2020).
// Shared by materials' alphaHash() colour pass and the shadow casters of @margoengine/shadows, @margoengine/clustered and
// @margoengine/studio (hashedDepth below, which the materials record hands them as castHashed, so only an app that
// imports alphaHash carries this WGSL), so a hashed surface and its shadow use one noise.

/** WGSL of `margoHashCell` and `margoAlphaHash(p)`: the threshold at object position `p`, `scale` cells per pixel (a WGSL float literal). */
export const alphaHashCode = (scale) => `fn margoHashCell(cell:vec3f)->f32 {
  var v=bitcast<vec3u>(vec3i(floor(cell)))*1664525u+1013904223u;
  v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; v^=v>>vec3u(16u); v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y;
  return f32(v.x>>8u)/16777216.0;
}
fn margoAlphaHash(p:vec3f)->f32 {
  let footprint=max(length(dpdx(p)),length(dpdy(p))); let level=log2(${scale}/max(footprint,1e-20)); let low=floor(level);
  let t=level-low; let x=mix(margoHashCell(p*exp2(low)),margoHashCell(p*exp2(low+1.0)),t); let a=max(min(t,1.0-t),1e-6);
  let middle=(x-0.5*a)/(1.0-a); let spread=2.0*a*(1.0-a);
  let edge=select(1.0-(1.0-x)*(1.0-x)/spread,x*x/spread,x<a);
  return clamp(select(edge,middle,x>=a&&x<1.0-a),1e-6,1.0);
}
`;

/**
 * A caster shader whose cut-out compares alpha against hashed noise instead of the cutoff, for a primitive whose
 * `hashed` is this function (materials `alphaHash()`): the same object-space hash as the colour pass at one cell per
 * shadow-map texel, so a surface at 30% opacity keeps about 30% of its caster texels and its shadow fades with it
 * (Wyman and McGuire 2017). The vertex stage must read `i.position` and write `var o:...Out;`, and the fragment test
 * be `<(name).alpha.y){discard;}`; location 5 must be free. Apply it before shared/caster.js `clippedDepth`.
 */
export function hashedDepth(code) {
  const out = code
    .replace(/struct (\w*Out) \{/, 'struct $1 {@location(5) margoObject:vec3f,')
    .replace(/var o:\w*Out;/, '$&o.margoObject=i.position.xyz;')
    // The derivatives run before the test, in uniform control flow.
    .replace(/@fragment fn fragment\(i:\w+\)(?:->@location\(0\) vec4f)? ?\{/, '$&let margoCut=margoAlphaHash(i.margoObject);')
    .replace(/<\w+\.alpha\.y\) ?\{discard;\}/, '<margoCut){discard;}');
  if (!out.includes('o.margoObject=') || !out.includes('let margoCut=') || !out.includes('<margoCut){discard;}'))
    throw new TypeError('Hashed shadow casters need a depth shader with an alpha cut-out; draw them with a caster shader');
  return alphaHashCode('1e+0') + out;
}
