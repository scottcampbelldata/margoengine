// @margoengine/blender/components: tagged `margo:` custom properties of a static .margo scene become glTF Pro colliders,
// physics bodies, punctual lights and named scripts on load, as Godot's and Unity's import pipelines read tagged
// objects. The tags become KHR_implicit_shapes, KHR_physics_rigid_bodies, KHR_lights_punctual and glTF cameras in the
// decoded document, so glTF Pro's own readers (`applyGLTFPhysics`, `applyGLTFLights`, `viewGLTFCamera`) do the rest.
// The add-on writes the tags itself for Blender's lights and cameras, so a lit, framed scene opens as authored.
import type { EngineKernel } from "@margoengine/core";
import {
  parsePreparedPBR,
  type GLTFDocument,
  type GLTFLightReceiver,
  type PBRModel,
} from "@margoengine/gltf-pro/model";
import type {
  GLTFPhysics,
  GLTFPhysicsOptions,
} from "@margoengine/gltf-pro/physics";
import { readResponse } from "../../shared/loading.js";
import { decodeImages, maxBytes } from "./container.js";
import { decodeMargo, type MargoAsset, type MargoOptions } from "./index.js";

type Json = Record<string, unknown>;
type Vec3 = [number, number, number];
type Properties = Readonly<Record<string, string | number | boolean | readonly number[]>>;

/** What a script is given for one tagged object. */
export interface MargoScriptContext {
  /** The object's scene node in the model. */
  readonly node: PBRModel["nodes"][number];
  /** Its index in `model.asset.doc.nodes`. */
  readonly nodeIndex: number;
  /** Every `margo:` property of the object, as exported. */
  readonly properties: Properties;
  readonly model: PBRModel;
  /** The physics of the scene, when any object has a collider or body. */
  readonly physics?: GLTFPhysics;
}
/** A script: runs once per object that names it, after physics and lights; may return a cleanup that `dispose` calls. */
export type MargoScript = (context: MargoScriptContext) => void | (() => void);
/** One `margo:script` use, found without a GPU. */
export interface MargoScriptUse {
  readonly name: string;
  readonly nodeIndex: number;
  readonly properties: Properties;
}
/** The document with the components as glTF extensions, and the scripts it names. */
export interface MargoComponentsDocument {
  /** A copy of the asset's document: tagged nodes carry KHR_physics_rigid_bodies and KHR_lights_punctual; added
   * collider nodes (one per offset collider) follow the exported nodes. */
  readonly document: GLTFDocument;
  readonly scripts: readonly MargoScriptUse[];
  /** True when any object has a collider, body or trigger. */
  readonly hasPhysics: boolean;
  /** True when any object is a light. */
  readonly hasLights: boolean;
  /** The node index of the camera the scene opens with (the one tagged `margo:active`, else the first), if any. */
  readonly camera?: number;
}
/** Options of {@link parseMargoComponents} and {@link loadMargoComponents}. */
export interface MargoComponentsOptions extends MargoOptions {
  signal?: AbortSignal;
  /** Scripts by the names `margo:script` uses. A name not here is an error. */
  scripts?: Readonly<Record<string, MargoScript>>;
  /** Passed to `applyGLTFPhysics`: the world to add to (default a new one on the engine). */
  physics?: GLTFPhysicsOptions["physics"];
  /** Passed to `applyGLTFLights`: the @margoengine/clustered instance for point and spot lights, and the exposure. */
  clustered?: GLTFLightReceiver;
  exposure?: number;
  /** Views through the scene's camera ({@link MargoComponentsDocument.camera}) when it has one (default true). */
  view?: boolean;
}
/** A loaded scene with its components. */
export interface MargoScene {
  readonly model: PBRModel;
  /** The scene's physics, when any object has a collider, body or trigger. */
  readonly physics?: GLTFPhysics;
  /** Runs the scripts' cleanups, removes the lights from `clustered`, the bodies, then the model. */
  dispose(): void;
}

