// Temporary, opt-in diagnostics for the constraints example. No package API changes.
const COLUMNS = Object.freeze([
  'frame', 'timeMs', 'dtSeconds',
  'rawTargetX', 'rawTargetY', 'rawTargetZ',
  'rootX', 'rootY', 'rootZ',
  'elbowX', 'elbowY', 'elbowZ',
  'handX', 'handY', 'handZ',
  'projectedTargetX', 'projectedTargetY', 'projectedTargetZ',
  'candidateTargetX', 'candidateTargetY', 'candidateTargetZ',
  'candidateElbowX', 'candidateElbowY', 'candidateElbowZ',
  'commandTargetX', 'commandTargetY', 'commandTargetZ',
  'lastSolveTargetX', 'lastSolveTargetY', 'lastSolveTargetZ',
  'lastSolveRootX', 'lastSolveRootY', 'lastSolveRootZ',
  'acceptedPoleRadians', 'acceptedPoleStepRadians', 'acceptedHandStepMeters',
  'candidatePoleRadians', 'allowedPoleStepRadians',
  'rawStatus', 'status', 'resolved', 'targetResolved',
  'acceptedClearanceMeters', 'candidateClearanceMeters', 'targetClearanceMeters',
  'targetQueryResolved', 'targetQueryClearanceMeters',
  'requiredClearanceMeters', 'complianceMarginMeters', 'dampingSeconds',
  'toleranceMeters', 'swivelSpeedLimitRadiansPerSecond', 'reachMarginMeters',
  'foldMarginMeters', 'searchBudget', 'iterations', 'solveCalls',
  'yawRadians', 'yawAssist', 'scene', 'mode', 'clock',
  'chased', 'clampActive', 'paced', 'paused', 'nominalHandSpeedMetersPerSecond', 'state',
  'upperLengthMeters', 'lowerLengthMeters', 'elbowRadiusMeters', 'forearmRadiusMeters',
  'outwardDetour',
]);
const ACTION_TYPES = Object.freeze([
  'start', 'stop', 'scene', 'gap', 'speed', 'clock', 'damping', 'budget',
  'yaw', 'query', 'pause', 'reset', 'sweep', 'pointerdown', 'pointerup',
  'pointercancel', 'visibility',
]);
const ACTION_LABELS = Object.freeze([
  'torso', 'mixed', 'chain', 'target', 'live', 'fixed60', 'fixed120',
]);
const STATES = Object.freeze([
  'paused', 'target-accepted', 'target-held', 'recovering', 'sliding',
  'paced', 'following', 'swivel-held', 'singular-held', 'occluded-held',
]);
const STRIDE = COLUMNS.length;
const ACTION_STRIDE = 5;

function capacity(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}
function number(value) {
  return typeof value === 'number' ? value : NaN;
}
function vector(value) {
  return value != null && typeof value[0] === 'number' &&
    typeof value[1] === 'number' && typeof value[2] === 'number';
}
function writeVector(out, offset, value) {
  out[offset] = value[0];
  out[offset + 1] = value[1];
  out[offset + 2] = value[2];
  return offset + 3;
}
function writeOptionalVector(out, offset, value) {
  if (vector(value)) return writeVector(out, offset, value);
  out[offset] = out[offset + 1] = out[offset + 2] = NaN;
  return offset + 3;
}
function exportNumber(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  // JSON otherwise loses signed zero, which can matter in a numerical report.
  if (Object.is(value, -0)) return '-0';
  return value;
}

/**
 * Bounded local recording, disabled until start(). Calls copy scalar values only;
 * no controller, result, input event, or DOM object is retained. Frame/action
 * buffers are allocated once on first start and reused. JSON export is allowed
 * only after stop, away from the animation loop.
 */
export class ConstraintsInteractionRecorder {
  #capacity;
  #actionCapacity;
  #frames;
  #actions;
  #recording = false;
  #totalFrames = 0;
  #totalActions = 0;
  #invalidFrames = 0;
  #started = 0;
  #last = 0;
  #ended = 0;

  constructor({ capacity: frameCapacity = 3600, actionCapacity = 2048 } = {}) {
    this.#capacity = capacity(frameCapacity, 36000, 'Frame capacity');
    this.#actionCapacity = capacity(actionCapacity, 8192, 'Action capacity');
  }

