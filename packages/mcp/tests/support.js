// Shared by the tests: a small corpus with known contents, and the repository root for the real type check.
import { resolve } from 'node:path';

export const repository = resolve(import.meta.dirname, '../../..');

/** Two packages, one doc, two examples: small enough to know every search result. */
export const corpus = {
  readme: '# Margo',
  packages: [
    {
      id: 'alpha',
      name: '@margoengine/alpha',
      description: 'Draws widgets with a fancy gizmo.',
      category: 'Rendering and lighting',
      readme:
        '# @margoengine/alpha\n\nInstall alpha.\n\n## Gizmo\n\nCall `makeGizmo()` to get a gizmo.\n\n```ts\nimport { makeGizmo } from "@margoengine/alpha";\n```\n',
      entries: [
        {
          specifier: '@margoengine/alpha',
          subpath: '.',
          report:
            '## API Report File for "@margoengine/alpha"\n\n```ts\nimport { Vec3 } from "@margoengine/math";\nexport function makeGizmo(size?: number): Gizmo;\nexport class Gizmo {\n    size: number;\n}\n```\n',
        },
        {
          specifier: '@margoengine/alpha/extras',
          subpath: './extras',
          report: '```ts\nexport const extraThing: number;\n```\n',
        },
      ],
    },
    {
      id: 'beta',
      name: '@margoengine/beta',
      description: 'Loads zebra textures.',
      category: 'Loading and formats',
      readme: '# @margoengine/beta\n\n## Zebra\n\nZebra stripes load fast.\n',
      entries: [],
    },
  ],
  docs: [
    {
      path: 'docs/conventions.md',
      title: 'Conventions',
      summary: 'Rules.',
      text: '# Conventions\n\n## Errors\n\nThrow a MargoError with a code.\n',
    },
  ],
  examples: [
    {
      id: 'flight-helmet',
      title: 'flight-helmet.html',
      path: 'examples/flight-helmet.html',
      description: 'The Khronos Flight Helmet with PBR materials',
      section: 'Example pages',
    },
    {
      id: 'minimap',
      title: 'minimap.html',
      path: 'examples/minimap.html',
      description: 'A second camera view as a minimap',
      section: 'Example pages',
    },
  ],
};
