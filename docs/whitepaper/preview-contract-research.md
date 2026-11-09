# Preview contract research review

Continuation review, 2026-11-10. The existing three preview/compat changes are
retained; this review does not authorize a new rendering feature or core change.
The search compared module boundaries, conservative setup decisions and the two
public graphics specifications. No companion code or external engine source was
read or copied.

- David L. Parnas, *On the Criteria To Be Used in Decomposing Systems into
  Modules* (1972), [author institutional record](https://doi.org/10.1184/r1/6607958)
  and [paper](https://john.cs.olemiss.edu/~hcc/csci555/notes/localcopy/Parnas_Criteria_Decomposing.pdf).
  Its module-boundary argument supports putting the tier contract in optional
  package setup and a small shared helper, keeping the frozen core unchanged.
- Jerome H. Saltzer and Michael D. Schroeder, *The Protection of Information in
  Computer Systems* (1975), [author publication](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html).
  Economy of mechanism and conservative default decisions suggest one shared
  requirement checked before allocation. This is an engineering analogy, not a
  claim that a rendering refusal is a security boundary.
- Kai Ninomiya, Brandon Jones and Jim Blandy (editors), *WebGPU* (2026 candidate
  recommendation draft), [W3C specification](https://www.w3.org/TR/2026/CRD-webgpu-20260915/).
  Explicit device feature/limit validation supports rejecting unavailable work
  at setup. A WebGPU-shaped compatibility device can satisfy the package
  contract without claiming that native WebGL2 exposes the WebGPU API.
- Kelsey Gilbert (editor), *WebGL 2.0 Specification* (2026 working draft),
  [Khronos specification](https://registry.khronos.org/webgl/specs/latest/2.0/).
  Its OpenGL ES 3.0 context and error contracts distinguish the small preview
  from the full translation layer. Real preview implementations remain valid;
  a backend name alone is not evidence that a package must refuse.

Combined choice: check availability before package ownership, report linked
`unsupported`, and let awaited autoEngine setup select the full layer. Preserve
real preview routes. Prove behavior with direct setup failures, no retained
passes, one escalation and pixel/readback checks. The parsed source gate checks
that backend-gated work has this setup contract; mutation regressions check the
gate itself. These papers motivate the design; repository tests supply its proof.

The restart forbids speed and timing tests and assigns teardown to lane-T.
No new timing result is claimed. Historical native evidence is retained; current
correctness gates and their outstanding results are recorded separately.
