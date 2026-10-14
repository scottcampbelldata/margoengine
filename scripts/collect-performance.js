// Paste into a demo's DevTools console. Keep the demo visible for the 20-second capture.
(() => {
  if (window.margoPerformanceCapture?.running) return console.info('A capture is already running.');
  const duration = 20000, limit = 4096, start = performance.now();
  const downloadLocal = document.currentScript?.dataset.download !== 'false';
  const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  const intervals = [], cpu = [], restores = [], observers = [], removals = [];
  let canvas, context, device, frame, timer, previous, first, last, active = true, resolve;
  const report = {recordedAt: new Date().toISOString(), durationMs: 0, nativeCallbacks: 0,
    canvasTextureAcquisitions: null, queueSubmissions: null, longTasks: [], longAnimationFrames: [], errors: [],
    stateChanges: [], hiddenDuringCapture: false, unfocusedDuringCapture: false};
  const capture = window.margoPerformanceCapture = new Promise(done => {resolve = done;});
  capture.running = true;
  const url = value => {try {const parsed = new URL(value, location.href); return parsed.origin + parsed.pathname;} catch {return null;}};
  const message = value => String(value?.message ?? value).replace(/https?:\/\/[^\s"'<>]+/g, url).slice(0, 500);
  const error = value => {if (active && report.errors.length < 32) report.errors.push(message(value));};
  const add = (values, value) => {if (values.length < limit) values.push(value);};
  function summary(values) {
    const sorted = values.slice().sort((a, b) => a - b), n = sorted.length;
    return {samples: n, medianMs: n ? sorted[Math.floor((n - 1) / 2)] : null,
      p95Ms: n ? sorted[Math.floor((n - 1) * .95)] : null, maxMs: n ? sorted[n - 1] : null};
  }
  function hook(target, key, wrap) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), original = target[key];
    if (typeof original !== 'function') return;
    const wrapped = wrap(original);
    Object.defineProperty(target, key, {...(descriptor ?? {writable: true, enumerable: true, configurable: true}), value: wrapped});
    restores.push(() => {if (target[key] === wrapped) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
    }});
  }
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    removals.push(() => target.removeEventListener(type, callback));
  }
  function snapshot() {
    const css = canvas?.getBoundingClientRect(), info = device?.adapterInfo, stats = window.nightCitadel?.stats ?? window.sandbox?.stats, timing = window.sandbox?.timing;
    return {page: url(location.href), userAgent: navigator.userAgent, visibility: document.visibilityState,
      focused: document.hasFocus(), viewport: [innerWidth, innerHeight], deviceDpr: devicePixelRatio,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? null,
      quality: document.querySelector('#quality')?.textContent?.trim().slice(0, 160) ?? null,
      pageStatus: message(document.querySelector('#status')?.textContent?.trim() ?? ''),
      pageError: message(document.querySelector('#error, #error-message')?.textContent?.trim() ?? ''),
      sceneTiming: timing ? {deltaSeconds: Number.isFinite(timing[0]) ? timing[0] : null, frames: Number.isFinite(timing[1]) ? timing[1] : null} : null,
      sceneStats: stats ? Object.fromEntries(['fps', 'frameTime', 'gpuTime', 'drawCalls', 'dispatches', 'samples', 'frames']
        .filter(key => Number.isFinite(stats[key])).map(key => [key, stats[key]])) : null,
      visualScale: window.visualViewport?.scale ?? 1, hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      canvas: canvas ? {css: [css.width, css.height], buffer: [canvas.width, canvas.height],
        effectiveDpr: [css.width ? canvas.width / css.width : null, css.height ? canvas.height / css.height : null]} : null,
      activeWebgpu: device ? {adapterInfo: info ? {vendor: info.vendor, architecture: info.architecture,
        device: info.device, description: info.description, fallback: info.isFallbackAdapter ?? null} : null,
        features: Array.from(device.features ?? [])} : null,
      scriptUrls: [...new Set([...document.scripts].map(script => script.src).filter(Boolean)
        .concat(performance.getEntriesByType('resource').filter(entry => entry.initiatorType === 'script').map(entry => entry.name)).map(url))].slice(0, 128)};
  }
  function finish() {
    if (!active) return;
    active = false; capture.running = false;
    clearTimeout(timer); if (frame !== undefined) cancel.call(window, frame);
    for (const cleanup of [...restores.reverse(), ...removals, ...observers.map(observer => () => observer.disconnect())]) {
      try {cleanup();} catch (reason) {report.cleanupError = message(reason);}
    }
    report.durationMs = performance.now() - start;
    report.nativeCallbackHz = report.nativeCallbacks > 1 && last > first ? (report.nativeCallbacks - 1) * 1000 / (last - first) : null;
    report.callbackIntervals = summary(intervals); report.appCallbackCpu = summary(cpu);
    report.samplesCapped = {callbackIntervals: intervals.length === limit, appCallbackCpu: cpu.length === limit};
    for (const key of ['canvasTextureAcquisitions', 'queueSubmissions']) report[key + 'PerSecond'] = report[key] === null || report.durationMs <= 0 ? null : report[key] * 1000 / report.durationMs;
    try {report.final = snapshot();} catch (reason) {report.snapshotError = message(reason);}
    report.limits = 'Callback cadence and texture acquisitions are not displayed FPS. CPU callbacks include JS encoding, not GPU duration. No GPU timing or queue waits. Instrumentation and DevTools can affect results. Samples are bounded; startup errors are not captured.';
    if (downloadLocal) try {
      const link = document.createElement('a'), objectUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
      link.href = objectUrl; link.download = 'margo-performance-' + Date.now() + '.json';
      try {link.click();} finally {setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);}
    } catch (reason) {report.downloadError = message(reason);}
    window.margoPerformanceReport = report; resolve(report);
    console.info(downloadLocal ? 'Capture complete. JSON downloaded; also available as window.margoPerformanceReport.' : 'Capture complete. Data available as window.margoPerformanceReport.', report);
  }
  try {
    canvas = document.querySelector('#scene, #viewport canvas') ?? [...document.querySelectorAll('canvas')].find(element => !element.closest('[data-margo-stats]'));
    try {context = canvas?.getContext('webgpu'); device = context?.getConfiguration?.()?.device;}
    catch (reason) {report.webgpuInspectionError = message(reason);}
    report.initial = snapshot();
    const stateChanged = event => {
      if (!active) return;
      report.hiddenDuringCapture ||= document.visibilityState !== 'visible'; report.unfocusedDuringCapture ||= !document.hasFocus();
      if (report.stateChanges.length < 64) report.stateChanges.push({atMs: performance.now() - start, event: event?.type ?? 'start', visibility: document.visibilityState, focused: document.hasFocus()});
    };
    stateChanged(); listen(document, 'visibilitychange', stateChanged);
    listen(window, 'focus', stateChanged); listen(window, 'blur', stateChanged);
    listen(window, 'error', event => error(event.error ?? event.message));
    listen(window, 'unhandledrejection', event => error(event.reason));
    if (device) listen(device, 'uncapturederror', event => error(event.error));
    if (context && globalThis.GPUCanvasContext) {
      report.canvasTextureAcquisitions = 0;
      hook(GPUCanvasContext.prototype, 'getCurrentTexture', original => function(...args) {
        const result = original.apply(this, args);
        if (active && this === context) report.canvasTextureAcquisitions++;
        return result;
      });
    }
    if (device && globalThis.GPUQueue) {
      report.queueSubmissions = 0;
      hook(GPUQueue.prototype, 'submit', original => function(...args) {
        const result = original.apply(this, args);
        if (active && this === device.queue) report.queueSubmissions++;
        return result;
      });
    }
    hook(window, 'requestAnimationFrame', original => function(callback) {
      if (!active || typeof callback !== 'function') return original.apply(this, arguments);
      return original.call(this, function(...args) {
        if (!active) return callback.apply(this, args);
        const before = performance.now();
        try {return callback.apply(this, args);} finally {if (active) add(cpu, performance.now() - before);}
      });
    });
    for (const [type, values] of [['longtask', report.longTasks], ['long-animation-frame', report.longAnimationFrames]]) {
      if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type)) continue;
      const observer = new PerformanceObserver(list => {
        if (active) for (const entry of list.getEntries()) if (entry.startTime >= start && values.length < 256) {
          const sample = {startMs: entry.startTime - start, durationMs: entry.duration, blockingMs: entry.blockingDuration ?? null};
          if (type === 'long-animation-frame') sample.scripts = [...(entry.scripts ?? [])].slice(0, 8).map(script => ({
            sourceURL: script.sourceURL ? url(script.sourceURL) : null, sourceFunctionName: String(script.sourceFunctionName ?? '').slice(0, 120),
            durationMs: script.duration, forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration}));
          values.push(sample);
        }
      });
      observers.push(observer); observer.observe({type});
    }
    report.observedEntryTypes = observers.length ? PerformanceObserver.supportedEntryTypes.filter(type => ['longtask', 'long-animation-frame'].includes(type)) : [];
    const observe = time => {
      if (!active) return;
      report.nativeCallbacks++; first ??= time; last = time;
      if (previous !== undefined) add(intervals, time - previous);
      previous = time; frame = request.call(window, observe);
    };
    frame = request.call(window, observe); timer = setTimeout(finish, duration);
    console.info('Recording Margo performance for 20 seconds. Keep this demo visible and focused; a local JSON file will download. No data is uploaded.');
  } catch (reason) {report.captureError = message(reason); finish();}
})();
