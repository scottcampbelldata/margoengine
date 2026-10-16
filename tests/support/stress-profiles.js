// Default WebGPU limits; only maximum limits are reduced (alignment limits run in the opposite direction).
export const minimumLimits = {
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxBindGroups: 4,
  maxStorageBuffersPerShaderStage: 8,
  maxTextureDimension2D: 8192,
};
export const scenarios = [
  'core',
  'combined',
  'splats',
  'webgl',
  'fallback',
  'init-failure',
  'allocation-failure',
  'recovery-failure',
  'dispose-recovery',
  'webgl-loss',
  'soak',
];

export function stressProfile(seed, index) {
  let state = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const limits = Object.fromEntries(
    Object.entries(minimumLimits).map(([key, value]) => [key, value * (1 + Math.floor(random() * 4))]),
  );
  limits.maxStorageBufferBindingSize = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  return {
    index,
    seed,
    scenario: scenarios[index % scenarios.length],
    limits,
    features: random() < 0.5 ? 'none' : 'available',
    lossFraction: 0.2 + random() * 0.6,
    lossDuringPass: random() < 0.5,
    adapterDelay: Math.floor(random() * 12),
    dpr: [1, 1.5, 2][Math.floor(random() * 3)],
    size: [128 + Math.floor(random() * 128), 96 + Math.floor(random() * 128)],
  };
}

export function stressOptions(args) {
  const options = {
    sessions: 22,
    frames: 60,
    seed: 20261011,
    shard: 0,
    shards: 1,
    timeout: 120000,
    entities: 12014,
    splats: 4096,
    cycles: 10,
  };
  const ceilings = {
    sessions: 1000000,
    frames: 1000000,
    seed: 4294967295,
    shard: 1023,
    shards: 1024,
    timeout: 3600000,
    entities: 1000000,
    splats: 3000000,
    cycles: 10000,
  };
  for (const arg of args) {
    const match = /^--([a-z]+)=(\d+)$/.exec(arg);
    if (!match || !Object.hasOwn(options, match[1])) throw new TypeError(`Unknown option ${arg}; use --name=integer`);
    const [, name, value] = match,
      number = Number(value);
    if (!Number.isSafeInteger(number) || number < (['seed', 'shard'].includes(name) ? 0 : 1) || number > ceilings[name])
      throw new RangeError(`Invalid ${name}`);
    options[name] = number;
  }
  if (options.frames < 12 || options.shard >= options.shards || options.shards > options.sessions)
    throw new RangeError('Need >=12 frames, shard < shards <= sessions');
  return options;
}

// This function is serialized by Playwright: keep its dependencies inside the function.
export function installStressGPU(profile) {
  const state = (window.stressGPU = {
    errors: [],
    requests: [],
    failAdapter: false,
    delay: profile.adapterDelay,
    failBuffer: 0,
    injected: 0,
    alive: 0,
    peak: 0,
    created: 0,
    destroyed: 0,
    aliveDevices: 0,
  });
  window.addEventListener('unhandledrejection', (event) => state.errors.push(String(event.reason)));
  const gpu = navigator.gpu;
  if (!gpu) return;
  const tracked = new WeakSet();
  const devices = new WeakSet(),
    destroyDevice = GPUDevice.prototype.destroy;
  GPUDevice.prototype.destroy = function () {
    if (devices.delete(this)) state.aliveDevices--;
    return destroyDevice.call(this);
  };
  for (const [createName, type] of [
    ['createBuffer', 'GPUBuffer'],
    ['createTexture', 'GPUTexture'],
  ]) {
    const create = GPUDevice.prototype[createName],
      destroy = window[type].prototype.destroy;
    GPUDevice.prototype[createName] = function (descriptor) {
      if (createName === 'createBuffer' && state.failBuffer && --state.failBuffer === 0) {
        state.injected++;
        throw new DOMException('Injected allocation failure', 'OperationError');
      }
      const resource = create.call(this, descriptor);
      tracked.add(resource);
      state.created++;
      state.alive++;
      state.peak = Math.max(state.peak, state.alive);
      return resource;
    };
    window[type].prototype.destroy = function () {
      if (tracked.delete(this)) {
        state.destroyed++;
        state.alive--;
      }
      return destroy.call(this);
    };
  }
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.failAdapter || profile.scenario === 'fallback') return null;
    const adapter = await requestAdapter(options);
    if (!adapter) return null;
    const limits = Object.fromEntries(
      Object.keys(profile.limits).map((key) => [key, Math.min(adapter.limits[key], profile.limits[key])]),
    );
    const features = new Set(profile.features === 'none' ? [] : adapter.features);
    return new Proxy(adapter, {
      get(target, key) {
        if (key === 'features') return features;
        if (key === 'limits')
          return new Proxy(target.limits, {
            get(real, name) {
              return name in limits ? limits[name] : Reflect.get(real, name, real);
            },
          });
        if (key === 'requestDevice')
          return async (descriptor = {}) => {
            if (profile.scenario === 'init-failure')
              throw new DOMException('Injected device creation failure', 'OperationError');
            for (const [name, value] of Object.entries(descriptor.requiredLimits ?? {}))
              if (name in limits && value > limits[name])
                throw new DOMException(`Profile limit exceeded: ${name}`, 'OperationError');
            for (const feature of descriptor.requiredFeatures ?? [])
              if (!features.has(feature)) throw new TypeError(`Profile feature unavailable: ${feature}`);
            const device = await target.requestDevice({
              ...descriptor,
              requiredLimits: { ...limits, ...descriptor.requiredLimits },
            });
            device.addEventListener('uncapturederror', (event) =>
              state.errors.push(`${event.error.constructor.name}: ${event.error.message}`),
            );
            devices.add(device);
            state.aliveDevices++;
            state.requests.push({
              limits: Object.fromEntries(Object.keys(limits).map((name) => [name, device.limits[name]])),
              features: [...device.features],
            });
            return device;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}
