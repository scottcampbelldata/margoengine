# The Vortex Ring

Adjust the circulation of an already formed ring. Higher circulation moves the center farther in the same time and turns the dye faster about the core. The gold mark follows the modeled center. The cyan sheets are dye samples. **Launch again** returns the formed ring to the start of the measurement section. Pause to compare two launches at the same age. Under reduced motion, **Step +1 s** advances the solution.

## Slender-ring model

The radius to the ring centerline is **R = 49 mm**. A Gaussian core starts at **a₀ = 3.6 mm** and spreads by diffusion in water with kinematic viscosity **ν = 1.2 × 10⁻⁶ m²/s**. The core follows **a²(t) = a₀² + 4νt**. Circulation **Γ** is fixed for a given launch and ranges from 18 to 33 cm²/s. At fixed ring radius, the impulse per unit density is **πΓR²**. The control prescribes circulation directly.

The center speed uses Saffman's leading-order Gaussian-core result **U(t) = Γ[ln(8R/a(t)) − 0.558]/(4πR)**. The app integrates the logarithmic term analytically to compute the rise. The window ends 17.2 cm above the launch datum. The slowest ring reaches it in about 16.9 s, before **a/R** reaches 0.20. The ratio **νt/R²** stays below 0.009. The tank is a setting for the isolated-ring model. Formation, wall and free-surface interactions, wakes and transitions to instability are outside the model.

The dye ribbons start as authored sheets wound around the ring and advance with its center. Within each local cross-section, a passive filament at radius **s** rotates according to the Lamb–Oseen formula **vθ = Γ[1 − exp(−s²/a²)]/(2πs)**. The bright toroidal envelope uses the swirl at a representative core orbit. The chosen seeds, color, intensity and variation illustrate advection. Center height and Gaussian core radius are model quantities. Playback runs at 0.65× model time.

## References and provenance

- [Philip G. Saffman, *The Velocity of Viscous Vortex Rings*, 1970](https://doi.org/10.1002/sapm1970494371). Gaussian thin-core diffusion and leading-order propagation.
- [Morteza Gharib, Edmond Rambod and Karim Shariff, *A universal time scale for vortex ring formation*, 1998](https://doi.org/10.1017/S0022112097008410). Experimental launches in a glass tank.
- [Thomas Maxworthy, *The structure and stability of vortex rings*, 1972](https://doi.org/10.1017/S0022112072001041). Original dye observations of vortex ring structure and motion.
- [Shuai Shuai and M. Houssem Kasbaoui, *Accelerated decay of a Lamb–Oseen vortex tube laden with inertial particles in Eulerian–Lagrangian simulations*, Journal of Fluid Mechanics, 2022](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/accelerated-decay-of-a-lamboseen-vortex-tube-laden-with-inertial-particles-in-eulerianlagrangian-simulations/12D7568FE3C37DF7DD67C8A57FD33639). The finite-radius swirl expression in equation 1.1.

The tank, lighting, ribbon geometry and material maps are original. Both paths use the same pinned public Margo Engine scene. Serve the normal showcase build over HTTP. Append `?backend=webgl2` to exercise the compatibility path.