const bodies = new Set(["static", "dynamic", "kinematic"]),
  shapes = new Set(["box", "sphere", "capsule", "cylinder"]),
  lights = new Set(["point", "spot", "directional"]),
  cameraTypes = new Set(["perspective", "orthographic"]),
  known = new Set([
    "margo:collider",
    "margo:body",
    "margo:trigger",
    "margo:mass",
    "margo:friction",
    "margo:restitution",
    "margo:size",
    "margo:light",
    "margo:color",
    "margo:intensity",
    "margo:range",
    "margo:inner_cone",
    "margo:outer_cone",
    "margo:script",
    "margo:camera",
    "margo:yfov",
    "margo:ymag",
    "margo:aspect",
    "margo:znear",
    "margo:zfar",
    "margo:active",
  ]);
/** Edit distance, to catch a misspelt tag (`margo:colider`) that would otherwise stay a plain property. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
const record = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The local box of a mesh's decoded vertices (80-byte layout: position at float 0). */
function meshBounds(geometry: MargoAsset["geometry"][number]): [Vec3, Vec3] {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { vertices } of geometry)
    for (let i = 0; i < vertices.length; i += 20)
      for (let axis = 0; axis < 3; axis++) {
        const v = vertices[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
  return [min, max];
}

/**
 * Turns the `margo:` tags of a decoded static scene into glTF extensions, without a GPU (FORMAT.md, "Components").
 * Throws a TypeError naming the object for a tag it cannot read.
 *
 * @example
 * const { document, scripts } = margoComponents(decodeMargo(bytes));
 * console.log(document.extensions?.KHR_implicit_shapes, scripts.map((s) => s.name));
 */
export function margoComponents(asset: MargoAsset): MargoComponentsDocument {
  const doc = structuredClone(asset.document) as GLTFDocument & Json,
    nodes = doc.nodes as Json[],
    count = nodes.length,
    shapeList: Json[] = [],
    materialList: Json[] = [],
    lightList: Json[] = [],
    cameraList: Json[] = [],
    scripts: MargoScriptUse[] = [];
  const cameraBase = Array.isArray(doc.cameras) ? doc.cameras.length : 0;
  let activeCamera: number | undefined, firstCamera: number | undefined;
  for (let i = 0; i < count; i++) {
    const node = nodes[i],
      margo = record(node.extras) && record(node.extras.margo) ? node.extras.margo : undefined,
      props = (record(margo?.properties) ? margo.properties : {}) as Properties,
      name = typeof node.name === "string" ? node.name : `node ${i}`,
      bad = (key: string, need: string): never => {
        throw new TypeError(`Object '${name}': '${key}' must be ${need}; fix the custom property in Blender and re-export`);
      },
      text = (key: string, allowed: Set<string>) => {
        const v = props[key];
        if (v === undefined) return undefined;
        if (typeof v !== "string" || !allowed.has(v)) bad(key, `one of ${[...allowed].join(", ")}`);
        return v as string;
      },
      number = (key: string, min: number, fallback?: number) => {
        const v = props[key];
        if (v === undefined) return fallback;
        if (typeof v !== "number" || !Number.isFinite(v) || v < min) bad(key, `a number of at least ${min}`);
        return v as number;
      },
      list = (key: string, length: number) => {
        const v = props[key];
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || v.length !== length || v.some((x) => !(Number.isFinite(x) && x > 0)))
          bad(key, `${length} positive numbers`);
        return [...(v as number[])];
      };
    for (const key of Object.keys(props))
      if (!known.has(key))
        for (const tag of known)
          if (distance(key, tag) <= 2) bad(key, `spelt as a component tag (did you mean '${tag}'?)`);
    const extensions: Json = record(node.extensions) ? { ...node.extensions } : {};
    // Physics: a body without a collider gets a box; a trigger is a collider that only reports.
    const body = text("margo:body", bodies),
      trigger = props["margo:trigger"];
    if (trigger !== undefined && typeof trigger !== "boolean") bad("margo:trigger", "true or false");
    let shape = text("margo:collider", shapes);
    if (!shape && (body || trigger)) shape = "box";
    if (shape) {
      if (typeof node.mesh !== "number") bad("margo:collider", "on a mesh object (the collider is sized by the mesh)");
      const [min, max] = meshBounds(asset.geometry[node.mesh as number]),
        extent = [0, 1, 2].map((a) => max[a] - min[a]) as Vec3,
        center = [0, 1, 2].map((a) => (max[a] + min[a]) / 2) as Vec3,
        size = list("margo:size", shape === "box" ? 3 : shape === "sphere" ? 1 : 2);
      let implicit: Json;
      if (shape === "box") implicit = { size: size ?? extent };
      else if (shape === "sphere") implicit = { radius: size?.[0] ?? Math.max(...extent) / 2 };
      else {
        const radius = size?.[0] ?? Math.max(extent[0], extent[2]) / 2,
          height = size?.[1] ?? (shape === "capsule" ? Math.max(extent[1] - 2 * radius, 0) : extent[1]);
        implicit = { radiusTop: radius, radiusBottom: radius, height };
      }
      const shapeIndex = shapeList.push({ type: shape, [shape]: implicit }) - 1,
        physicsData: Json = {};
      const friction = number("margo:friction", 0),
        restitution = number("margo:restitution", 0);
      let material: number | undefined;
      if (friction !== undefined || restitution !== undefined)
        material =
          materialList.push({
            staticFriction: friction ?? 0.6,
            dynamicFriction: friction ?? 0.6,
            restitution: restitution ?? 0,
          }) - 1;
      const part: Json = { geometry: { shape: shapeIndex } };
      if (material !== undefined && !trigger) part.physicsMaterial = material;
      // Off centre by more than float noise in the exported vertices.
      const offset = center.some((v) => Math.abs(v) > 1e-5 * Math.max(...extent));
      let holder = physicsData;
      if (offset) {
        // A shape is centred on its node: an off-centre mesh gets a child node at its box's centre for the shape.
        const child: Json = { name: `${name} collider`, translation: center, extensions: {} },
          childData: Json = {};
        (child.extensions as Json).KHR_physics_rigid_bodies = childData;
        node.children = [...((node.children as number[] | undefined) ?? []), nodes.push(child) - 1];
        holder = childData;
      }
      holder[trigger ? "trigger" : "collider"] = part;
      if (body === "dynamic" || body === "kinematic") {
        const mass = number("margo:mass", Number.MIN_VALUE);
        physicsData.motion = body === "kinematic" ? { isKinematic: true } : mass === undefined ? {} : { mass };
      } else if (props["margo:mass"] !== undefined) bad("margo:mass", "on a dynamic body (margo:body = dynamic)");
      if (Object.keys(physicsData).length) extensions.KHR_physics_rigid_bodies = physicsData;
    } else
      for (const key of ["margo:mass", "margo:friction", "margo:restitution", "margo:size"])
        if (props[key] !== undefined) bad(key, "on an object with margo:collider or margo:body");
    // Lights: the object's node carries it, pointing down its -Z (Blender's -Z of the object, after Y-up).
    const light = text("margo:light", lights);
    if (light) {
      const color = props["margo:color"];
      if (color !== undefined && (!Array.isArray(color) || color.length !== 3 || color.some((c) => !(c >= 0 && Number.isFinite(c)))))
        bad("margo:color", "3 numbers of at least 0 (linear RGB)");
      const def: Json = {
        type: light,
        intensity: number("margo:intensity", 0, 1),
        ...(color ? { color: [...(color as number[])] } : {}),
      };
      const range = number("margo:range", Number.MIN_VALUE);
      if (range !== undefined) {
        if (light === "directional") bad("margo:range", "on a point or spot light");
        def.range = range;
      }
      if (light === "spot") {
        const outer = number("margo:outer_cone", 0, Math.PI / 4)!,
          inner = number("margo:inner_cone", 0, 0)!;
        if (outer > Math.PI / 2 || inner >= outer) bad("margo:outer_cone", "above margo:inner_cone and at most pi/2 radians");
        def.spot = { innerConeAngle: inner, outerConeAngle: outer };
      } else
        for (const key of ["margo:inner_cone", "margo:outer_cone"])
          if (props[key] !== undefined) bad(key, "on a spot light");
      extensions.KHR_lights_punctual = { light: lightList.push(def) - 1 };
    } else
      for (const key of ["margo:color", "margo:intensity", "margo:range", "margo:inner_cone", "margo:outer_cone"])
        if (props[key] !== undefined) bad(key, "on an object with margo:light");
    // Cameras: the node carries a glTF camera looking down its -Z; the scene's active camera comes first.
    const camera = text("margo:camera", cameraTypes);
    if (camera) {
      if (light) bad("margo:camera", "on an object without margo:light");
      const znear = number("margo:znear", Number.MIN_VALUE, 0.1)!,
        zfar = number("margo:zfar", Number.MIN_VALUE),
        aspect = number("margo:aspect", Number.MIN_VALUE);
      if (zfar !== undefined && zfar <= znear) bad("margo:zfar", "above margo:znear");
      let def: Json;
      if (camera === "perspective") {
        const yfov = number("margo:yfov", Number.MIN_VALUE, Math.PI / 3)!;
        if (yfov >= Math.PI) bad("margo:yfov", "below pi radians");
        def = { type: camera, perspective: { yfov, znear, ...(zfar !== undefined ? { zfar } : {}), ...(aspect ? { aspectRatio: aspect } : {}) } };
        if (props["margo:ymag"] !== undefined) bad("margo:ymag", "on an orthographic camera");
      } else {
        const ymag = number("margo:ymag", Number.MIN_VALUE, 1)!;
        if (zfar === undefined) bad("margo:zfar", "set on an orthographic camera");
        def = { type: camera, orthographic: { xmag: ymag * (aspect ?? 1), ymag, znear, zfar } };
        if (props["margo:yfov"] !== undefined) bad("margo:yfov", "on a perspective camera");
      }
      const active = props["margo:active"];
      if (active !== undefined && typeof active !== "boolean") bad("margo:active", "true or false");
      if (active && activeCamera === undefined) activeCamera = i;
      firstCamera ??= i;
      node.camera = cameraBase + cameraList.push(def) - 1;
    } else
      for (const key of ["margo:znear", "margo:zfar", "margo:aspect", "margo:yfov", "margo:ymag", "margo:active"])
        if (props[key] !== undefined) bad(key, "on an object with margo:camera");
    const script = props["margo:script"];
    if (script !== undefined) {
      if (typeof script !== "string" || !script.trim()) bad("margo:script", "a script name, or names separated by commas");
      for (const one of (script as string).split(","))
        if (one.trim()) scripts.push({ name: one.trim(), nodeIndex: i, properties: props });
    }
    if (Object.keys(extensions).length) node.extensions = extensions;
  }
  const used: string[] = [],
    root: Json = record(doc.extensions) ? { ...doc.extensions } : {};
  if (shapeList.length) {
    root.KHR_implicit_shapes = { shapes: shapeList };
    root.KHR_physics_rigid_bodies = materialList.length ? { physicsMaterials: materialList } : {};
    used.push("KHR_implicit_shapes", "KHR_physics_rigid_bodies");
  }
  if (lightList.length) {
    root.KHR_lights_punctual = { lights: lightList };
    used.push("KHR_lights_punctual");
  }
  if (cameraList.length) doc.cameras = [...((doc.cameras as Json[] | undefined) ?? []), ...cameraList] as GLTFDocument["cameras"];
  if (used.length) {
    doc.extensions = root;
    doc.extensionsUsed = [...new Set([...((doc.extensionsUsed as string[] | undefined) ?? []), ...used])];
  }
  return {
    document: doc,
    scripts,
    hasPhysics: shapeList.length > 0,
    hasLights: lightList.length > 0,
    ...(cameraList.length ? { camera: activeCamera ?? firstCamera } : {}),
  };
}

