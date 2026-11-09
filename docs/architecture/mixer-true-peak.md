# Mixer finite-FIR true-peak bound

`mixer/worklet` uses the four 12-tap phases printed in ITU-R BS.1770-5 Annex 2.
This is a ceiling for that specified reconstruction estimate, including sample peaks.
It is not a bound for every possible DAC, reconstruction filter or later lossy codec.

For compressor output x (after explicit make-up), each incoming sample n completes a
12-sample window. Compute B[n] as the largest, over channels and phases, of
sum(k=0..11, abs(h[phase,k] * x[channel,n-k])). Include abs(x[channel,n]) as well.
Set c[n] = min(1, C / B[n]), taking c=1 for a zero bound. C is the desired linear
ceiling times (1 - 2^-22), leaving more than the float32 relative rounding bound.

Delay output by 11 samples. At input time n, output sample m=n-11 can use every
window cap c[m] through c[m+11]. Its gain g[m] is no greater than their minimum.
Release smoothing may lower this gain further; it never raises it over that minimum.

For any reconstructed window ending at j, each participating sample k in [j-11,j]
has g[k] <= c[j]. The triangle inequality gives:

    abs(sum(h[j-k] * x[k] * g[k]))
      <= sum(abs(h[j-k] * x[k]) * g[k])
      <= c[j] * B[j]
      <= C.

The included sample constraint also bounds the original output samples. Finite inputs,
bounded parameters and float64 accumulation precede the float32 output rounding. The
margin covers that rounding. Missing inputs are zeros; processing continues through the
delay. Cutting a stream at disposal only removes terms from the absolute bound. Every
channel uses one shared gain so spatial balance is preserved.

This deliberately uses an absolute-sum bound rather than cancellation in the interpolated
waveform. It can attenuate a waveform whose actual reconstructed peak is below the ceiling.
It applies gain rather than clipping samples. There is no claim of maximum transparency,
minimum attenuation, infinite-band reconstruction accuracy or listening-test equivalence.
The 11 samples are algorithmic latency, excluding device and other graph buffering.

The compressor before this guard uses the published piecewise soft-knee static curve of
Giannoulis, Massberg and Reiss (JAES 2012), peak-linked across channels, then a linear-gain
one-pole attack/release recurrence. Time options are time constants. There is no automatic
make-up gain, native DynamicsCompressorNode or browser-selected curve.

`worklet.test.js` checks static knees and levels, the exact attack recurrence, transparent
quiet input after the delay, adversarial impulses/noise/quarter-rate tones, linked channels,
and bit-identical output for 17- and 128-frame blocks. The metering implementation is also
checked against independent direct convolution with the published numeric table, including
zero-padded ends. `browser.js` renders real AudioWorklets beside both rendering backends.
All signals are generated stand-ins. Other browsers and converters, listening quality and
performance are unmeasured. Use the GPU-lock command documented in the mixer README.
