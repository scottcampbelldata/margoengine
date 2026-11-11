import { MargoError } from '@margoengine/math/errors';
import { orthographic } from '../../shared/projection.js';

/** `DOFLens` settings. */
export interface DOFLensOptions {
  /** Aperture blades, 3 to 16: the bokeh becomes this polygon. Fixed at construction. Default: round. */
  blades?: number;
  /** Turn of the bokeh polygon in radians. Fixed at construction. Default 0. */
  bladeRotation?: number;
  /** Tilt of the focal plane in radians, under 1.5 either way; 0 keeps it facing the camera. Default 0. */
  tilt?: number;
  /** Screen direction `[right, up]` in which a positive tilt moves the focal plane further away. Default `[0, 1]`. */
  tiltDirection?: readonly [number, number];
  /**
   * Custom bokeh shape (hearts, stars, dirty glass): light passes where the image is bright, as luminance times
   * alpha, partly where it is grey. The image's inscribed circle covers the blur disk, its top towards the top of the
   * screen. Fixed at construction; not with `blades`. Default: none.
   */
  aperture?: DOFApertureImage;
  /**
   * Optical vignetting: towards the frame's edges the bokeh is clipped by a second circle, the lens barrel, into a
   * cat's eye whose long side runs around the frame. The clipping circle's offset at the frame corners, in bokeh radii,
   * 0 to 1.5; it grows linearly from 0 at the centre. Fixed at construction; not with `aperture`. Default 0.
   */
  catEye?: number;
  /**
   * Anamorphic squeeze: the bokeh is an oval this many times taller than wide (1.33, 1.5 and 2 are common anamorphic
   * lenses), 1 to 4. Fixed at construction; not with `aperture`. Default 1, round.
   */
  anamorphic?: number;
}
/** The shaders a {@link DOFLens} rewrites. */
export interface DOFLensShaders {
  readonly cocShader: string;
  readonly coarseShader: string;
  readonly bokehShader: string;
  readonly groupMax: string;
}

const CIRCLE =
  'let radius=clamp(p.frame.z*select(1.0-p.lens.x/z,(z-p.lens.x)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;';
// The focal plane through the focal point: 1/focus is linear in clip x and y under a perspective camera, and focus itself
// under an orthographic one. p.ortho.yz holds the tilt per clip unit. The thin-lens scale follows the focus at each pixel.
const TILTED = `let n=(vec2f(id.xy)+0.5)/vec2f(textureDimensions(coc))*vec2f(2,-2)+vec2f(-1,1);let t=dot(p.ortho.yz,n);
    let focus=max(select(p.lens.x/max(1.0-t,1e-4),p.lens.x+t,ortho),p.lens.y*1.001);
    let radius=clamp(select(p.frame.z*(p.lens.x-p.lens.y)/(focus-p.lens.y)*(1.0-focus/z),p.frame.z*(z-focus)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;`;

/** An aperture image for {@link DOFLensOptions.aperture}: RGBA bytes row by row, top row first, as `ImageData` holds them. */
export interface DOFApertureImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

// The aperture is baked into the kernels: a GRID x GRID transmission mask over the unit disk, and per far-gather tap
// count a table of taps spread evenly over the shape.
const GRID = 32,
  CANDIDATES = 4096,
  GOLDEN = 2.39996323;

/** Transmission 0..1 of `image` (luminance times alpha), box-filtered into the cells of its inscribed circle. */
function apertureMask(image: DOFApertureImage): Float32Array {
  const { width: w, height: h, data } = image ?? ({} as DOFApertureImage);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !data || data.length < w * h * 4)
    throw new RangeError('Invalid DOFLens aperture; use RGBA bytes of width x height pixels, such as ImageData');
  const texel = (x: number, y: number) => {
      const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      return ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * data[i + 3]) / 65025;
    },
    // Bilinear between texel centres, so an image smaller than the grid stays smooth.
    sample = (u: number, v: number) => {
      const x = u * w - 0.5,
        y = v * h - 0.5,
        x0 = Math.floor(x),
        y0 = Math.floor(y),
        fx = x - x0,
        fy = y - y0;
      return (
        (texel(x0, y0) * (1 - fx) + texel(x0 + 1, y0) * fx) * (1 - fy) +
        (texel(x0, y0 + 1) * (1 - fx) + texel(x0 + 1, y0 + 1) * fx) * fy
      );
    },
    mask = new Float32Array(GRID * GRID),
    sub = 8;
  let max = 0;
  for (let gy = 0; gy < GRID; gy++)
    for (let gx = 0; gx < GRID; gx++) {
      const u = ((gx + 0.5) / GRID) * 2 - 1,
        v = ((gy + 0.5) / GRID) * 2 - 1;
      if (u * u + v * v > 1) continue;
      let sum = 0;
      for (let sy = 0; sy < sub; sy++)
        for (let sx = 0; sx < sub; sx++) sum += sample((gx + (sx + 0.5) / sub) / GRID, (gy + (sy + 0.5) / sub) / GRID);
      const t = sum / (sub * sub);
      if (!Number.isFinite(t))
        throw new RangeError('Invalid DOFLens aperture; its bytes must be numbers from 0 to 255');
      mask[gy * GRID + gx] = t;
      max = Math.max(max, t);
    }
  if (!(max > 0))
    throw new RangeError('Invalid DOFLens aperture; the image lets no light through its inscribed circle');
  for (let i = 0; i < mask.length; i++) mask[i] /= max;
  return mask;
}

