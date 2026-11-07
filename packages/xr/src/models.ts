// Controller and hand models that follow an XR session's input sources. Written from the W3C WebXR Device API
// (XRInputSource.gripSpace: origin at the curled fingers, -Z along the held rod towards the thumb, +X out of the back
// of the right hand; skipRendering), the WebXR Gamepads Module ("xr-standard": buttons 0 trigger, 1 squeeze, 2 touchpad,
// 3 thumbstick; axes 0-1 touchpad, 2-3 thumbstick), the WebXR Hand Input Module (25 joints in order, each with a
// radius, -Z along its bone) and the WebXR Input Profiles registry and assets descriptions (profile lists, layouts by
// handedness, component states and visual responses). The built-in models need no files; `fetchProfile` finds a
// device's own model where an app serves the input profile assets.
import { Geometry, PbrMaterial, type EngineKernel, type Mesh } from '@margoengine/core';
import { Quaternion } from '@margoengine/math/quaternion';
import { margoError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRInputSource } from './types.js';

/** What the models need of an `XR`: its controllers and a per-frame hook. */
export interface XRModelsHost {
  readonly controllers: readonly XRController[];
  onFrame(callback: () => void): () => void;
}
/** Options for {@link XRModels.attach}. */
export interface XRModelsOptions {
  /** Draw a controller at each held controller's grip. Default true. */
  controllers?: boolean;
  /** Draw each tracked hand's joints and bones. Default true. */
  hands?: boolean;
  /** Controller colour. Default '#d9dde2'. */
  color?: string;
  /** Colour of a pressed trigger, squeeze, touchpad or thumbstick. Default '#3d8fe0'. */
  pressedColor?: string;
  /** Hand colour. Default '#e3bfa3'. */
  handColor?: string;
}

/** A sphere of radius 1: rings of latitude and longitude. */
function sphere(rings = 8, segments = 12): Geometry {
  const positions: number[] = [],
    indices: number[] = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const theta = (r / rings) * Math.PI,
        phi = (s / segments) * 2 * Math.PI;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  return new Geometry(positions, positions, indices);
}
/** A closed cylinder of radius 1 along z from -0.5 to 0.5. */
function cylinder(segments = 12): Geometry {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (const z of [-0.5, 0.5])
    for (let s = 0; s <= segments; s++) {
      const phi = (s / segments) * 2 * Math.PI;
      positions.push(Math.cos(phi), Math.sin(phi), z);
      normals.push(Math.cos(phi), Math.sin(phi), 0);
    }
  for (let s = 0; s < segments; s++)
    indices.push(s, s + 1, s + segments + 1, s + 1, s + segments + 2, s + segments + 1);
  for (const z of [-0.5, 0.5]) {
    const centre = positions.length / 3;
    positions.push(0, 0, z);
    normals.push(0, 0, Math.sign(z));
    for (let s = 0; s <= segments; s++) {
      const phi = (s / segments) * 2 * Math.PI;
      positions.push(Math.cos(phi), Math.sin(phi), z);
      normals.push(0, 0, Math.sign(z));
    }
    for (let s = 0; s < segments; s++)
      if (z > 0) indices.push(centre, centre + 1 + s, centre + 2 + s);
      else indices.push(centre, centre + 2 + s, centre + 1 + s);
  }
  return new Geometry(positions, normals, indices);
}
/** A bone's cylinder runs along -Z before it is turned onto the bone. */
const NEG_Z = { x: 0, y: 0, z: -1 };
/** The 25 joints' bones: [from, to] in the Hand Input Module's order, the wrist to each metacarpal included. */
export const HAND_BONES: readonly (readonly [number, number])[] = (() => {
  const bones: [number, number][] = [];
  for (const first of [1, 5, 10, 15, 20]) {
    bones.push([0, first]);
    const last = first === 1 ? 4 : first + 4;
    for (let j = first; j < last; j++) bones.push([j, j + 1]);
  }
  return bones;
})();

