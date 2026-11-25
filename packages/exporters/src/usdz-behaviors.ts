// Quick Look behaviours for a static USDZ: a tap runs a list of actions on chosen meshes. They are written as the
// `Preliminary_Behavior`, `Preliminary_Trigger` and `Preliminary_Action` prims of Apple's "USDZ schemas for AR" (Apple
// Developer Documentation, USD > Preliminary_Behavior, Preliminary_Trigger, Preliminary_Action, TapGestureTrigger,
// EmphasizeAction, VisibilityAction, WaitAction, GroupAction), in the form of the Preliminary_Behavior page's example: a
// behaviour holds `rel triggers` and `rel actions`; each trigger and action is a child prim that inherits its schema class
// (`inherits = </TapGestureTrigger>`) and carries `rel affectedObjects`; an emphasize action takes `motionType`, a
// visibility action `type`, a group `type`, `loops` and `performCount`. Only what those pages state is written.
import { num } from './scene.js';

/** A mesh a trigger or action points at: a node name (every mesh of that name) or the index of a mesh in the file. */
export type USDZTarget = string | number;
/** What starts a behaviour: the viewer taps one of `targets` (Apple's `TapGestureTrigger`). */
export interface USDZTrigger {
  type: 'tap';
  targets: readonly USDZTarget[];
}
/** What a behaviour does, in order. */
export type USDZAction =
  /** An animation that calls attention to `targets` (`EmphasizeAction`); `motion` is its `motionType` token, default 'flip'. */
  | { type: 'emphasize'; targets: readonly USDZTarget[]; motion?: string; duration?: number }
  /** Hides `targets` (`VisibilityAction`, `type = "hide"`). */
  | { type: 'hide'; targets: readonly USDZTarget[] }
  /** Pauses `duration` seconds (`WaitAction`). */
  | { type: 'wait'; duration: number }
  /** Runs `actions` in a row or, with `parallel`, together (`GroupAction`); `repeat` runs the group that many times, 0 forever. */
  | { type: 'group'; actions: readonly USDZAction[]; parallel?: boolean; repeat?: number };
/** One behaviour: a tap on any of its `triggers` runs its `actions` in a row. */
export interface USDZBehavior {
  triggers: readonly USDZTrigger[];
  actions: readonly USDZAction[];
}

const TOKEN = /^[A-Za-z][A-Za-z0-9]*$/;
const seconds = (value: number, what: string): string => {
  if (typeof value !== 'number' || !(value >= 0) || !Number.isFinite(value))
    throw new RangeError(`${what} must be a finite number of seconds, 0 or more`);
  return num(value);
};

/**
 * The lines of a `Scope "Behaviors"` for `behaviors`, whose mesh prims are `/Margo/Mesh_<i>` with the node names
 * `names[i]`; nothing for an empty list.
 * @throws RangeError for a behaviour with no trigger or no action, a target that names no mesh, or a bad duration, count or token.
 */
export function behaviorLines(behaviors: readonly USDZBehavior[], names: readonly (string | undefined)[]): string[] {
  if (!behaviors.length) return [];
  const paths = (targets: readonly USDZTarget[], what: string): string => {
    if (!targets.length) throw new RangeError(`${what} needs at least one target`);
    const out = new Set<string>();
    for (const target of targets) {
      const hit =
        typeof target === 'number'
          ? Number.isInteger(target) && target >= 0 && target < names.length
            ? [target]
            : []
          : names.flatMap((name, i) => (name === target ? [i] : []));
      if (!hit.length)
        throw new RangeError(
          `${what} target ${JSON.stringify(target)} names no mesh in the file; pass a mesh, its index or its name from the exported scene`,
        );
      for (const i of hit) out.add(`</Margo/Mesh_${i}>`);
    }
    return `[${[...out].join(', ')}]`;
  };
  const lines = ['    def Scope "Behaviors" {'];
  let ids = 0;
  const action = (a: USDZAction, indent: string, into: string[]): string => {
    const id = `Action_${ids++}`,
      p = indent + '    ',
      body: string[] = [];
    let schema: string;
    if (a.type === 'emphasize') {
      schema = 'EmphasizeAction';
      const motion = a.motion ?? 'flip';
      if (!TOKEN.test(motion)) throw new RangeError('emphasize motion must be a token of letters and digits');
      body.push(
        `${p}rel affectedObjects = ${paths(a.targets, 'emphasize')}`,
        `${p}uniform token motionType = "${motion}"`,
      );
      if (a.duration !== undefined)
        body.push(`${p}uniform double duration = ${seconds(a.duration, 'emphasize duration')}`);
    } else if (a.type === 'hide') {
      schema = 'VisibilityAction';
      body.push(`${p}rel affectedObjects = ${paths(a.targets, 'hide')}`, `${p}uniform token type = "hide"`);
    } else if (a.type === 'wait') {
      schema = 'WaitAction';
      body.push(`${p}uniform double duration = ${seconds(a.duration, 'wait duration')}`);
    } else if (a.type === 'group') {
      schema = 'GroupAction';
      if (!a.actions.length) throw new RangeError('a group needs at least one action');
      const count = a.repeat ?? 1;
      if (!Number.isInteger(count) || count < 0) throw new RangeError('group repeat must be a whole number, 0 or more');
      const inner: string[] = [],
        children = a.actions.map((child) => action(child, p, inner));
      body.push(
        `${p}rel actions = [${children.join(', ')}]`,
        `${p}uniform token type = "${a.parallel ? 'concurrent' : 'serial'}"`,
        `${p}uniform bool loops = ${count === 1 ? 'false' : 'true'}`,
        `${p}uniform uint performCount = ${count}`,
        ...inner,
      );
    } else
      throw new RangeError(
        `unknown action type ${JSON.stringify((a as { type: unknown }).type)}; use one of the action types in the exporters README`,
      );
    into.push(
      `${indent}def Preliminary_Action "${id}" ( inherits = </${schema}> )`,
      `${indent}{`,
      ...body,
      `${indent}}`,
    );
    return `<${id}>`;
  };
  behaviors.forEach((b, n) => {
    if (!b.triggers?.length) throw new RangeError(`behavior ${n} needs at least one trigger`);
    if (!b.actions?.length) throw new RangeError(`behavior ${n} needs at least one action`);
    const inner: string[] = [],
      triggers = b.triggers.map((t, k) => {
        if ((t as { type: unknown }).type !== 'tap')
          throw new RangeError(
            `unknown trigger type ${JSON.stringify((t as { type: unknown }).type)}; use one of the trigger types in the exporters README`,
          );
        const id = `Trigger_${n}_${k}`;
        inner.push(
          `        def Preliminary_Trigger "${id}" ( inherits = </TapGestureTrigger> )`,
          '        {',
          `            rel affectedObjects = ${paths(t.targets, 'tap')}`,
          '        }',
        );
        return `<${id}>`;
      }),
      actions = b.actions.map((a) => action(a, '        ', inner));
    lines.push(
      `        def Preliminary_Behavior "Behavior_${n}"`,
      '        {',
      `            rel triggers = [${triggers.join(', ')}]`,
      `            rel actions = [${actions.join(', ')}]`,
      ...inner.map((l) => '    ' + l),
      '        }',
    );
  });
  lines.push('    }');
  return lines;
}