/** The mask at `[x, y]` on the unit disk (y down, as on screen), bilinear like the kernels' `aperture()`. */
function apertureAt(mask: Float32Array, x: number, y: number): number {
  const gx = (x * 0.5 + 0.5) * GRID - 0.5,
    gy = (y * 0.5 + 0.5) * GRID - 0.5,
    ix = Math.floor(gx),
    iy = Math.floor(gy),
    fx = gx - ix,
    fy = gy - iy,
    cell = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID ? 0 : mask[cy * GRID + cx]);
  return (
    (cell(ix, iy) * (1 - fx) + cell(ix + 1, iy) * fx) * (1 - fy) +
    (cell(ix, iy + 1) * (1 - fx) + cell(ix + 1, iy + 1) * fx) * fy
  );
}

/**
 * `n` far-gather taps `[x, y, weight]`: a gathering pixel takes a neighbour at offset `s * radius` when the
 * neighbour's bokeh covers it, that is when `-s` lies on the aperture, so the taps spread evenly (farthest-point
 * sampling of a Vogel spiral) over the mirrored shape and carry its transmission as their weight.
 */
function apertureTaps(mask: Float32Array, n: number): Float32Array {
  const points: number[][] = [];
  for (let j = 0; j < CANDIDATES; j++) {
    const r = Math.sqrt((j + 0.5) / CANDIDATES),
      a = j * GOLDEN,
      x = r * Math.cos(a),
      y = r * Math.sin(a),
      t = apertureAt(mask, -x, -y);
    if (t > 1 / 64) points.push([x, y, t]);
  }
  if (!points.length) throw new RangeError('Invalid DOFLens aperture; its open area is too small to sample');
  const taps = new Float32Array(n * 3),
    gap = new Float64Array(points.length).fill(Infinity);
  // First tap: the candidate nearest the shape's centroid; then each next one farthest from those taken.
  let cx = 0,
    cy = 0;
  for (const [x, y] of points) {
    cx += x / points.length;
    cy += y / points.length;
  }
  let pick = 0;
  for (let k = 0; k < points.length; k++)
    if (Math.hypot(points[k][0] - cx, points[k][1] - cy) < Math.hypot(points[pick][0] - cx, points[pick][1] - cy))
      pick = k;
  for (let i = 0; i < n; i++) {
    const [x, y, t] = points[pick];
    taps.set([x, y, t], i * 3);
    let next = 0;
    for (let k = 0; k < points.length; k++) {
      gap[k] = Math.min(gap[k], Math.hypot(points[k][0] - x, points[k][1] - y));
      if (gap[k] > gap[next]) next = k;
    }
    pick = next;
  }
  return taps;
}

// Every occurrence of `from`, which must occur `count` times.
// The covers test of the far gather's front samples, as the DOF shaders define it.
const REACH = 'fn covers(o:vec2f,radius:f32,pixel:vec2i)->f32 {return select(0.0,1.0,length(o)<=radius);}';

function editAll(source: string, from: string, to: string, count: number): string {
  if (source.split(from).length !== count + 1)
    throw new MargoError('unsupported', 'DOFLens needs the DOF shaders of its own version; update both together');
  return source.split(from).join(to);
}
const list = (values: ArrayLike<number>) => Array.from(values, (v) => `${+v.toFixed(5)}`).join(',');

