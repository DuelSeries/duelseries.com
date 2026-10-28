# Swim (the 3D traffic race): research and the choices it drove

Checked 2026-10-26 by two research agents (games, and tech). Sources are store listings, changelogs,
reviews and docs; nobody publishes their camera, lane or spawn numbers, so those are marked "not found"
and our own numbers are tuned against a bot harness instead (`node scripts/swimBotSim.js`).

## What the genre does

| | Traffic Racer | Traffic Rider | Highway Rider | Web (Crazy Traffic Racer, Racing Limits) |
|---|---|---|---|---|
| Camera | chase; view distance grows with speed; shake at speed and on hits | first person only | first person mode | chase, hood, cockpit, heli |
| Lanes | 4, one-way or two-way (oncoming pays 3x) | 4, one-way or two-way | multi-lane, denser after v1.8 | 4, two-way pays most |
| Speed | auto-accelerate option; bonus only above 100 km/h | bonus above 100 km/h | not found | braking holds ~30 km/h |
| Traffic | cars, trucks, buses (a bus blocks two lanes); density cut back when overcrowded | speeds up, slows, changes lane with late blinkers | denser over versions | combos reset on contact |
| Near miss | bonus score and cash, consecutive and double overtakes | +0.1 s on the timer | scored by how close | combo, free NOS |
| Phone | tilt or touch, gas right, brake left, analog slider | tilt, gas right, brake left | not found | touch |
| PC | arrows or WASD | n/a | n/a | arrows or WASD, C camera |
| Multiplayer gap HUD | not found anywhere | | head-to-head exists | 1v1 exists, rivals "crash without contact" (sync complaint) |

Steering is free analog everywhere (no lane snapping). Complaints worth avoiding: hitboxes bigger than the
car, traffic that makes gaps impossible, top speed that feels slow, stiff repetitive crashes, and in
multiplayer, opponents seeing different traffic.

## Feeling fast without being unfair

- Wider FOV raises perceived speed; strong motion blur lowers it (Holm et al. 2017). MotoGP widens FOV
  with speed; tying it to acceleration feels like a lurch (Hargreaves).
- Highway design assumes 2.5 s perception-reaction time. So visibility should be set in seconds of
  closing time, not metres: the fog has to keep a blocker visible for at least ~2.5 s at the closing
  speed it will be met at.

## Tech

- three.js r186 (0.186.1), module builds only: `three.module.min.js` imports `./three.core.js`; vendored
  under `public/vendor/three/` (minified pair ~194 KB Brotli) and mapped with an importmap.
- Phones: one `InstancedMesh` per vehicle type (frustumCulled off, count set per frame), pixel ratio capped
  (dpr 2 cost 2.1x), antialias off, blob shadows instead of a shadow map (+14%), Lambert or Basic with
  vertex colours, fog plus a matching sky, no per-frame allocation, no post-processing (a blur pass cost
  +6 ms at dpr 2). FOV widening and camera shake are free; ~100 thin speed streaks are cheap, 300 are not.
- Determinism: `Math.sin/cos/exp/log/atan2` differ in the last bit between Node and Chrome for 3 to 10%
  of inputs; `+ - * /` and `sqrt` match. So the shared step uses only those.
- Headless fps: system Chrome in new headless mode gets the real GPU on this PC; for true frame cost run
  uncapped (`--disable-frame-rate-limit --disable-gpu-vsync`) and force a 1x1 `readPixels` each frame.

## The choices (what Swim does, and why)

- **Road:** 4 lanes one-way, 3.6 m each, left lane fastest (27 m/s) to right lane slowest (18 m/s);
  trucks and buses only in the two right lanes. One-way keeps the rule "touch anything and you lose"
  readable; two-way is a later mode if wanted.
- **Speed (Owen 2026-10-28: about 350 km/h):** a cruise speed that climbs from 130 km/h towards 302 (half
  way after 70 s); W pushes 16% over it (flat out heads for 351 km/h), S brakes all the way to 54 km/h
  (below every lane, so a boxed-in car can always drop back and pull out), no pedal settles back to
  cruise. Braking costs ground, which is the tension against the 200 m rule.
- **Steering:** free analog; the faster the car, the gentler the wheel: 11.5 - 0.075 v m/s sideways at full
  lock, held between 4.5 and 10.5 (8.8 at the start, a lane in about half a second; 4.5 flat out, nearer a
  second), always reached in about 0.19 s. Keys send full lock, a phone thumb sends anything between.
- **Traffic:** seeded and server-authoritative; each car is a record sent once and computed everywhere, so
  both players and every watcher see exactly the same road. Gaps shrink from ~95 m to ~17 m per lane (half
  way after 75 s) and trucks get more common (mostly right, about a third as often in the two left lanes).
  Before placing a car, the spawner checks the other three lanes now and at the moment the front car will
  reach it, and never shuts all four. Some cars change to the next lane (1 in 20 at the start, up to 1 in
  6): indicator 2.5 s before, brake lamps the last second, a 1.5 s move at their own speed, planned at
  spawn and only where the target lane has room; from the indicator on they count as in both lanes.
  Traffic hitboxes are 1 cm inside the body, so the line between two lanes is a squeeze, not a corridor.
- **Fairness under lag:** each car is judged on its own tick against the traffic as it was then (what its
  driver saw); the two are compared only on ticks both reached. A stalled connection is moved on with its
  last input after 250 ms, so it can neither hold the race up nor buy time.
- **Players pass through each other** (the other car is drawn as a ghost): no ramming, no dispute over
  who hit whom, and the only contact rule is traffic.
- **Camera:** chase cam about 2.6 m up, 6.5 m behind, FOV widening with speed, shake rising with speed,
  speed streaks; new cars appear 520 m past the leader, 60 m inside solid fog (fog 160 to 460 m), so a
  blocker is in clear view for over 4 s even flat out. Indicators flash while a car steers, brake lamps
  glow while it brakes.
- **Close pass (Owen 2026-10-28: a real reward):** a car passed with under 0.6 m to spare (measured on the
  tick its front goes behind your rear) gives up to +14 m/s at once, more the closer, and says "Close"
  with a whoosh and a gold edge flash, counted on the result card. It is worked out inside the shared step,
  so the server agrees; it can lift you up to 14 m/s past your top speed and bleeds off at 4 m/s a second.
  After a boost there is no other for 1.2 s.
- **Gap HUD:** a rope at the top from 200 m behind (you lose) to 200 m ahead (they lose), filling toward
  whoever is in front, with a "Catch up: N m left" warning past 140 m behind. No game in the survey shows
  this; it is the rule that makes Swim a duel.
- **Phone:** drag anywhere on the left to steer (thumb-anchored, analog), hold Gas and Brake on the right.
  Tilt was not built (open question for Owen).
- **Bot (free tables only):** reads each lane's time-to-collision with an error that grows with speed and
  only looks again after its reaction time (150 to 230 ms), changes lane only when the way is clear,
  brakes when boxed. Bot against bot: median race about 80 s, p90 about 3 minutes. It keeps to lane
  middles, so it never earns a close-pass boost.