/** Parts of a controller, in its grip space, in metres. */
interface ControllerParts {
  root: Mesh;
  trigger: Mesh;
  squeeze: Mesh;
  stick: Mesh;
  pad: Mesh;
  /** -1 on a right hand, 1 on a left: the side the palm faces. */
  palm: number;
  meshes: Mesh[];
}
/** A hand: one sphere per joint and one cylinder per bone. */
interface HandParts {
  joints: Mesh[];
  bones: Mesh[];
}

/**
 * Draws a model at every controller's grip and every tracked hand's joints, kept in step with `xr.controllers` each XR
 * frame: a held controller with its trigger, squeeze and thumbstick moving as they are used, a hand as spheres at its
 * joints sized by their radii and cylinders along its bones. An input source with `skipRendering` true (the system
 * already shows it) and an untracked one are hidden. `dispose()` removes the meshes.
 */
export class XRModels {
  private readonly controllerParts = new Map<XRInputSource, ControllerParts>();
  private readonly handParts = new Map<XRInputSource, HandParts>();
  private readonly materials: { body: PbrMaterial; pressed: PbrMaterial; hand: PbrMaterial };
  private readonly geometry: { sphere: Geometry; cylinder: Geometry };
  private readonly unsubscribe: () => void;
  private readonly q = [0, 0, 0, 1];
  private readonly rotation = new Quaternion();
  private readonly joint = { elements: new Float32Array(16) };
  private readonly bone = { x: 0, y: 0, z: 0 };
  private readonly settings: Required<Pick<XRModelsOptions, 'controllers' | 'hands'>>;
  private disposed = false;

  /** Starts drawing `xr`'s inputs in `engine`. */
  static attach(xr: XRModelsHost, engine: EngineKernel, options: XRModelsOptions = {}): XRModels {
    return new XRModels(xr, engine, options);
  }
  private constructor(
    private readonly xr: XRModelsHost,
    private readonly engine: EngineKernel,
    options: XRModelsOptions,
  ) {
    if (typeof xr?.onFrame !== 'function' || !Array.isArray(xr.controllers))
      throw new TypeError('XRModels.attach needs an XR from XR.create; pass the XR, then the engine');
    this.settings = { controllers: options.controllers ?? true, hands: options.hands ?? true };
    this.materials = {
      body: new PbrMaterial({ color: options.color ?? '#d9dde2', roughness: 0.6 }),
      pressed: new PbrMaterial({ color: options.pressedColor ?? '#3d8fe0', roughness: 0.5 }),
      hand: new PbrMaterial({ color: options.handColor ?? '#e3bfa3', roughness: 0.8 }),
    };
    this.geometry = { sphere: sphere(), cylinder: cylinder() };
    this.unsubscribe = xr.onFrame(() => this.update());
  }
  /** The meshes of `source`'s controller model, root first, or undefined before it is first seen. */
  controllerMeshes(source: XRInputSource): readonly Mesh[] | undefined {
    return this.controllerParts.get(source)?.meshes;
  }
  /** The joint and bone meshes of `source`'s hand, or undefined before it is first tracked. */
  handMeshes(source: XRInputSource): { joints: readonly Mesh[]; bones: readonly Mesh[] } | undefined {
    return this.handParts.get(source);
  }

  private part(parent: Mesh, size: [number, number, number], position: [number, number, number]): Mesh {
    return this.engine
      .createMesh()
      .setGeometry(this.geometry.cylinder)
      .setMaterial(this.materials.body)
      .setScale(size)
      .setPosition(position)
      .setParent(parent);
  }
  private controller(source: XRInputSource): ControllerParts {
    let parts = this.controllerParts.get(source);
    if (parts) return parts;
    const root = this.engine.createMesh(),
      // The palm faces -x on a right hand and +x on a left one; the squeeze sits on that side.
      palm = source.handedness === 'left' ? 1 : -1,
      // Handle along z through the grip, head towards the thumb (-z), leaning forward (-y, away from the arm).
      handle = this.part(root, [0.018, 0.02, 0.13], [0, 0, 0.01]),
      head = this.part(root, [0.026, 0.026, 0.035], [0, -0.012, -0.065]),
      trigger = this.part(root, [0.007, 0.012, 0.03], [0, -0.04, -0.035]),
      squeeze = this.part(root, [0.006, 0.012, 0.045], [palm * 0.019, 0, 0.005]),
      stick = this.part(root, [0.008, 0.008, 0.012], [0, -0.012, -0.088]),
      pad = this.part(root, [0.015, 0.015, 0.002], [0, -0.012, -0.083]);
    parts = { root, trigger, squeeze, stick, pad, palm, meshes: [root, handle, head, trigger, squeeze, stick, pad] };
    this.controllerParts.set(source, parts);
    return parts;
  }
  private hand(source: XRInputSource): HandParts {
    let parts = this.handParts.get(source);
    if (parts) return parts;
    const mesh = (geometry: Geometry) =>
      this.engine.createMesh().setGeometry(geometry).setMaterial(this.materials.hand);
    parts = {
      joints: Array.from({ length: 25 }, () => mesh(this.geometry.sphere)),
      bones: HAND_BONES.map(() => mesh(this.geometry.cylinder)),
    };
    this.handParts.set(source, parts);
    return parts;
  }

