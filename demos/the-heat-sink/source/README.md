# The Heat Sink

Turn up the fan to see how forced air cools the chip and the aluminium fins. Switch thermal view to see the metal, fin stack and fan hardware.

The thermal model balances energy at the chip, spreader and six finite-volume cells along the fins. Conductance depends on material, contact and cross section. Convection removes heat over each cell's exposed area to room air at 24 °C. Fan speed changes a representative surface heat transfer coefficient. The simulation runs at twenty times model time, and temperature readings show the computed node temperatures.

The air marks indicate direction and relative fan setting. They do not solve airflow. Contact conductance, fan convection, and the exposed surface coefficients are illustrative inputs. Exact performance for a physical assembly depends on its layout and airflow.

## References

- P. Teertstra, M. M. Yovanovich and J. R. Culham, *Analytical forced convection modeling of plate fin heat sinks*, 2000. [University of Waterloo Mechanical and Mechatronics Engineering](https://www.mhtlab.uwaterloo.ca/pdf_papers/mhtl02-1.pdf).
- NASA Technical Memorandum 20230011420, 2023, thermal resistance network for a finned heat sink. [NASA Technical Reports Server](https://ntrs.nasa.gov/citations/20230011420).
- Z. Duan and Y. S. Muzychka, *A practical plate-fin heat sink model*, 2011. [Applied Thermal Engineering](https://doi.org/10.1016/j.applthermaleng.2010.10.014).

The exhibit uses Margo Engine. Add `?backend=webgl2` to exercise the same exhibit through WebGL2.
