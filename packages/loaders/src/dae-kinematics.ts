// COLLADA 1.5 kinematics, clean room from the Khronos COLLADA 1.5.0 specification and schema (Khronos Group, 2008,
// https://www.khronos.org/files/collada_schema_1_5): joints, kinematics models, articulated systems and kinematics
// scenes, whose `bind_joint_axis` ties a joint axis to one transform of a visual scene node. Parameters and SID
// paths are resolved through the instance tree, so two instances of one model keep their own joints.
import { LoaderError } from './types.js';
import { daeRoot, readDAE, type DAENode, type DAEParseOptions, type LoadedDAE } from './dae.js';
import { AXES, converter, F, IDENTITY, kid, kids, multiply, ref, stackMatrix, type Matrix } from './dae-common.js';
import type { DAETransform } from './dae-common.js';
import type { DAEPose } from './dae-pose.js';
import type { BinaryInput } from './util.js';
import type { XMLElement } from './xml.js';

/** Instantiated kinematics elements per file. */
const MAX_SCOPES = 100_000;
const MAX_DEPTH = 64;
/** Elements and nodes visited while resolving SID paths, so a hostile file cannot cost the square of its size. */
const MAX_VISITS = 20_000_000;

/** A node transform a joint axis drives. */
export interface DAEJointTarget {
  node: DAENode;
  /** Index into `node.transforms`: a `rotate` for a revolute axis, a `translate` for a prismatic one. */
  transform: number;
}

/** One degree of freedom: a `<revolute>` or `<prismatic>` of one instance of a joint. */
export interface DAEJointAxis {
  /**
   * The key {@link poseDAEJoints} takes: the joint's SID, with the axis SID or the whole instance path added only when
   * needed to tell axes apart.
   */
  name: string;
  /** The SIDs from the kinematics scene down to the axis, joined by `/`; unique in the file. */
  path: string;
  /** The `<joint>`'s name, else its SID or id. */
  joint: string;
  type: 'revolute' | 'prismatic';
  /** Unit axis of rotation or travel in the driven node's frame, Y-up. */
  axis: [number, number, number];
  /** Lower limit: degrees for revolute, meters for prismatic. `axis_info` limits replace the joint's own. */
  min?: number;
  max?: number;
  /** The value the file binds the axis at (degrees or meters). */
  value: number;
  /** `axis_info` `<active>`: false for a passive axis. Default true. */
  active: boolean;
  /** `axis_info` `<locked>`: a locked axis stays at `value`. Default false. */
  locked: boolean;
  /** `axis_info` `<index>`: the axis' number in the controller's order. */
  index?: number;
  /** Motion `axis_info` bounds, per second (squared, cubed), in the axis' units. */
  speed?: number;
  acceleration?: number;
  deceleration?: number;
  jerk?: number;
  /** The node transforms `bind_joint_axis` ties to this axis; empty when the file binds none. */
  targets: DAEJointTarget[];
}

/** A parsed COLLADA document with its joint axes. */
export interface DAEKinematicScene extends LoadedDAE {
  /** Every joint axis of the instanced kinematics scenes, in document order. */
  joints: DAEJointAxis[];
}

/** Options of {@link poseDAEJoints}. */
export interface DAEJointPoseOptions {
  /** Hold values inside the axis' `min` and `max`. Default true. */
  clamp?: boolean;
}

/** An element of the instance tree: an `instance_*` element also holds its target's children. */
interface Scope {
  element: XMLElement;
  target?: XMLElement;
  parent?: Scope;
  children: Scope[];
}

// `link` trees hold no joint of their own and nest two levels per joint, so a long chain is not walked.
const SKIPPED = new Set(['asset', 'extra', 'technique', 'link', 'formula', 'instance_formula']);
const INSTANCES = new Set([
  'instance_kinematics_scene',
  'instance_articulated_system',
  'instance_kinematics_model',
  'instance_joint',
]);
const PRIMITIVES = new Set(['revolute', 'prismatic']);

