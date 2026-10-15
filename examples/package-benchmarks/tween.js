import { Tween, easeInOutCubic } from '../../packages/tween/dist/index.js';
import { grid } from './layout.js';

export function createWorkload(count = 1000) {
  const points = grid(count),
    timeline = new Tween(),
    targets = [];
  let completed = 0;
  for (let i = 0; i < count; i++) {
    const target = { height: 0.15 };
    targets.push(target);
    points[i * 4 + 3] = i % 3;
    const options = {
      duration: 1 + (i % 7) / 10,
      easing: easeInOutCubic,
      onComplete() {
        completed++;
        timeline.to(target, 'height', target.height > 0.5 ? 0.15 : 1.1, options);
      },
    };
    timeline.to(target, 'height', 1.1, { ...options, delay: (i / count) * 0.5 });
  }
  return {
    points,
    timeline,
    targets,
    description:
      'Run eased height tracks with staggered starts. Completion callbacks reverse each track; track creation is included in workload CPU time.',
    step(delta) {
      timeline.update(delta);
      for (let i = 0; i < count; i++) points[i * 4 + 1] = targets[i].height;
    },
    details: () => ({ tracks: count, completions: completed }),
    dispose() {
      timeline.clear();
    },
  };
}
