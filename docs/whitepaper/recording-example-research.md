# Recording example activation review

The required README run exposed an activation bug: the recording example awaited
AudioContext.resume at module scope. An instrumented real-browser probe observed
state suspended with no user activation; a trusted click released the same module
and its original recording completed. No recorder or browser teardown code changed.

Research compared these primary sources before changing the example:

- Benjamin Taylor and Jesse Allison, *Gesture Capture, Processing, and
  Asynchronous Playback within Web Audio Instruments* (2015),
  [ICMC paper](https://taylorbf.github.io/articles/gesture-icmc15.pdf), on
  interaction and asynchronous event structure.
- Paul Adenot and Hongchan Choi (editors), *Web Audio API* (2021),
  [W3C recommendation](https://www.w3.org/TR/2021/REC-webaudio-20210617/), on
  allowed-to-start and pending resume promises.
- Francois Beaufort, *Autoplay policy in Chrome* (2017, subsequently updated),
  [browser guidance](https://developer.chrome.com/blog/autoplay), on starting
  audio from interaction.

The paper motivates the event structure; the standard and browser guidance
establish the activation requirement. No companion code was read or copied.
The example now creates a Record button during initialization and starts its
existing recording body from the click handler. This combines explicit user
interaction with the existing asynchronous recording lifecycle.

packages/video/test/readme-record.test.js executes the exact README snippet with
audio permission held unresolved. It proves initialization creates no audio,
capture waits for permission after activation, and owned resources are released.
The old snippet fails the initialization state assertion directly, without a
timing assertion, deadline change or retry. The one-second media duration remains
sample content, with no performance or cross-browser capability claim.
