/** JSON Schema Draft 2020-12 for portable figure version 1. Exported with /spec for offline editors. */
export const figureSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://margoengine.com/schemas/sciviz/figure-v1.json',
  title: 'Margo scientific figure version 1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'options', 'camera', 'limits', 'dragMode', 'resources', 'layers'],
  properties: {
    version: { const: 1 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    options: { $ref: '#/$defs/value' },
    camera: {
      type: 'object',
      additionalProperties: false,
      required: ['position', 'target', 'up', 'fov', 'near', 'far'],
      properties: {
        position: { $ref: '#/$defs/vector' },
        target: { $ref: '#/$defs/vector' },
        up: { $ref: '#/$defs/vector' },
        fov: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 180 },
        near: { type: 'number', exclusiveMinimum: 0 },
        far: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    limits: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 6 },
    dragMode: { enum: ['orbit', 'pan', 'box', 'lasso'] },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'args', 'state', 'updates'],
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { type: 'string', minLength: 1 },
          args: { $ref: '#/$defs/value' },
          state: { $ref: '#/$defs/value' },
          updates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['method', 'args'],
              properties: {
                method: {
                  enum: [
                    'setHeights',
                    'update',
                    'setClassification',
                    'setLabels',
                    'setPositions',
                    'setPhase',
                    'setTime',
                    'setFrame',
                    'load',
                    'advance',
                    'setDate',
                  ],
                },
                args: { $ref: '#/$defs/value' },
              },
            },
          },
        },
      },
    },
    layers: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    selection: { $ref: '#/$defs/value' },
    annotations: { $ref: '#/$defs/value' },
    pipeline: {
      type: 'object',
      required: ['version', 'nodes'],
      properties: {
        version: { const: 1 },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'type'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              inputs: { type: 'array', items: { type: 'string' } },
              params: { $ref: '#/$defs/value' },
            },
          },
        },
      },
    },
    time: {
      type: 'object',
      additionalProperties: false,
      required: ['times', 'index', 'frames'],
      properties: {
        times: { type: 'array', minItems: 1, items: { type: 'number' } },
        index: { type: 'integer', minimum: -1 },
        frames: { type: 'array', items: { $ref: '#' } },
        options: { $ref: '#/$defs/value' },
      },
    },
  },
  $defs: {
    vector: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    value: {
      anyOf: [
        { type: ['null', 'boolean', 'number', 'string'] },
        { type: 'array', items: { $ref: '#/$defs/value' } },
        { type: 'object', additionalProperties: { $ref: '#/$defs/value' } },
      ],
    },
  },
} as const;