  /** Moves every model to this frame's poses; runs from the XR frame hook. */
  update(): void {
    if (this.disposed) return;
    const seen = new Set<XRInputSource>();
    for (const controller of this.xr.controllers) {
      const source = controller.source,
        hidden = (source as { skipRendering?: boolean }).skipRendering === true;
      seen.add(source);
      if (source.hand && this.settings.hands) {
        const parts = this.hand(source),
          tracked = !hidden && controller.handTracked[0] === 1;
        this.placeHand(parts, controller, tracked);
      } else if (!source.hand && this.settings.controllers && source.gripSpace) {
        const parts = this.controller(source);
        this.placeController(parts, controller, !hidden && !!controller.grip);
      }
    }
    for (const [source, parts] of this.controllerParts)
      if (!seen.has(source)) {
        for (const mesh of parts.meshes) mesh.dispose();
        this.controllerParts.delete(source);
      }
    for (const [source, parts] of this.handParts)
      if (!seen.has(source)) {
        for (const mesh of [...parts.joints, ...parts.bones]) mesh.dispose();
        this.handParts.delete(source);
      }
  }
  private placeController(parts: ControllerParts, controller: XRController, visible: boolean): void {
    for (const mesh of parts.meshes) mesh.visible = visible;
    if (!visible) return;
    const { position: p, orientation: o } = controller.grip!.transform,
      b = controller.buttons,
      a = controller.axes,
      // xr-standard: trigger 0, squeeze 1, touchpad 2, thumbstick 3; touchpad axes 0 and 1, thumbstick 2 and 3. Any
      // other mapping places its buttons where the device likes, so the parts stay at rest.
      standard = controller.source.gamepad?.mapping === 'xr-standard',
      trigger = standard ? b[0] : 0,
      squeeze = standard ? b[3] : 0,
      stickX = standard && controller.axisCount > 2 ? a[2] : 0,
      stickY = standard && controller.axisCount > 3 ? a[3] : 0,
      pressed = (i: number) => standard && i < controller.buttonCount && b[i * 3 + 1] === 1;
    parts.root.setPosition([p.x, p.y, p.z]).setQuaternion([o.x, o.y, o.z, o.w]);
    // The trigger swings back towards the grip by up to 0.35 radians; the squeeze sinks 4 mm.
    parts.trigger
      .setRotation([trigger * 0.35, 0, 0])
      .setMaterial(pressed(0) ? this.materials.pressed : this.materials.body);
    parts.squeeze
      .setPosition([parts.palm * (0.019 - 0.004 * squeeze), 0, 0.005])
      .setMaterial(pressed(1) ? this.materials.pressed : this.materials.body);
    // The thumbstick leans up to 0.4 radians with its axes and sinks 2 mm when pressed.
    parts.stick
      .setRotation([-stickY * 0.4, 0, stickX * 0.4])
      .setPosition([0, -0.012, pressed(3) ? -0.086 : -0.088])
      .setMaterial(pressed(3) ? this.materials.pressed : this.materials.body);
    parts.pad.setMaterial(pressed(2) ? this.materials.pressed : this.materials.body);
  }
  private placeHand(parts: HandParts, controller: XRController, visible: boolean): void {
    const m = controller.handMatrices,
      r = controller.handRadii,
      q = this.q;
    for (let j = 0; j < 25; j++) {
      const mesh = parts.joints[j];
      mesh.visible = visible;
      if (!visible) continue;
      const radius = r[j] > 0 ? r[j] : 0.008;
      for (let k = 0; k < 16; k++) this.joint.elements[k] = m[j * 16 + k];
      mesh
        .setPosition([m[j * 16 + 12], m[j * 16 + 13], m[j * 16 + 14]])
        .setQuaternion(this.rotation.setFromRotationMatrix(this.joint).toArray(q) as number[])
        .setScale([radius, radius, radius]);
    }
    for (let i = 0; i < HAND_BONES.length; i++) {
      const mesh = parts.bones[i],
        [from, to] = HAND_BONES[i];
      mesh.visible = visible;
      if (!visible) continue;
      const ax = m[from * 16 + 12],
        ay = m[from * 16 + 13],
        az = m[from * 16 + 14],
        dx = m[to * 16 + 12] - ax,
        dy = m[to * 16 + 13] - ay,
        dz = m[to * 16 + 14] - az,
        length = Math.hypot(dx, dy, dz),
        radius = 0.6 * Math.min(r[from] > 0 ? r[from] : 0.008, r[to] > 0 ? r[to] : 0.008);
      if (!length) {
        mesh.visible = false;
        continue;
      }
      mesh
        .setPosition([ax + dx / 2, ay + dy / 2, az + dz / 2])
        .setQuaternion(
          this.rotation
            .setFromUnitVectors(NEG_Z, this.towards(dx / length, dy / length, dz / length))
            .toArray(q) as number[],
        )
        .setScale([radius, radius, length]);
    }
  }
  private towards(x: number, y: number, z: number): { x: number; y: number; z: number } {
    this.bone.x = x;
    this.bone.y = y;
    this.bone.z = z;
    return this.bone;
  }
  /** Removes every model and stops following the session. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const parts of this.controllerParts.values()) for (const mesh of parts.meshes) mesh.dispose();
    for (const parts of this.handParts.values()) for (const mesh of [...parts.joints, ...parts.bones]) mesh.dispose();
    this.controllerParts.clear();
    this.handParts.clear();
  }
  /** Same as {@link XRModels.dispose}, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** One component's state, as the input profile assets describe it. */
export interface ComponentState {
  readonly state: 'default' | 'touched' | 'pressed';
  /** The button's value, 0 to 1. */
  readonly button: number;
  /** The x and y axes, -1 to 1, where the component has them. */
  readonly xAxis: number;
  readonly yAxis: number;
}
/** The parts of an input profile asset file that the model needs: its layouts by handedness. */
export interface InputProfile {
  readonly profileId: string;
  readonly layouts: Readonly<
    Record<
      string,
      {
        readonly assetPath?: string;
        readonly rootNodeName?: string;
        readonly gamepad?: {
          readonly buttons: readonly (string | null)[];
          readonly axes: readonly ({ readonly componentId: string; readonly axis: 'xAxis' | 'yAxis' } | null)[];
        };
        readonly components: Readonly<
          Record<
            string,
            {
              readonly visualResponses?: Readonly<
                Record<
                  string,
                  {
                    readonly componentProperty: 'button' | 'xAxis' | 'yAxis' | 'state';
                    readonly states: readonly ('default' | 'touched' | 'pressed')[];
                    readonly valueNodeProperty: 'transform' | 'visibility';
                  } | null
                >
              >;
            }
          >
        >;
      }
    >
  >;
}
/** What {@link fetchProfile} found for an input source. */
export interface FoundProfile {
  /** The profile id that matched, from the source's `profiles`, most specific first. */
  readonly id: string;
  readonly profile: InputProfile;
  /** The layout for the source's handedness. */
  readonly layout: InputProfile['layouts'][string];
  /** Absolute URL of the layout's model file. */
  readonly assetUrl: string;
}

/** The layout of `profile` for `handedness`: its own key, or a key that joins several handednesses with hyphens. */
export function profileLayout(profile: InputProfile, handedness: string): InputProfile['layouts'][string] | undefined {
  for (const [key, layout] of Object.entries(profile.layouts ?? {}))
    if (key === handedness || key.split('-').includes(handedness)) return layout;
  return undefined;
}

/**
 * Finds `source`'s model in the input profile assets served at `base` (a folder URL holding `profilesList.json` and a
 * folder per profile): the first of `source.profiles` that the list holds, else `fallback`, then its `profile.json`
 * and the layout for the source's handedness. Margo ships no such files; serve the assets your app uses.
 * @throws MargoError 'unsupported' when no profile of the source or the fallback is listed; 'failed' when a file fails.
 */
export async function fetchProfile(
  source: Pick<XRInputSource, 'profiles' | 'handedness'>,
  base: string | URL,
  { fallback = 'generic-trigger', signal }: { fallback?: string; signal?: AbortSignal } = {},
): Promise<FoundProfile> {
  const root = new URL(String(base).endsWith('/') ? String(base) : `${base}/`, globalThis.location?.href),
    get = async (url: URL) => {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw margoError(
          'failed',
          `${url} answered ${response.status}; serve the input profile assets at the base URL`,
        );
      return response.json();
    },
    list = (await get(new URL('profilesList.json', root))) as Record<string, { path: string; deprecated?: boolean }>,
    id = [...source.profiles, fallback].find((name) => Object.hasOwn(list, name));
  if (!id)
    throw margoError(
      'unsupported',
      `No input profile listed for ${source.profiles.join(', ') || 'this source'}; pass a listed fallback`,
    );
  const url = new URL(list[id].path, root),
    profile = (await get(url)) as InputProfile,
    layout = profileLayout(profile, source.handedness);
  if (!layout)
    throw margoError(
      'unsupported',
      `Profile ${id} has no layout for handedness '${source.handedness}'; use another profile`,
    );
  return { id, profile, layout, assetUrl: new URL(layout.assetPath ?? `${source.handedness}.glb`, url).href };
}

/** Each component's state this frame, from the layout's gamepad mapping and `controller`'s buttons and axes. */
export function componentStates(
  layout: InputProfile['layouts'][string],
  controller: Pick<XRController, 'buttons' | 'axes' | 'buttonCount' | 'axisCount'>,
): Record<string, ComponentState> {
  const out: Record<string, { state: ComponentState['state']; button: number; xAxis: number; yAxis: number }> = {};
  for (const id of Object.keys(layout.components ?? {})) out[id] = { state: 'default', button: 0, xAxis: 0, yAxis: 0 };
  const buttons = layout.gamepad?.buttons ?? [],
    axes = layout.gamepad?.axes ?? [];
  for (let i = 0; i < buttons.length && i < controller.buttonCount; i++) {
    const id = buttons[i];
    if (!id || !out[id]) continue;
    const entry = out[id];
    entry.button = controller.buttons[i * 3];
    entry.state = controller.buttons[i * 3 + 1] ? 'pressed' : controller.buttons[i * 3 + 2] ? 'touched' : 'default';
  }
  for (let i = 0; i < axes.length && i < controller.axisCount; i++) {
    const axis = axes[i];
    if (axis && out[axis.componentId]) out[axis.componentId][axis.axis] = controller.axes[i];
  }
  return out;
}

/**
 * How far a visual response goes, 0 (its `_min` node, or hidden) to 1 (its `_max` node, or shown): the button value,
 * an axis mapped from -1..1 to 0..1, or for `state` whether the component is in one of the response's states. Outside
 * those states a response rests: 0 for a button or a state, 0.5 for an axis.
 */
export function responseWeight(
  response: { componentProperty: 'button' | 'xAxis' | 'yAxis' | 'state'; states: readonly string[] },
  component: ComponentState,
): number {
  const active = response.states.includes(component.state);
  switch (response.componentProperty) {
    case 'button':
      return active ? component.button : 0;
    case 'xAxis':
      return active ? (component.xAxis + 1) / 2 : 0.5;
    case 'yAxis':
      return active ? (component.yAxis + 1) / 2 : 0.5;
    default:
      return active ? 1 : 0;
  }
}
