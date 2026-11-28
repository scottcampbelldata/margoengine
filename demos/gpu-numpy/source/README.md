# GPU NumPy

An array-expression workbench powered by Margo Compute. Edit the expression and choose **Run expression**, or run one of the three examples. The heatmap or vector plot shows the computed output. Click a cell or use **Inspect value** to read the corresponding number. For a complex output, the plot shows magnitude and the inspector reports real and imaginary components.

## Expressions

- `A` and `B` are original 24 × 24 float32 matrices. `signal` is a 128-sample signal with components at bins 7 and 23. `samples` is a reproducible 128-value vector.
- `A @ B` and `matmul(A, B)` use Margo's matrix product. `fft(signal)` and `ifft(...)` transform the last axis. `sort(samples)` uses Margo's sort. `magnitude(fft(signal))` produces a real array that can be used with other array operators.
- Numeric scalars, vectors, rectangular matrices, parentheses, broadcasting, and the displayed element-wise and reduction operations are accepted. Syntax is parsed into a bounded mathematical expression tree with a 1,000-character limit. The last successful result remains visible after an invalid submission.
- The data transfer and operation timer starts before uploading the expression inputs and ends after reading the output. It includes dispatch, execution, and transfer overhead.

## Backends

Native WebGPU runs the three examples through the pinned Margo Compute kernels. If WebGPU is unavailable, the workbench tries the official headless WebGL2 compatibility layer. The compatibility path reports actual GPU and CPU dispatch counts per expression. In the reviewed run the default matrix product used one compatibility CPU dispatch, the FFT used eleven GPU dispatches, and the sort used two GPU dispatches and one CPU dispatch. The package's explicit CPU backend keeps the full workbench usable where both graphics paths are unavailable. Use `?backend=webgl2` or `?backend=cpu` to exercise either path.

Build against [the public Margo Engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). The exhibit ships no external data or art assets.

## Sources

- NumPy project. Array product semantics and broadcasting. [NumPy matmul reference](https://numpy.org/doc/stable/reference/generated/numpy.matmul.html).
- NumPy project. Frequency ordering, magnitude, and inverse normalization. [NumPy discrete Fourier transform reference](https://numpy.org/doc/stable/reference/routines.fft.html).
- James W. Cooley and John W. Tukey, 1965. [An Algorithm for the Machine Calculation of Complex Fourier Series](https://www.ams.org/mcom/1965-19-090/S0025-5718-1965-0178586-1/S0025-5718-1965-0178586-1.pdf).
- Scott Campbell and Margo contributors. [Pinned compute API and backend documentation](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/compute/README.md).