/** The far gathers take their taps from the aperture tables; the near gather weighs each foreground disk by its mask. */
function apertureShaders(out: DOFLensShaders, mask: Float32Array): DOFLensShaders {
  let mean = 0,
    inside = 0;
  for (let j = 0; j < 4096; j++) {
    const r = Math.sqrt((j + 0.5) / 4096),
      a = j * GOLDEN;
    mean += apertureAt(mask, r * Math.cos(a), r * Math.sin(a));
    inside++;
  }
  mean /= inside;
  const tables = [16, 32, 64]
      .map(
        (n) =>
          `var<private> taps${n}:array<vec3f,${n}>=array<vec3f,${n}>(${apertureTaps(mask, n).reduce<string[]>(
            (all, _, i, t) => (i % 3 ? all : [...all, `vec3f(${list(t.subarray(i, i + 3))})`]),
            [],
          )});`,
      )
      .join('\n'),
    functions = `var<private> mask:array<f32,${GRID * GRID}>=array<f32,${GRID * GRID}>(${list(mask)});
${tables}
fn tap(i:u32,n:f32)->vec3f {if(n<20.0){return taps16[i];}if(n<40.0){return taps32[i];}return taps64[i];}
fn cell(c:vec2i)->f32 {if(any(c<vec2i(0))||any(c>=vec2i(${GRID}))){return 0.0;}return mask[c.y*${GRID}+c.x];}
fn aperture(v:vec2f)->f32 {
  let g=(v*0.5+0.5)*${GRID}.0-0.5;let c=vec2i(floor(g));let f=g-floor(g);
  return mix(mix(cell(c),cell(c+vec2i(1,0)),f.x),mix(cell(c+vec2i(0,1)),cell(c+vec2i(1,1)),f.x),f.y);
}
fn spiral(i:u32,n:f32)->vec2f {`,
    tapsFar = (code: string, sizes: number[]) =>
      editAll(
        sizes.reduce(
          (c, n) =>
            editAll(
              c,
              `let farPixel=clamp(pixel+vec2i(round(spiral(i,${n}.0)*center.x)),vec2i(0),limit);`,
              `let farTap=tap(i,${n}.0);let farPixel=clamp(pixel+vec2i(round(farTap.xy*center.x)),vec2i(0),limit);`,
              1,
            ),
          editAll(code, 'fn spiral(i:u32,n:f32)->vec2f {', functions, 1),
        ),
        '{farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;}',
        '{farColor+=textureLoad(scene,farPixel,0).rgb*farTap.z;farWeight+=farTap.z;}',
        sizes.length,
      ),
    // A far sample in front reaches the center where -offset / radius lies on the aperture, weighted as a near one.
    far = (code: string, sizes: number[]) =>
      editAll(
        editAll(tapsFar(code, sizes), 'let farW=1.0;', 'let farW=farTap.z;', sizes.length),
        REACH,
        `${REACH.slice(0, -2)}*aperture(-o/radius)/${mean.toFixed(6)};}`,
        1,
      );
  return {
    ...out,
    coarseShader: far(out.coarseShader, [64]),
    // A foreground pixel at offset o covers this one when -o / radius lies on the aperture; dividing by the mean
    // transmission over the disk keeps a fully covered pixel's near weight at 64 taps' worth, as for the round disk.
    bokehShader: editAll(
      far(out.bokehShader, [64, 32, 16]),
      'let weight=p.lens.w*p.lens.w/max(radius*radius,1.0);',
      `let weight=p.lens.w*p.lens.w/max(radius*radius,1.0)*aperture(-vec2f(nearOffset)/radius)/${mean.toFixed(6)};`,
      1,
    ),
  };
}

/**
 * Cat's eye and anamorphic bokeh. Anamorphic: the far taps shrink across by the squeeze (they stay even over the
 * oval), the near taps keep the whole disk and test each foreground disk's oval, and a near weight grows by the squeeze
 * as the oval holds that many times fewer taps. Cat's eye: a tap counts when its bokeh-space offset also lies in the
 * barrel circle, offset by `catEye` times the pixel's place in the frame (1 at the corners); a near weight is divided by
 * the area the two circles share, so a covered pixel stays covered.
 */
