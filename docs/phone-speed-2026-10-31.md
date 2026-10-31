# Phone speed pass, 2026-10-31

Every live game and the lobby, measured as a phone first, the biggest costs cut without changing a pixel or a
rule, then measured again the same way. Harness: `scripts/phonePerf.js` (how-to in its header) against
`scripts/dev-local.js` with `SL_ENABLED=1`: headless Chromium as a Samsung S24 (384 x 832 at dpr 2.8125, touch,
phone user agent), CPU throttled 4x, cache off, the free room with bots, a scripted finger. Rooftop and Head
Soccer were measured sideways. There is no GPU in the cloud box (SwiftShader), so frame rate and paint time are
not a phone's: the numbers below are main-thread script and busy time. Each "after" is an A/B of the changed
files against HEAD in the same setup, 2 runs each unless noted.

| Game | Main cost found | Before | After |
|---|---|---|---|
| Pac-Man | a GPU readback (getImageData) for every new score string, stalls up to 2 s under throttle | 11.96 ms script/frame, 7 long tasks | 3.52, 0.5 |
| Rooftop Snipers (sideways) | the pixel lettering, one fillRect per square, 1,377 a frame | 6.34 | 3.82 |
| Rooftop Snipers (upright) | the whole scene drawn under the opaque turn-sideways card | 5.46 | 0.89 (1 run) |
| Knockout | the clock rewrote its text every frame: 60 layouts a second | 4.42 ms busy/frame | 2.76 |
| Swim | three.js re-checked shader programs every frame (one material three ways, double-sided glows drawn twice) | 4.55 ms script/frame | 3.83 |
| Swim scene alone (deterministic demo, 3 runs) | same | 6.61 | 5.27 |
| Crossy Road | the rival's tag rewrote its text and hidden every frame | 5.44 | 3.57 |
| Head Soccer (sideways) | collision test garbage (separatingAxis arrays), 2.9 MB/s | 2.91 MB/s garbage | 1.85 MB/s |

Proof the look and play did not change: Rooftop's old and new lettering drawn side by side, 0 of 614,400 pixels
differ; Swim's fixed-step scene (seed 3 near miss, seed 5 crash) 0 differing pixels; Head Soccer's old and new
physics stepped side by side for 432,000 steps of random play, every state identical (a one in ten million
nudge to the new code is caught at step 2,177). Commits 0ec791c, d66bcfb, be5ec6a, 5ec5aed, 65c26b5, a885b81.

## Measured, not changed

- slither.io (/sl): about a second after every spawn the minimap background is redrawn and turned into an image
  with toDataURL, a synchronous GPU readback (0.9 to 2.6 s here on the software GPU, unthrottled; one 4.3 s long
  task under throttle). A CPU-side canvas (willReadFrequently) ends the readback, but its shadow blur differs from
  the GPU's by up to 48 levels on 7% of the pixels, so it is not a no-change fix; and the slither client is held
  to its parity goldens, which already fail in the cloud box (below). Needs a real phone: on a real GPU the stall
  should be one frame or two. The page also spends 1.3 s (4x) building its sprites at load (slSprites
  buildSprites, parity-gated).
- Lobby: idle it costs 93 ms of main thread a second at 4x with no frame loop running (the live dots' CSS
  animations, already cut on 2026-10-28). Of its 3.7 s load at 4x, the wallet widget (`/wallet/widget.js`,
  5 MB, 1.2 to 1.5 MB compressed on the live site) takes 1.4 s to run, parser-blocking. Wallet code: not touched.
- agar.io 2.65 ms script/frame, Paper.io 3.1, 8 Ball Pool 1.85, Battleship 0.17: spread over their drawing,
  no single cost worth a change. Paper, agar.io and Pac-Man rebuild the shared leaderboard (dsEnd board.set)
  only when a score changes, a few times a second.
- Air Hockey: light on the main thread (3.7 ms) but 9 shadowBlur draws a frame; here it is held to 14 fps by the
  software GPU. Needs a real phone to say whether the shadows cost one.
- Crossy Road's 2D HUD is about a quarter of its frame (blockText squares, 346 fillRects); skipping unchanged
  redraws would need a change key that also covers fonts loading and the moving rival arrow. Left.

## Could not measure here

A real GPU (paint, overdraw, shadowBlur, three.js fill rate), real phone thermals, and mobile network time to
playable (localhost; the bytes are in the harness output). The test suite has 29 failures and 13 cancels on a
clean checkout of 7823cef in the cloud box (agar.io goldens, agShutdown, agReviewFixes, slither parity goldens),
the same before and after this work.