  get capacity() { return this.#capacity; }
  get actionCapacity() { return this.#actionCapacity; }
  get recording() { return this.#recording; }
  get frameCount() { return Math.min(this.#totalFrames, this.capacity); }
  get totalFrames() { return this.#totalFrames; }
  get overwrittenFrames() { return Math.max(0, this.#totalFrames - this.capacity); }
  get actionCount() { return Math.min(this.#totalActions, this.actionCapacity); }
  get overwrittenActions() { return Math.max(0, this.#totalActions - this.actionCapacity); }
  get invalidFrames() { return this.#invalidFrames; }
  get full() { return this.#totalFrames >= this.capacity; }
  get durationMs() { return (this.#recording ? this.#last : this.#ended) - this.#started; }

  start(wallTimeMs = 0) {
    if (this.#recording) return false;
    if (!Number.isFinite(wallTimeMs) || wallTimeMs < 0)
      throw new RangeError('Recording time must be finite and nonnegative');
    if (!this.#frames) {
      this.#frames = new Float64Array(this.capacity * STRIDE);
      this.#actions = new Float64Array(this.actionCapacity * ACTION_STRIDE);
    }
    this.clear();
    this.#started = this.#last = this.#ended = wallTimeMs;
    this.#recording = true;
    this.mark('start', 0, wallTimeMs);
    return true;
  }

  stop(wallTimeMs = this.#last) {
    if (!this.#recording) return false;
    this.#checkTime(wallTimeMs);
    this.mark('stop', 0, wallTimeMs);
    this.#ended = wallTimeMs;
    this.#recording = false;
    return true;
  }

  clear() {
    this.#recording = false;
    this.#totalFrames = this.#totalActions = this.#invalidFrames = 0;
    this.#started = this.#last = this.#ended = 0;
  }

  #checkTime(wallTimeMs) {
    if (!Number.isFinite(wallTimeMs) || wallTimeMs < this.#last)
      throw new RangeError('Recording time must be finite and monotonic');
  }

  /** Invalid controller shapes are counted and skipped, never numerically coerced. */
  recordFrame(controller, wallTimeMs) {
    if (!this.#recording) return false;
    this.#checkTime(wallTimeMs);
    const result = controller?.result;
    if (!result || !vector(controller.root) || !vector(controller.rawTarget) ||
      !vector(controller.currentElbow) || !vector(controller.currentHand) ||
      !vector(controller.projectedTarget) || !vector(result.target) || !vector(result.elbow)) {
      this.#invalidFrames++;
      this.#last = wallTimeMs;
      return false;
    }
    const options = controller.solveOptions;
    const avoidance = controller.avoidance;
    const targetResult = controller.targetResult;
    const out = this.#frames;
    let offset = (this.#totalFrames % this.capacity) * STRIDE;
    out[offset++] = this.#totalFrames;
    out[offset++] = wallTimeMs - this.#started;
    out[offset++] = number(controller.dt);
    offset = writeVector(out, offset, controller.rawTarget);
    offset = writeVector(out, offset, controller.root);
    offset = writeVector(out, offset, controller.currentElbow);
    offset = writeVector(out, offset, controller.currentHand);
    offset = writeVector(out, offset, controller.projectedTarget);
    offset = writeVector(out, offset, result.target);
    offset = writeVector(out, offset, result.elbow);
    offset = writeOptionalVector(out, offset, controller.commandTarget);
    offset = writeOptionalVector(out, offset, controller.lastSolveTarget);
    offset = writeOptionalVector(out, offset, controller.lastSolveRoot);
    out[offset++] = number(controller.acceptedPole);
    out[offset++] = number(controller.angleStep);
    out[offset++] = number(controller.handStep);
    out[offset++] = number(result.poleAngle);
    out[offset++] = number(options?.swivelSpeedLimit) * number(controller.dt);
    out[offset++] = number(controller.rawStatus);
    out[offset++] = number(result.status);
    out[offset++] = result.resolved ? 1 : 0;
    out[offset++] = result.targetResolved ? 1 : 0;
    out[offset++] = number(controller.clearance);
    out[offset++] = number(result.clearance);
    out[offset++] = number(controller.targetClearance);
    out[offset++] = targetResult?.resolved ? 1 : 0;
    out[offset++] = number(targetResult?.clearance);
    out[offset++] = number(avoidance?.minClearance);
    out[offset++] = number(avoidance?.complianceMargin);
    out[offset++] = number(avoidance?.damping);
    out[offset++] = number(avoidance?.tolerance);
    out[offset++] = number(options?.swivelSpeedLimit);
    out[offset++] = number(options?.reachMargin);
    out[offset++] = number(options?.foldMargin);
    out[offset++] = number(options?.searchBudget);
    out[offset++] = number(controller.iterations);
    out[offset++] = number(controller.solveCalls);
    out[offset++] = number(controller.yaw);
    out[offset++] = controller.yawAssist ? 1 : 0;
    out[offset++] = controller.scene === 'torso' ? 0 : controller.scene === 'mixed' ? 1 : -1;
    out[offset++] = controller.mode === 'chain' ? 0 : controller.mode === 'target' ? 1 : -1;
    out[offset++] = controller.clock === 'live' ? 0 : controller.clock === 'fixed60' ? 1 : controller.clock === 'fixed120' ? 2 : -1;
    out[offset++] = controller.chased ? 1 : 0;
    out[offset++] = controller.clampActive ? 1 : 0;
    out[offset++] = controller.paced ? 1 : 0;
    out[offset++] = controller.paused ? 1 : 0;
    out[offset++] = number(controller.nominalHandSpeed);
    out[offset++] = STATES.indexOf(controller.state);
    out[offset++] = number(controller.upperLength);
    out[offset++] = number(controller.lowerLength);
    out[offset++] = number(controller.elbowRadius);
    out[offset++] = number(controller.forearmRadius);
    out[offset] = controller.outwardDetour ? 1 : 0;
    this.#totalFrames++;
    this.#last = wallTimeMs;
    return true;
  }

  /** Action values are numeric, boolean, or one of the fixed setting labels. */
  mark(type, value = 0, wallTimeMs = this.#last) {
    if (!this.#recording) return false;
    this.#checkTime(wallTimeMs);
    const typeIndex = ACTION_TYPES.indexOf(type);
    if (typeIndex < 0) throw new RangeError('Unknown recording action');
    let valueKind = 0;
    let encoded = value;
    if (typeof value === 'boolean') {
      valueKind = 1;
      encoded = value ? 1 : 0;
    } else if (typeof value === 'string') {
      valueKind = 2;
      encoded = ACTION_LABELS.indexOf(value);
      if (encoded < 0) throw new RangeError('Unknown recording action value');
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('Recording actions require a finite number, boolean, or setting label');
    }
    let offset = (this.#totalActions % this.actionCapacity) * ACTION_STRIDE;
    const out = this.#actions;
    out[offset++] = wallTimeMs - this.#started;
    out[offset++] = this.#totalFrames;
    out[offset++] = typeIndex;
    out[offset++] = valueKind;
    out[offset] = encoded;
    this.#totalActions++;
    this.#last = wallTimeMs;
    return true;
  }

  /** Fresh JSON; previous exports remain unchanged across clear/re-record/overwrite. */
  serialize() {
    if (this.#recording) throw new Error('Stop recording before exporting JSON');
    const frames = [];
    const firstFrame = this.overwrittenFrames;
    for (let index = firstFrame; index < this.#totalFrames; index++) {
      const row = [];
      const offset = (index % this.capacity) * STRIDE;
      for (let component = 0; component < STRIDE; component++)
        row.push(exportNumber(this.#frames[offset + component]));
      frames.push(row);
    }
    const actions = [];
    const firstAction = this.overwrittenActions;
    for (let index = firstAction; index < this.#totalActions; index++) {
      const offset = (index % this.actionCapacity) * ACTION_STRIDE;
      const kind = this.#actions[offset + 3];
      const encoded = this.#actions[offset + 4];
      actions.push({
        timeMs: this.#actions[offset],
        nextFrame: this.#actions[offset + 1],
        type: ACTION_TYPES[this.#actions[offset + 2]],
        value: kind === 1 ? encoded === 1 : kind === 2 ? ACTION_LABELS[encoded] : encoded,
      });
    }
    return JSON.stringify({
      format: 'margo-constraints-interaction',
      version: 1,
      controllerRevision: 'contact-normal-2',
      temporaryDiagnostics: true,
      durationMs: this.durationMs,
      frameCapacity: this.capacity,
      totalFrames: this.#totalFrames,
      overwrittenFrames: this.overwrittenFrames,
      invalidFrames: this.#invalidFrames,
      actionCapacity: this.actionCapacity,
      totalActions: this.#totalActions,
      overwrittenActions: this.overwrittenActions,
      units: { position: 'meters', angle: 'radians', dt: 'seconds', time: 'milliseconds since Start' },
      semantics: {
        clearance: 'Static proxy clearance at sampled instants only; not continuous swept-volume certification or physical robot safety.',
        result: 'Candidate fields describe the last evaluated solve; accepted hand/elbow fields retain the displayed pose on failure.',
        rawStatus: 'Status of the controller initial request before local recovery retries; input pacing may condition that request.',
        outwardDetour: 'Demo controller accepted a bounded contact-tangent waypoint with an outward reserve along the estimated full-chain clearance gradient after the original request and smaller straight retries failed. The full-chain package guards remain active.',
        requestedPoleAngle: 'Not supplied by this demo. The caller supplies a Cartesian target and an IK callback, not a requested swivel angle; no unreturned overshoot is inferred.',
        absentNumbers: 'NaN, Infinity, -Infinity and -0 are explicit strings; no numeric coercion is performed.',
        droppedData: 'Ring overwrites retain the newest frames/actions in chronological order; overwritten and invalid counts are explicit.',
        privacy: 'Local in-memory recording only. Nothing is uploaded or persisted automatically.',
        replay: 'Frames store sampled inputs, settings and poses; this is diagnostic playback data, not a guarantee of deterministic re-simulation from a truncated recording.',
        coverage: 'One snapshot per recordFrame call (the demo calls it once per rendered frame); not every browser pointer event is captured. Pointer down/up and control changes are separate bounded actions.',
        actionUnits: 'speed actions use UI degrees/second; gap actions use meters; damping actions use seconds. Frame columns always use their explicit unit suffixes.',
      },
      codes: {
        status: ['Success', 'SwivelRateLimitExceeded', 'SingularDeadZone', 'ObstacleOccluded'],
        scene: ['torso', 'mixed'], mode: ['chain', 'target'], clock: ['live', 'fixed60', 'fixed120'], state: STATES,
        booleans: '0=false, 1=true', unknownEnum: -1,
      },
      columns: COLUMNS,
      frames,
      actions,
    }, null, 2);
  }
}
