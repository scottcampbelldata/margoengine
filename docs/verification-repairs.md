# Verification wiring repaired during size restoration

Finding 8's full verification exposed inherited integration defects at 5ec86fe7c:

- The compute scene-owner browser regression was tracked but no package GPU
  script scheduled it. Main concurrently repaired it in 39fb88cf9/50596778a as
  test:gpu:owners. Preserve those fixes so the existing
  planner's orphan check and affected-package selection include it. The
  registered command changes to the repository root before launching the driver;
  its explicit compat:false preserves native execution before the compatibility
  case. A named
  planner regression asserts the exact command and package working directory.
- Its four render submissions are four deliberate compute increments, not a
  readiness wait. Main states that input explicitly at the loop. Readback and queue
  completion already await actual GPU completion; all four-step value and
  ownership/disposal assertions remain intact. No wait baseline is raised.
- check-merge-affected registered a test using ctx before its later top-level
  await initialized ctx. Finish asynchronous setup before registering any test.
  The previously failing real-plan case is the regression, including both the
  narrowed export-only change and full umbrella-source change assertions.

Research/standards checked before repairing the wiring:

- Ecma TC39, *ECMAScript Language Specification*, living specification, 2026,
  [declarative environment GetBindingValue](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-getbindingvalue-n-s):
  an uninitialized lexical binding throws. Fix initialization order rather
  than suppressing the exception or relaxing the test.
- W3C GPU for the Web Working Group, Kai Ninomiya, Brandon Jones and Jim Blandy
  (editors), *WebGPU*, 2026 candidate recommendation,
  [GPUQueue.onSubmittedWorkDone](https://www.w3.org/TR/webgpu/#dom-gpuqueue-onsubmittedworkdone):
  queue completion is asynchronous. A count of submitted compute steps is
  test data; GPU readback/completion, already awaited here, supplies readiness.

No production engine implementation, kernel or optional-entry bytes change.
GPU commands use one shared slot per lane with wait-max 60; CPU checks hold no
GPU lock. The local runner initially propagated that one-slot preference into
fake scheduler unit fixtures that require multiple synthetic readers. Correct
only the ignored runner's environment for CPU checks; no scheduler test,
production slot policy, time limit or tolerance is changed for that mistake.

The viz kit size growth belongs to the separate finding 8 restoration and is
recorded from an actual static-bundle measurement in docs/guides/kits.md.

Validation: the initial full verify passed every non-unit step and 13,842 unit
cases, with 21 failed cases/file imports. All 13 affected unit files now pass
the scoped failed/unrun case runner (maps-failed-results.json); the failed
initialization case and all cases after the previously failing top-level await
are included. Existing successful cases are retained. The affected real-GPU
compute repairs are the already-landed main changes, with their native and
compatibility evidence in the operational playbook. A redundant local compute
GPU request was cancelled while still queued, with no lane GPU holder and no
GPU command executed. No passed GPU result is replayed.
