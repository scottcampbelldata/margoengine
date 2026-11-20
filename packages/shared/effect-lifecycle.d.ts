import type { Engine } from '@margoengine/core/extension';
/** What a PostStack effect shows the lifecycle helpers. */
export interface LifecycleEffect {
  engine: Engine | undefined;
  disposed: boolean;
  readonly name: string;
  release(): void;
  setup(engine: Engine): void;
}
/** Releases the effect's GPU resources, forgets its engine and sets it up again on `engine`. */
export function restoreEffect(effect: LifecycleEffect, engine: Engine): void;
/** First call: marks the effect disposed, removes its plugin and releases it, returning true. Later calls return false. */
export function retireEffect(effect: LifecycleEffect): boolean;