const textOf = (e: XMLElement): string => e.attributes.ref ?? e.text.trim();
/** An address without a trailing member selector (".ANGLE", "(2)"), which names part of a value, not an element. */
const withoutMember = (sid: string): string => sid.replace(/(\.\w+|\(\d+\))+$/, '');

class Resolver {
  private scopes = 0;
  private visits = 0;
  /** `setparam` replacements, by the `newparam` they replace. */
  readonly overrides = new Map<Scope, Scope>();

  constructor(
    private readonly ids: Map<string, XMLElement>,
    private readonly warn: (message: string) => void,
  ) {}

  expand(element: XMLElement, parent: Scope | undefined, depth: number): Scope {
    if (++this.scopes > MAX_SCOPES || depth > MAX_DEPTH)
      throw new LoaderError(
        F,
        'limit',
        `the kinematics instances expand past ${MAX_SCOPES} elements or ${MAX_DEPTH} levels (an instance cycle?)`,
      );
    const scope: Scope = { element, children: [] };
    if (parent) scope.parent = parent;
    const add = (from: XMLElement): void => {
      for (const child of from.children)
        if (SKIPPED.has(child.name)) {
          if (child.name.endsWith('formula'))
            this.warn('kinematics formulas (coupled joints) are not evaluated: pose the dependent axes yourself');
        } else scope.children.push(this.expand(child, scope, depth + 1));
    };
    add(element);
    if (INSTANCES.has(element.name)) {
      const url = element.attributes.url ?? '',
        target = url.startsWith('#') ? this.ids.get(ref(url)) : undefined;
      if (target && target.name === element.name.slice('instance_'.length)) {
        scope.target = target;
        add(target);
      } else this.warn(`${element.name} "${url}" names nothing in this file, so its joints are not imported`);
    }
    return scope;
  }

  /** Counts one element or node looked at. */
  visit(): void {
    if (++this.visits > MAX_VISITS)
      throw new LoaderError(F, 'limit', 'resolving the kinematics SID paths visits too many elements');
  }

  /** The `newparam` of SID `sid` nearest below `owner`. */
  parameter(owner: Scope, sid: string): Scope | undefined {
    const queue = [owner];
    for (let i = 0; i < queue.length; i++) {
      this.visit();
      const scope = queue[i];
      if (scope.element.name === 'newparam' && scope.element.attributes.sid === sid) return scope;
      for (const child of scope.children) queue.push(child);
    }
    return undefined;
  }