function opticsShaders(out: DOFLensShaders, catEye: number, squeeze: number): DOFLensShaders {
  if (!catEye && squeeze === 1) return out;
  const a = squeeze.toFixed(6),
    functions = `fn barrel(pixel:vec2i)->vec2f {let size=vec2f(textureDimensions(coc));return ${catEye.toFixed(6)}*(vec2f(pixel)+0.5-size*0.5)/(0.5*length(size));}
fn eye(v:vec2f,pixel:vec2i)->f32 {return select(0.0,1.0,length(v-barrel(pixel))<=1.0);}
fn lensArea(pixel:vec2i)->f32 {let d=min(length(barrel(pixel)),1.99);return (2.0*acos(d*0.5)-0.5*d*sqrt(4.0-d*d))/3.14159265;}
fn spiral(i:u32,n:f32)->vec2f {`,
    tapsFar = (code: string, sizes: number[]) =>
      editAll(
        sizes.reduce(
          (c, n) =>
            editAll(
              c,
              `let farPixel=clamp(pixel+vec2i(round(spiral(i,${n}.0)*center.x)),vec2i(0),limit);`,
              `let farTap=spiral(i,${n}.0);let farPixel=clamp(pixel+vec2i(round(farTap*center.x)),vec2i(0),limit);`,
              1,
            ),
          editAll(
            editAll(code, 'fn spiral(i:u32,n:f32)->vec2f {', functions, 1),
            'vec2f(cos(angle),sin(angle))',
            `vec2f(cos(angle)/${a},sin(angle))`,
            1,
          ),
        ),
        '{farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;}',
        '{let w=eye(-farTap,pixel);farColor+=textureLoad(scene,farPixel,0).rgb*w;farWeight+=w;}',
        sizes.length,
      ),
    // A front far sample's disk is squeezed like the far taps, so its area ratio to the center's needs no squeeze term.
    far = (code: string, sizes: number[]) =>
      editAll(
        editAll(
          editAll(tapsFar(code, sizes), 'let farW=1.0;', 'let farW=eye(-farTap,pixel);', sizes.length),
          'length(o)<=',
          `length(o*vec2f(${a},1.0))<=`,
          1,
        ),
        'radius:f32,pixel:vec2i)->f32 {return ',
        'radius:f32,pixel:vec2i)->f32 {return eye(-o/radius,pixel)/lensArea(pixel)*',
        1,
      ).replace('radius*shape(atan2(o.y,o.x))', `radius*shape(atan2(o.y,o.x*${a}))`);
  let bokeh = far(out.bokehShader, [64, 32, 16]);
  bokeh = editAll(
    bokeh,
    'fn disk(i:u32)->vec2f {return spiral(i,64.0);}',
    `fn disk(i:u32)->vec2f {let s=spiral(i,64.0);return vec2f(s.x*${a},s.y);}`,
    1,
  );
  // A polygon's boundary is looked up at the angle of the offset unsqueezed.
  bokeh = bokeh
    .split('radius*shape(f32(i)*2.39996323)')
    .join(`radius*shape(atan2(f32(nearOffset.y),f32(nearOffset.x)*${a}))`);
  bokeh = editAll(bokeh, 'length(vec2f(nearOffset))<=radius', `length(vec2f(nearOffset)*vec2f(${a},1.0))<=radius`, 1);
  bokeh = editAll(
    bokeh,
    'let weight=p.lens.w*p.lens.w/max(radius*radius,1.0);',
    `let weight=p.lens.w*p.lens.w/max(radius*radius,1.0)*${a}*eye(-vec2f(nearOffset)/radius,pixel)/lensArea(pixel);`,
    1,
  );
  return { ...out, coarseShader: far(out.coarseShader, [64]), bokehShader: bokeh };
}

function edit(source: string, edits: readonly [string, string][]): string {
  return edits.reduce((code, [from, to]) => {
    if (code.split(from).length !== 2)
      throw new MargoError('unsupported', 'DOFLens needs the DOF shaders of its own version; update both together');
    return code.replace(from, to);
  }, source);
}

/**
 * Lens shape for `DOF`: a tilted focal plane (tilt-shift), and polygon bokeh from aperture blades or any bokeh shape
 * from an aperture image. Pass one as
 * `DOF.attach(engine, {lens})`. `tilt` and `tiltDirection` are read every frame.
 * @throws RangeError when an option is out of range.
 */
export class DOFLens {
  /** See {@link DOFLensOptions.tilt}. */
  tilt: number;
  /** See {@link DOFLensOptions.tiltDirection}. */
  tiltDirection: readonly [number, number];
  private readonly blades?: number;
  private readonly bladeRotation: number;
  private readonly mask?: Float32Array;
  private readonly catEye: number;
  private readonly anamorphic: number;

