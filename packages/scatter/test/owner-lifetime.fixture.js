import { box } from '../../core/dist/index.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { Scatter } = await load('../dist/index.js');
  return [false, true].map((factory) => ({
    name: 'Scatter' + (factory ? '.attach' : ''),
    create({ engine }) {
      const options = { count: 500, area: [8, 8], seed: 5 };
      const plugin = factory
        ? Scatter.attach(engine, box(0.1, 0.1, 0.1), options)
        : new Scatter(box(0.1, 0.1, 0.1), options);
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
}
