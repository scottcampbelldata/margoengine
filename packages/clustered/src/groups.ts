/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, PointLight, SpotLight } from './index.js';

type Light = PointLight | SpotLight;

/** One named share of a `Clustered` light list: a fire, a lamp, your own lights. */
export interface LightGroup {
  readonly name: string;
  /** This group's lights as last set, in order (a frozen copy of the list). */
  readonly lights: readonly Light[];
  /**
   * Replaces this group's lights. Outside a frame callback the merged list goes to `Clustered.setLights` at once, so
   * invalid lights throw here and leave every group as it was; inside one (`engine.onFrame`, `animateFlicker`) all
   * groups set that frame go in one `setLights` before the frame renders.
   */
  setLights(lights: readonly Light[]): this;
  /** Removes this group and its lights. */
  dispose(): void;
  /**
   * True once this group, its `LightGroups` or their `Clustered` is disposed: `setLights` then throws `'disposed'`.
   * `dispose()` never throws, whichever went first.
   */
  readonly isDisposed: boolean;
  [Symbol.dispose](): void;
}

/**
 * Named groups of point and spot lights merged into one `Clustered` list, so several owners (a fire, a lamp, a game's
 * own lights, each animated or not) share one `Clustered` without replacing each other's lights: `setLights` replaces
 * the whole list, and a group replaces only its part. Groups keep the order they were made in. Attach it to the engine
 * (`LightGroups.attach`) so changes made during a frame cost one `setLights` a frame; unattached, every change is its
 * own `setLights`. `animateFlicker` takes a group in place of the `Clustered`.
 * @throws MargoError `'disposed'` when used after `dispose()`.
 */
export class LightGroups implements EnginePlugin {
  readonly name = 'clustered-groups';
  /** The lighting these groups fill. */
  readonly clustered: Clustered;
  private engine?: Engine;
  private stopFrame?: () => void;
  private readonly groups = new Map<string, Group>();
  /** Inside a frame: between the frame's first callback and its update. */
  private inFrame = false;
  private dirty = false;
  private disposed = false;
  constructor(clustered: Clustered) {
    if (!clustered || typeof clustered.setLights !== 'function')
      throw new TypeError('Invalid LightGroups lighting; pass a Clustered from @margoengine/clustered');
    this.clustered = clustered;
  }
  /** `new LightGroups(clustered)` attached to `engine`. */
  static attach(engine: EngineKernel, clustered: Clustered): LightGroups {
    const groups = new LightGroups(clustered);
    engineRuntime(engine).use(groups);
    return groups;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  /** True once `dispose()` ran (directly or with its scene). */
  get isDisposed(): boolean {
    return this.disposed;
  }
  setup(engine: Engine): void {
    this.engine = engine;
    // Frame callbacks run before the frame's update: anything set from here on waits for onPreUpdate.
    this.stopFrame = engine.onFrame(() => {
      this.inFrame = true;
    });
  }
  onPreUpdate(): void {
    this.inFrame = false;
    if (this.dirty) this.flush();
  }
  /** The group called `name`, made empty (and placed last) if it does not exist yet. */
  group(name: string): LightGroup {
    this.live();
    if (typeof name !== 'string' || !name) throw new TypeError('Invalid light group name; pass a non-empty string');
    let group = this.groups.get(name);
    if (!group) this.groups.set(name, (group = new Group(this, name)));
    return group;
  }
  /** The groups' names, in order. */
  get names(): readonly string[] {
    return [...this.groups.keys()];
  }
  /** Every group's lights in group order: what `Clustered.setLights` gets. */
  get list(): readonly Light[] {
    return [...this.groups.values()].flatMap((group) => group.lights);
  }
  /**
   * Sends the merged list to `Clustered.setLights` now. If it throws, every group set since the last good list goes
   * back to its lights then, and the error is rethrown.
   */
  flush(): this {
    this.live();
    try {
      this.clustered.setLights(this.list);
    } catch (error) {
      for (const group of this.groups.values()) group.revert();
      this.dirty = false;
      throw error;
    }
    for (const group of this.groups.values()) group.commit();
    for (const [name, group] of this.groups) if (group.removed) this.groups.delete(name);
    this.dirty = false;
    return this;
  }
  /** @internal A group changed. */
  changed(): void {
    this.dirty = true;
    if (!this.inFrame) this.flush();
  }
  /** @internal */
  forget(group: Group): void {
    if (this.disposed || this.groups.get(group.name) !== group) return;
    group.remove();
    // The Clustered went first (a scene disposes it before the fire that owns a group): its lights are gone with it, so
    // the group leaves without a list to send.
    if (this.clustered.isDisposed) {
      group.commit();
      this.groups.delete(group.name);
      return;
    }
    this.changed();
  }
  /** Stops managing the list; `Clustered` keeps the lights last sent. The groups can no longer be set. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.stopFrame?.();
    this.stopFrame = undefined;
    this.engine = undefined;
    this.groups.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'LightGroups is disposed; create new LightGroups');
  }
}

class Group implements LightGroup {
  /** The lights the last good `setLights` got. */
  private good: readonly Light[] = Object.freeze([]);
  private current: readonly Light[] = this.good;
  /** Disposed, waiting for the next good list. */
  removed = false;
  private gone = false;
  constructor(
    private readonly owner: LightGroups,
    readonly name: string,
  ) {}
  get lights(): readonly Light[] {
    return this.removed ? [] : this.current;
  }
  get isDisposed(): boolean {
    return this.gone || this.removed || this.owner.isDisposed || this.owner.clustered.isDisposed;
  }
  setLights(lights: readonly Light[]): this {
    if (this.gone) throw new MargoError('disposed', `Light group ${this.name} is disposed; ask LightGroups.group for it again`);
    if (this.owner.clustered.isDisposed)
      throw new MargoError('disposed', `Light group ${this.name} lights a disposed Clustered; attach a new Clustered`);
    if (!Array.isArray(lights)) throw new TypeError('Invalid light group list; pass an array of point and spot lights');
    this.current = Object.freeze([...lights]);
    this.removed = false;
    this.owner.changed();
    return this;
  }
  remove(): void {
    this.removed = true;
  }
  revert(): void {
    this.current = this.good;
    this.removed = false;
  }
  commit(): void {
    this.good = this.current;
    if (this.removed) this.gone = true;
  }
  dispose(): void {
    if (this.gone) return;
    this.owner.forget(this);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
