# The Hydraulic Jump

Control the approach speed in a horizontal, 0.28 m wide rectangular flume. An inlet gate sets the shallow approach depth to 2.8 cm. The downstream control provides the conjugate tailwater depth so the roller stays in view. The model reports the two bulk depths, the approach Froude number and the share of upstream specific energy dissipated.

## Momentum, depth and energy

For upstream depth **y₁**, speed **u₁**, width **b**, and gravity **g**, the approach Froude number is **Fr₁ = u₁ / √(gy₁)**. The discharge is **Q = b y₁ u₁**. Equating the hydrostatic force plus momentum flux per unit width at the two steady sections gives the Bélanger relation **y₂/y₁ = (√(1 + 8Fr₁²) − 1)/2**. At the downstream section, **u₂ = Q/(by₂)**. The specific energy at a section is **E = y + u²/(2g)** and the loss is **E₁ − E₂ = (y₂ − y₁)³/(4y₁y₂)**. The displayed percentage is this loss divided by **E₁**. The inlet and outlet are open to the atmosphere. The model assumes an incompressible flow, a smooth horizontal bed, hydrostatic pressure at the two steady sections and a uniform section-mean velocity.

The selected range, 2.40–3.90 m/s, keeps the approach supercritical and the downstream flow subcritical. The free-surface mesh rises from the computed approach depth to the computed tailwater depth. Foam moves upstream at the top of the roller and through the cutaway in recirculating paths, with faster downstream transport in the shallow approach. The roller length is Hager, Bremen and Kawagoshi's (1990) fit to classical jumps, **L_r = y₁(160 tanh(Fr₁/20) − 12)**, which covers the selected Froude range. The jump values come from `@margoengine/physics/hydraulics` (`hydraulicJump`); `hydraulics.js` holds the flume dimensions. The interior foam, air pockets, surface fluctuations, fixed jump toe and profile shape are illustrative. Gate hydraulics, turbulence, bubble dynamics and toe migration are outside the model.

## References and provenance

- [U.S. Bureau of Reclamation, *Design Standards No. 14, Chapter 4: General Outlet Works Design Considerations*, 2022](https://www.usbr.gov/tsc/techreferences/designstandards-datacollectionguides/finalds-pdfs/DS14-4wMIR.pdf). Horizontal rectangular conjugate depth equation, §4.6.4.4.1.
- [U.S. Army Corps of Engineers, *Hydraulic Design of Spillways*, EM 1110-2-1603, 1990](https://www.publications.usace.army.mil/Portals/76/Publications/EngineerManuals/EM_1110-2-1603.pdf). Experimental jump regimes and calculation of hydraulic jump head loss.
- [Hang Wang, Xinqian Leng and Hubert Chanson, *Hydraulic jumps and breaking bores: modelling and analysis*, 2017](https://staff.civil.uq.edu.au/h.chanson/reprints/Wang_Leng_Chanson_eacm_2017.pdf). Original smooth-flume experiments with matching tailwater, photos, and measured free-surface/recirculation behavior.
- [Hang Wang and Hubert Chanson, *Free-surface deformation and two-phase flow measurements in hydraulic jumps*, 2013](https://espace.library.uq.edu.au/view/UQ%3A299515). University of Queensland report CH91/13, Table 3-1, measured roller lengths used to choose the visualization scale.

The apparatus, procedural material maps, water meshes and lighting are original. Both renderers use the same geometry and optical materials. Use **Pause water** to hold the view. Under reduced-motion settings the **Step water** button advances it.

Run the Margo showcase build at the repository root and serve the result over HTTP. Add `?backend=webgl2` to exercise Margo’s compatibility renderer. The public engine commit is recorded by the showcase build.