  constructor({
    blades,
    bladeRotation = 0,
    tilt = 0,
    tiltDirection = [0, 1],
    aperture,
    catEye = 0,
    anamorphic = 1,
  }: DOFLensOptions = {}) {
    if (blades !== undefined && (!Number.isInteger(blades) || blades < 3 || blades > 16))
      throw new RangeError('Invalid DOFLens blades; use a whole number from 3 to 16');
    if (aperture !== undefined && blades !== undefined)
      throw new RangeError('Invalid DOFLens; give blades or an aperture image, not both');
    if (!(catEye >= 0 && catEye <= 1.5)) throw new RangeError('Invalid DOFLens catEye; use bokeh radii from 0 to 1.5');
    if (!(anamorphic >= 1 && anamorphic <= 4))
      throw new RangeError('Invalid DOFLens anamorphic; use a squeeze from 1 to 4');
    if (aperture !== undefined && (catEye || anamorphic !== 1))
      throw new RangeError('Invalid DOFLens; catEye and anamorphic do not combine with an aperture image');
    this.catEye = catEye;
    this.anamorphic = anamorphic;
    if (aperture !== undefined) this.mask = apertureMask(aperture);
    if (!Number.isFinite(bladeRotation)) throw new RangeError('Invalid DOFLens bladeRotation; use finite radians');
    this.blades = blades;
    this.bladeRotation = bladeRotation;
    this.tilt = tilt;
    this.tiltDirection = tiltDirection;
    this.check();
  }
  private check(): void {
    const [x, y] = this.tiltDirection;
    if (!(Math.abs(this.tilt) < 1.5) || !Number.isFinite(x) || !Number.isFinite(y) || !(x || y))
      throw new RangeError('Invalid DOFLens tilt; use radians under 1.5 either way and a non-zero tiltDirection');
  }
  /** The DOF kernels rewritten for this lens. Called by `DOF` when it builds its pipelines. */
  shaders(source: DOFLensShaders): DOFLensShaders {
    const out = { ...source, cocShader: edit(source.cocShader, [[CIRCLE, TILTED]]) };
    if (this.mask) return apertureShaders(out, this.mask);
    const n = this.blades;
    if (n === undefined) return opticsShaders(out, this.catEye, this.anamorphic);
    // Scaling each tap by the polygon's boundary at its angle keeps the taps uniform over the polygon.
    const sector = (2 * Math.PI) / n,
      inner = Math.cos(Math.PI / n),
      shape = `fn shape(a:f32)->f32 {let m=a-${this.bladeRotation};return ${inner}/cos(m-${sector}*floor(m/${sector})-${sector / 2});}
fn spiral(i:u32,n:f32)->vec2f {`,
      taps: [string, string][] = [
        ['fn spiral(i:u32,n:f32)->vec2f {', shape],
        ['return sqrt((f32(i)+0.5)/n)*vec2f', 'return sqrt((f32(i)+0.5)/n)*shape(angle)*vec2f'],
      ];
    out.coarseShader = edit(source.coarseShader, taps);
    out.bokehShader = edit(source.bokehShader, [
      ...taps,
      // The near gather's reach and its reach test follow the polygon: its taps lie closer, down to the inner circle.
      ['pow((nearMax+1.0)/p.lens.w,2.0)', `pow((nearMax+1.0)/(p.lens.w*${inner}),2.0)`],
      ['length(vec2f(nearOffset))<=radius', 'length(vec2f(nearOffset))<=radius*shape(f32(i)*2.39996323)'],
      [REACH, REACH.replace('length(o)<=radius', 'length(o)<=radius*shape(atan2(o.y,o.x))')],
    ]);
    out.coarseShader = edit(out.coarseShader, [[REACH, REACH.replace('length(o)<=radius', 'length(o)<=radius*shape(atan2(o.y,o.x))')]]);
    return opticsShaders(out, this.catEye, this.anamorphic);
  }
  /** Writes the tilt per clip unit into the free uniform slots 9 and 10. Called by `DOF` every frame. */
  write(
    values: Float32Array,
    camera: { fov: number; matrix: Float32Array; position: ArrayLike<number> },
    aspect: number,
  ): void {
    this.check();
    const [x, y] = this.tiltDirection,
      slope = Math.tan(this.tilt) / Math.hypot(x, y),
      ortho = orthographic(camera.matrix, camera.position),
      half = Math.tan((camera.fov * Math.PI) / 360);
    values[9] = slope * x * (ortho ? 1 / ortho.sx : half * aspect);
    values[10] = slope * y * (ortho ? 1 / ortho.sy : half);
  }
}
