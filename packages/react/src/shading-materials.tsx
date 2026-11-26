import type {
  DepthMaterial as NativeDepthMaterial,
  LambertMaterial as NativeLambertMaterial,
  MatcapMaterial as NativeMatcapMaterial,
  NormalMaterial as NativeNormalMaterial,
  PhongMaterial as NativePhongMaterial,
  ToonMaterial as NativeToonMaterial,
  UnlitMaterial as NativeUnlitMaterial,
} from '@margoengine/materials';
import { TextureMaterial, type TextureMaterialProps } from './texture-material.js';

// The options of each native class (what its shading model reads, nothing else), plus what the binding adds to every
// material. Each component is `<TextureMaterial>` with the class's `shading` fixed, so it has the same lifetime: one
// material mesh on the enclosing `<Mesh>`, rebuilt when an option changes and freed on unmount.
type Binding = Pick<TextureMaterialProps, 'geometry' | 'renderOrder' | 'onError'>;
type Options<C extends abstract new (...args: never[]) => object> = NonNullable<ConstructorParameters<C>[0]>;
const shaded =
  <P,>(shading: NonNullable<TextureMaterialProps['shading']>) =>
  (props: P) => <TextureMaterial {...(props as TextureMaterialProps)} shading={shading} />;

/**
 * Props of `<UnlitMaterial>`: the options of `UnlitMaterial` of `@margoengine/materials` (`color` default white, `map`,
 * `emissive`, `opacity` and the rest), plus `geometry`, `renderOrder` (default 0) and `onError` as on
 * `<TextureMaterial>`. Textures are `Texture` objects (`useTexture`).
 */
export type UnlitMaterialProps = Options<typeof NativeUnlitMaterial> & Binding;
/**
 * Props of `<LambertMaterial>`: the options of `LambertMaterial` of `@margoengine/materials` (`color` default white,
 * `map`, `normalMap`, `emissive` and the rest), plus `geometry`, `renderOrder` and `onError`.
 */
export type LambertMaterialProps = Options<typeof NativeLambertMaterial> & Binding;
/**
 * Props of `<PhongMaterial>`: the options of `PhongMaterial` of `@margoengine/materials` (Lambert's, plus `specular`
 * colour and `shininess`), plus `geometry`, `renderOrder` and `onError`.
 */
export type PhongMaterialProps = Options<typeof NativePhongMaterial> & Binding;
/**
 * Props of `<ToonMaterial>`: the options of `ToonMaterial` of `@margoengine/materials` (`steps`, default 3, or a
 * `gradientMap`), plus `geometry`, `renderOrder` and `onError`.
 */
export type ToonMaterialProps = Options<typeof NativeToonMaterial> & Binding;
/**
 * Props of `<NormalMaterial>`: the options of `NormalMaterial` of `@margoengine/materials` (`normalMap`, `opacity` and
 * the rest), plus `geometry`, `renderOrder` and `onError`.
 */
export type NormalMaterialProps = Options<typeof NativeNormalMaterial> & Binding;
/**
 * Props of `<MatcapMaterial>`: the options of `MatcapMaterial` of `@margoengine/materials` (the `matcap` texture,
 * `color` default white, `map` and the rest), plus `geometry`, `renderOrder` and `onError`.
 */
export type MatcapMaterialProps = Options<typeof NativeMatcapMaterial> & Binding;
/**
 * Props of `<DepthMaterial>`: the options of `DepthMaterial` of `@margoengine/materials` (`depthPacking`, grayscale by
 * default), plus `geometry`, `renderOrder` and `onError`.
 */
export type DepthMaterialProps = Options<typeof NativeDepthMaterial> & Binding;

/**
 * An unlit material (`UnlitMaterial`, shading `'basic'`) on the enclosing `<Mesh>`: colour, maps and emissive, no
 * lighting. Every option is live. Like `<TextureMaterial>` it needs `@margoengine/materials` and a mesh whose geometry
 * has UVs (`<BoxGeometry>`, `<SphereGeometry>`, `<PlaneGeometry>`) or a `geometry` prop.
 */
export const UnlitMaterial = /* @__PURE__ */ shaded<UnlitMaterialProps>('basic');
/** A diffuse-only material (`LambertMaterial`, shading `'lambert'`) on the enclosing `<Mesh>`: no highlight. Options are live. */
export const LambertMaterial = /* @__PURE__ */ shaded<LambertMaterialProps>('lambert');
/**
 * Lambert plus a Blinn-Phong highlight (`PhongMaterial`, shading `'phong'`) on the enclosing `<Mesh>`: `specular`
 * colour and `shininess` exponent, both live.
 */
export const PhongMaterial = /* @__PURE__ */ shaded<PhongMaterialProps>('phong');
/** Toon shading (`ToonMaterial`, shading `'toon'`) on the enclosing `<Mesh>`: Lambert's light read through `steps` flat bands or a `gradientMap`. */
export const ToonMaterial = /* @__PURE__ */ shaded<ToonMaterialProps>('toon');
/** View-space normals as colour (`NormalMaterial`, shading `'normal'`) on the enclosing `<Mesh>`; normal maps apply. */
export const NormalMaterial = /* @__PURE__ */ shaded<NormalMaterialProps>('normal');
/** Lit by a matcap image (`MatcapMaterial`, shading `'matcap'`) looked up by the view-space normal, on the enclosing `<Mesh>`. */
export const MatcapMaterial = /* @__PURE__ */ shaded<MatcapMaterialProps>('matcap');
/** Projected depth as colour (`DepthMaterial`, shading `'depth'`) on the enclosing `<Mesh>`, grayscale or RGBA-packed. */
export const DepthMaterial = /* @__PURE__ */ shaded<DepthMaterialProps>('depth');