  /** Breadth-first from `start`, as SID addresses are searched. */
  private search(start: Scope, token: string, seen: Set<Scope>): Scope | undefined {
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const scope = queue[i];
      this.visit();
      const { sid, id } = scope.element.attributes;
      if ((sid === token || id === token || scope.target?.attributes.id === token) && !seen.has(scope)) return scope;
      for (const child of scope.children) queue.push(child);
    }
    return undefined;
  }

  /** A `newparam` holding a SIDREF stands for what the SIDREF names. */
  private follow(scope: Scope, seen: Set<Scope>): Scope | undefined {
    if (scope.element.name !== 'newparam') return scope;
    const value = (this.overrides.get(scope) ?? scope).children[0];
    if (value?.element.name !== 'SIDREF') return scope;
    if (seen.size >= MAX_DEPTH) return undefined;
    return this.resolve(textOf(value.element), value, new Set(seen).add(scope));
  }

  /**
   * The element a SID path or parameter name addresses, seen from `from`: the first segment is an id or SID searched
   * in the nearest enclosing scope outward (`.` is `from` itself), each later one a SID below the last.
   */
  resolve(path: string, from: Scope, seen: Set<Scope> = new Set()): Scope | undefined {
    this.visit();
    const [first, ...rest] = path.split('/');
    let hit: Scope | undefined = first === '.' ? from : undefined;
    for (let scope: Scope | undefined = from; scope && !hit; scope = scope.parent)
      hit = this.search(scope, first, seen);
    for (let i = 0; hit; i++) {
      hit = this.follow(hit, seen);
      if (!hit || i === rest.length) break;
      const token = rest[i],
        found: Scope | undefined = this.below(hit, token, seen);
      hit = found ?? (i === rest.length - 1 ? this.below(hit, withoutMember(token), seen) : undefined);
    }
    return hit;
  }

  private below(scope: Scope, token: string, seen: Set<Scope>): Scope | undefined {
    for (const child of scope.children) {
      this.visit();
      if (child.element.attributes.sid === token && !seen.has(child)) return child;
    }
    for (const child of scope.children) {
      const found = this.search(child, token, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** The text of a value written plainly, as a typed child, or through a parameter. */
  value(holder: Scope): string | undefined {
    const typed = holder.children.find((c) => /^(float|int|bool|param|SIDREF)$/.test(c.element.name));
    if (!typed) return holder.element.text.trim() || undefined;
    if (typed.element.name !== 'param' && typed.element.name !== 'SIDREF') return typed.element.text.trim();
    const target = this.resolve(textOf(typed.element), holder);
    const held = target && (this.overrides.get(target) ?? target);
    return held && held !== holder ? held.children[0]?.element.text.trim() : undefined;
  }

  /** The `<revolute>` or `<prismatic>` an address leads to. */
  axis(found: Scope | undefined, seen = 0): Scope | undefined {
    if (!found || seen > MAX_DEPTH) return undefined;
    const name = found.element.name;
    if (PRIMITIVES.has(name)) return found;
    if (name === 'axis' && found.parent && PRIMITIVES.has(found.parent.element.name)) return found.parent;
    if (name === 'axis_info') {
      const next = this.resolve(found.element.attributes.axis ?? '', found, new Set([found]));
      return this.axis(next, seen + 1);
    }
    if (name === 'joint' || name === 'instance_joint') {
      const primitives = found.children.filter((c) => PRIMITIVES.has(c.element.name));
      if (primitives.length === 1) return primitives[0];
    }
    return undefined;
  }
}

const walk = (scope: Scope, visit: (scope: Scope) => void): void => {
  visit(scope);
  for (const child of scope.children) walk(child, visit);
};
const part = (scope: Scope | undefined, name: string): Scope | undefined =>
  scope?.children.find((c) => c.element.name === name);

/** The transform of SID `sid` in `start` or nearest below it. */
function transformBelow(start: DAENode, sid: string, resolver: Resolver): DAEJointTarget | undefined {
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    resolver.visit();
    const node = queue[i],
      transform = node.transforms.findIndex((t) => t.sid === sid);
    if (transform >= 0) return { node, transform };
    for (const child of node.children) queue.push(child);
  }
  return undefined;
}

/** The node of SID `sid` nearest below `start`. */
function nodeBelow(start: DAENode, sid: string, resolver: Resolver): DAENode | undefined {
  const queue = [...start.children];
  for (let i = 0; i < queue.length; i++) {
    resolver.visit();
    if (queue[i].sid === sid) return queue[i];
    for (const child of queue[i].children) queue.push(child);
  }
  return undefined;
}

/** The node transforms `target` ("nodeId/sid/.../transformSid") names, one per copy of the node. */
function boundTransforms(byId: Map<string, DAENode[]>, target: string, resolver: Resolver): DAEJointTarget[] {
  const [id, ...sids] = target.split('/'),
    last = sids.pop();
  if (last === undefined) return [];
  const out: DAEJointTarget[] = [];
  for (const node of byId.get(id) ?? []) {
    let from: DAENode | undefined = node;
    for (const step of sids) from = from && nodeBelow(from, step, resolver);
    if (!from) continue;
    // A trailing member selector (".ANGLE", "(2)") names one value of the transform.
    const found = transformBelow(from, last, resolver) ?? transformBelow(from, withoutMember(last), resolver);
    if (found) out.push(found);
  }
  return out;
}

function readJoints(root: XMLElement, dae: LoadedDAE, warn: (message: string) => void): DAEJointAxis[] {
  const ids = new Map<string, XMLElement>();
  const index = (e: XMLElement): void => {
    if (e.attributes.id) ids.set(e.attributes.id, e);
    for (const child of e.children) index(child);
  };
  index(root);
  let elements = kids(kid(root, 'scene'), 'instance_kinematics_scene');
  if (!elements.length) {
    elements = kids(root, 'library_kinematics_scenes').flatMap((l) => kids(l, 'kinematics_scene'));
    if (!elements.length) {
      if (kid(root, 'library_joints') || kid(root, 'library_kinematics_models'))
        warn('the file has joints but no kinematics scene, so no joint is imported');
      return [];
    }
    warn('<scene> instances no kinematics scene, so the joints drive no node');
  }
  const resolver = new Resolver(ids, warn),
    roots = elements.map((e) => resolver.expand(e, undefined, 0));

  // setparam: inner instances first, so that an outer one has the last word.
  const setters: Scope[] = [];
  for (const scope of roots) walk(scope, (s) => s.element.name === 'setparam' && setters.push(s));
  for (const setter of setters.reverse()) {
    const name = setter.element.attributes.ref ?? '',
      from = setter.parent!;
    // The reference names the parameter itself, so it is found without following what the parameter holds.
    const split = name.lastIndexOf('/'),
      owner = split < 0 ? from : resolver.resolve(name.slice(0, split), from),
      last = name.slice(split + 1);
    const found = owner && resolver.parameter(owner, last);
    if (found) resolver.overrides.set(found, setter);
    else warn(`setparam "${name}" names no parameter`);
  }

  const upAxis = AXES[dae.upAxis],
    axes = new Map<Scope, DAEJointAxis>(),
    /** How many axes already have each path. */
    taken = new Map<string, number>(),
    tokens: { joint: string; axis: string }[] = [];
  const number = (holder: Scope | undefined, scale: number, what: string): number | undefined => {
    if (!holder) return undefined;
    const text = resolver.value(holder),
      value = text === undefined ? Number.NaN : Number(text);
    if (Number.isFinite(value)) return value * scale;
    warn(`${what} has no finite value`);
    return undefined;
  };
  const unit = (axis: DAEJointAxis): number => (axis.type === 'prismatic' ? dae.meter : 1);
  const limit = (axis: DAEJointAxis, limits: Scope | undefined): void => {
    for (const end of ['min', 'max'] as const) {
      const value = number(part(limits, end), unit(axis), `axis "${axis.path}" <${end}>`);
      if (value !== undefined) axis[end] = value;
    }
  };
  const collect = (scope: Scope, path: string[], joint: Scope | undefined): void => {
    const { name, attributes } = scope.element;
    if (name === 'joint' || name === 'instance_joint') joint = scope;
    if (PRIMITIVES.has(name)) {
      const text = part(scope, 'axis')?.element.text.trim() ?? '',
        v = text.split(/\s+/).map(Number),
        length = Math.hypot(...v);
      if (v.length !== 3 || !(length > 0 && Number.isFinite(length)))
        throw new LoaderError(F, 'syntax', `<${name}> needs an <axis> of three finite numbers, not all zero`);
      const owner = joint?.element,
        definition = joint?.target ?? owner,
        token = owner?.attributes.sid ?? definition?.attributes.sid ?? definition?.attributes.id ?? 'joint',
        sid = attributes.sid ?? name;
      const written = [...path, sid].join('/'),
        copy = (taken.get(written) ?? 0) + 1,
        full = copy > 1 ? `${written}#${copy}` : written;
      taken.set(written, copy);
      const axis: DAEJointAxis = {
        name: full,
        path: full,
        joint: definition?.attributes.name ?? token,
        type: name as DAEJointAxis['type'],
        axis: [0, 1, 2].map(
          (r) => (upAxis[r * 3] * v[0] + upAxis[r * 3 + 1] * v[1] + upAxis[r * 3 + 2] * v[2]) / length,
        ) as [number, number, number],
        value: 0,
        active: true,
        locked: false,
        targets: [],
      };
      limit(axis, part(scope, 'limits'));
      axes.set(scope, axis);
      tokens.push({ joint: token, axis: sid });
      return;
    }
    // technique_common and library containers have no SID, so they leave no step in the path.
    const next = attributes.sid === undefined ? path : [...path, attributes.sid];
    for (const child of scope.children) collect(child, next, joint);
  };
  for (const scope of roots) collect(scope, [], undefined);

  const infos: Scope[] = [];
  for (const scope of roots) walk(scope, (s) => s.element.name === 'axis_info' && infos.push(s));
  // A motion system's technique follows the system it instances, so document order applies inner bounds first.
  for (const info of infos) {
    const scope = resolver.axis(info),
      axis = scope && axes.get(scope);
    if (!axis) {
      warn(`axis_info "${info.element.attributes.axis ?? ''}" names no joint axis`);
      continue;
    }
    limit(axis, part(info, 'limits'));
    for (const flag of ['active', 'locked'] as const) {
      const holder = part(info, flag),
        text = holder && resolver.value(holder);
      if (text !== undefined) axis[flag] = text === 'true' || text === '1';
    }
    const order = number(part(info, 'index'), 1, `axis "${axis.path}" <index>`);
    if (order !== undefined) axis.index = order;
    for (const bound of ['speed', 'acceleration', 'deceleration', 'jerk'] as const) {
      const value = number(part(info, bound), unit(axis), `axis "${axis.path}" <${bound}>`);
      if (value !== undefined) axis[bound] = value;
    }
  }
  for (const axis of axes.values())
    if (axis.min !== undefined && axis.max !== undefined && axis.min > axis.max) {
      warn(`axis "${axis.path}" has its lower limit above its upper one, so it has no limits`);
      delete axis.min;
      delete axis.max;
    }

  const byId = new Map<string, DAENode[]>();
  const register = (node: DAENode): void => {
    if (node.id !== undefined) {
      const list = byId.get(node.id);
      if (list) list.push(node);
      else byId.set(node.id, [node]);
    }
    for (const child of node.children) register(child);
  };
  for (const node of dae.nodes) register(node);
  const initial = new Set<DAEJointAxis>();
  for (const scope of roots)
    for (const bind of scope.children) {
      if (bind.element.name !== 'bind_joint_axis') continue;
      const target = bind.element.attributes.target ?? '',
        holder = part(bind, 'axis'),
        written = holder?.children[0],
        found = written
          ? resolver.resolve(textOf(written.element), written)
          : holder && resolver.resolve(holder.element.text.trim(), holder),
        primitive = resolver.axis(found),
        axis = primitive && axes.get(primitive);
      if (!axis) {
        warn(`bind_joint_axis "${target}" names no joint axis`);
        continue;
      }
      const value = number(part(bind, 'value'), unit(axis), `bind_joint_axis "${target}" <value>`);
      if (value !== undefined) {
        axis.value = value;
        initial.add(axis);
      }
      if (!target) continue;
      const wanted = axis.type === 'revolute' ? 'rotate' : 'translate',
        targets = boundTransforms(byId, target, resolver);
      if (!targets.length) warn(`bind_joint_axis target "${target}" names no node transform`);
      for (const t of targets)
        if (t.node.transforms[t.transform].type !== wanted)
          warn(`bind_joint_axis target "${target}" is not a <${wanted}>, which a ${axis.type} axis needs`);
        else axis.targets.push(t);
    }
  // Without a bound value, an axis starts where its first target stands.
  for (const axis of axes.values()) {
    const first = axis.targets[0];
    if (initial.has(axis) || !first) continue;
    const v = first.node.transforms[first.transform].values,
      along = fileAxis(upAxis, axis.axis),
      dot = along[0] * v[0] + along[1] * v[1] + along[2] * v[2];
    axis.value = axis.type === 'revolute' ? v[3] * Math.sign(dot) : dot * dae.meter;
  }

  const list = [...axes.values()],
    candidates = tokens.map((t, i) => [t.joint, `${t.joint}/${t.axis}`, list[i].path]);
  for (let level = 0; level < 2; level++) {
    const count = new Map<string, number>();
    for (const c of candidates) count.set(c[level], (count.get(c[level]) ?? 0) + 1);
    list.forEach((axis, i) => {
      if (axis.name === axis.path && count.get(candidates[i][level]) === 1) axis.name = candidates[i][level];
    });
  }
  return list;
}

/** The inverse of the up-axis rotation: a Y-up direction back in the file's axes. */
const fileAxis = (upAxis: readonly number[], v: readonly number[]): number[] =>
  [0, 1, 2].map((c) => upAxis[c] * v[0] + upAxis[3 + c] * v[1] + upAxis[6 + c] * v[2]);

/**
 * `parseDAE` plus the document's COLLADA 1.5 kinematics: `joints` lists every revolute and prismatic axis of the
 * instanced kinematics scenes with its limits, its `axis_info` data and the node transforms it drives. What cannot be
 * resolved is reported in `warnings`. Formulas, closed-loop attachments and tool frames are not evaluated.
 */
export function parseDAEKinematics(input: BinaryInput | string, options: DAEParseOptions = {}): DAEKinematicScene {
  const root = daeRoot(input, options),
    dae = readDAE(root, options),
    warnings = new Set(dae.warnings),
    joints = readJoints(root, dae, (message) => void warnings.add(message));
  return { ...dae, warnings: [...warnings], joints };
}

/**
 * The scene with its joints at the given values (degrees for revolute axes, meters for prismatic ones), for
 * `flattenDAE` or your own meshes: `world` holds every node's matrix. An axis left out stands at its `value`. Each
 * bound transform becomes the axis' motion: a rotation about `axis`, or a translation along it. Values are held
 * inside the limits unless `clamp` is false.
 */
export function poseDAEJoints(
  dae: DAEKinematicScene,
  values: Readonly<Record<string, number>> = {},
  options: DAEJointPoseOptions = {},
): DAEPose {
  const byName = new Map(dae.joints.map((j) => [j.name, j]));
  for (const name of Object.keys(values))
    if (!byName.has(name))
      throw new RangeError(
        `DAE joint "${name}" does not exist; pass one of ${[...byName.keys()].slice(0, 32).join(', ') || '(none)'}`,
      );
  const upAxis = AXES[dae.upAxis],
    changed = new Map<DAENode, DAETransform[]>();
  for (const axis of dae.joints) {
    let value = axis.value;
    if (Object.hasOwn(values, axis.name)) {
      value = values[axis.name];
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new RangeError(`DAE joint "${axis.name}" value ${value} is invalid; pass a finite number`);
      if (axis.locked && value !== axis.value)
        throw new RangeError(`DAE joint "${axis.name}" is locked at ${axis.value}; leave it out`);
      if (options.clamp !== false) value = Math.min(axis.max ?? Infinity, Math.max(axis.min ?? -Infinity, value));
    }
    const along = fileAxis(upAxis, axis.axis);
    for (const { node, transform } of axis.targets) {
      let list = changed.get(node);
      if (!list) changed.set(node, (list = node.transforms.slice()));
      const moved: DAETransform =
        axis.type === 'revolute'
          ? { type: 'rotate', values: [...along, value] }
          : {
              type: 'translate',
              values: along.map((a) => (a * value) / dae.meter),
            };
      const sid = list[transform].sid;
      if (sid !== undefined) moved.sid = sid;
      list[transform] = moved;
    }
  }
  const convert = converter(dae.upAxis, dae.meter),
    local = new Map<DAENode, number[]>(),
    world = new Map<DAENode, number[]>();
  const place = (node: DAENode, parent: Matrix): void => {
    const list = changed.get(node),
      matrix = list ? convert(stackMatrix(list)) : node.matrix,
      w = multiply(parent, matrix);
    local.set(node, matrix);
    world.set(node, w);
    for (const child of node.children) place(child, w);
  };
  for (const node of dae.nodes) place(node, IDENTITY);
  return { local, world, weights: dae.morphs.map((m) => [...m.weights]) };
}