/**
 * Decodes static `.margo` bytes, attaches the scene (WebGPU only) and its components: bodies and colliders through
 * `applyGLTFPhysics` (loads @margoengine/physics, only when an object has one), lights through `applyGLTFLights` (the
 * first directional light becomes the engine's light; point and spot lights need `clustered`), then each named script.
 * A script name missing from `scripts` fails before any GPU work. Aborting `signal` rejects with its reason.
 *
 * @example
 * const scene = await parseMargoComponents(engine, bytes, { scripts: { spin: ({ node }) => void node } });
 * scene.physics?.physics.step();
 */
export async function parseMargoComponents(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes, scripts = {}, physics, clustered, exposure, view = true }: MargoComponentsOptions = {},
): Promise<MargoScene> {
  signal?.throwIfAborted();
  const asset = decodeMargo(input, { maxNodes }),
    parts = margoComponents(asset);
  for (const use of parts.scripts)
    if (typeof scripts[use.name] !== "function")
      throw new TypeError(
        `Object '${(parts.document.nodes![use.nodeIndex] as Json).name}': script '${use.name}' is not registered; pass it in the scripts option`,
      );
  const images = await decodeImages(asset.images, signal),
    cleanups: (() => void)[] = [];
  let model: PBRModel | undefined, world: GLTFPhysics | undefined;
  const dispose = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    world?.dispose();
    model?.dispose();
  };
  try {
    signal?.throwIfAborted();
    try {
      model = parsePreparedPBR(engine, parts.document, asset.geometry, images, { maxNodes });
    } catch (error) {
      for (const image of images) image.close();
      throw error;
    }
    if (parts.hasPhysics) {
      const { applyGLTFPhysics } = await import("@margoengine/gltf-pro/physics");
      world = await applyGLTFPhysics(model, { physics });
      signal?.throwIfAborted();
    }
    if (parts.hasLights) {
      const { applyGLTFLights } = await import("@margoengine/gltf-pro");
      cleanups.push(applyGLTFLights(model, { clustered, exposure }));
      signal?.throwIfAborted();
    }
    if (view && parts.camera !== undefined) {
      const { viewGLTFCamera } = await import("@margoengine/gltf-pro");
      signal?.throwIfAborted();
      viewGLTFCamera(model, model.cameras.find((camera) => camera.nodeIndex === parts.camera)!);
    }
    for (const use of parts.scripts) {
      const cleanup = scripts[use.name]({
        node: model.nodes[use.nodeIndex],
        nodeIndex: use.nodeIndex,
        properties: use.properties,
        model,
        physics: world,
      });
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { model, physics: world, dispose };
}

/**
 * Fetches a static .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and loads it like
 * parseMargoComponents.
 *
 * @example
 * const scene = await loadMargoComponents(engine, '/level.margo', { scripts: { door: openOnTouch } });
 */
export async function loadMargoComponents(
  engine: EngineKernel,
  url: string | URL,
  { fetch: get = globalThis.fetch, ...options }: MargoComponentsOptions & { fetch?: typeof fetch } = {},
): Promise<MargoScene> {
  options.signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargoComponents",
    );
  const bytes = await readResponse(await get(target, { signal: options.signal }), {
    maxBytes,
    signal: options.signal,
    label: ".margo download",
  });
  return parseMargoComponents(engine, bytes, options);
}
