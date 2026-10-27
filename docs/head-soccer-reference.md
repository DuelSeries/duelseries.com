# Head Soccer (D&D Dream, 2012) reference numbers

Scope: the base mobile game by D&D Dream (iOS Feb 2012, Android), not LaLiga or clones. Written 2026-10-26.
Rule of this doc: every number has a source and a method, or is UNKNOWN. Nothing is a plausible guess.
Machine-readable copy: `head-soccer-reference.json` (same numbers).

## Sources

| id | what | URL |
|---|---|---|
| V1 | Gameplay video, early version (Arcade, South Korea vs Cameroon), uploaded 2012 per page, 480x272, 29.97 fps, full-screen game capture | https://www.youtube.com/watch?v=zqLrbp1QrlA |
| V2 | "Head Soccer: Gameplay & Review" by HMzGame, about 2013 (has League/Tournament screens, so v2.0 or later), 1280x720, 29.97 fps, Android tablet screen capture. Main measurement source | https://www.youtube.com/watch?v=nAvkW0aJKf4 |
| W-SD | Wiki, Sudden Death | https://headsoccer.wiki.gg/wiki/Sudden_Death |
| W-CT | Wiki, Controls | https://headsoccer.wiki.gg/wiki/Controls |
| W-PS | Wiki, Power Shots and Power Shot Guide | https://headsoccer.wiki.gg/wiki/Power_Shots , https://headsoccer.wiki.gg/wiki/Power_Shot_Guide |
| W-UH | Wiki, Update History (1.0 = 2012-02-03) | https://headsoccer.wiki.gg/wiki/Update_History |
| W-CH | Wiki, Characters (South Korea is the only character not needing unlock) | https://headsoccer.wiki.gg/wiki/Characters |
| W-GL | Wiki, Glitches | https://headsoccer.wiki.gg/wiki/Glitches |
| W-GM | Wiki, Game Modes / Survival / Head Cup / Multiplayer | https://headsoccer.wiki.gg/wiki/Game_Modes |
| AS | App Store listing (physics engine is Box2D) | https://apps.apple.com/us/app/head-soccer/id487119327 |
| IS | iPhoneSoft review, May 2012 (power bar at top, "Trick" via Power button, buttons at bottom) | https://iphonesoft.fr/2012/05/31/test-head-soccer |

Notes on method. The official-art screenshots on store pages were not usable (the App Store page returned no image URLs, the Play page did not load). All pixel numbers come from public gameplay videos V1 and V2, decoded frame by frame in the built-in browser (video drawn to a canvas, seek to exact frame times k*1001/30000 s, ball found by a white-disc detector, players by background subtraction against a median background, curves fitted by least squares). No frames or assets were saved or copied. The game surface in V2 is 1196 x 720 video px (black Android nav bar to the right of x=1195); this equals about 800x480 scaled 1.495. Call this frame W=1196, H=720. All V2 pixel values below are in this frame. "H/s^2" means screen heights per second squared. 800x480 logical values are only valid if the game's logical size really is 800x480 (inferred from the aspect, not confirmed).

Caution: the footage is v1.0 (V1) and about v2.x (V2). The current app (v7.x) has more modes, a dash (double tap), 100+ characters. Only the early versions were measured.

## 1. Match rules

| item | value | source | method |
|---|---|---|---|
| Match length | 60 s | V1, W-SD | Timer starts at "1:00" (V1 t=22 s) and counts down. Wiki says "the minute of play given at the beginning". |
| Timer display | "M:SS", e.g. 1:00, 0:59 ... 0:00, small "TIME" label above, centred at top | V1, V2 | Frames |
| Timer speed | 1 tick per 1.001 s of video time, i.e. real time | V1 | Tick-edge detection on the digits, ticks at 51.685, 52.686, 54.688, 55.689, 56.690, 57.691, 58.692 s |
| Timer pauses | Clock freezes while the GOAL banner plays, about 2 to 2.5 s per goal (coarse) | V1 | Over 78 video s the clock only advanced 55 s with 6 goals plus power cutscenes; gauge and clock plateaus 1.5 to 2.5 s long |
| Tie at 0:00 | Sudden death | W-SD | Wiki text |
| Sudden death | No time limit, first goal wins immediately, power bars do not charge, a power shot already held carries over | W-SD | Wiki text |
| Draws | Only in Head Cup group stage; all other modes go to sudden death | W-SD, W-GM | Wiki text |
| Score limit | None seen. Final scores seen: 5-2, 7-6 (13 goals in 60 s of clock) | V1, V2 | Result screen at V2 t=138 s |
| How a match ends | Clock hits 0:00, then a "RESULT" screen: "YOU WIN/LOSE", both flags and scores, "REWARD POINT", "TOTAL POINT", NEXT button | V2 | Frame at t=138 s |
| Kickoff (start and after every goal) | Both players snap to fixed start x; a NEW ball appears at rest at screen centre and drops under gravity. Nobody gets possession. | V2 | Kickoffs at 38.84 s and 43.71 s: ball first seen at x=600, y=226 with v0 about 0 (fit v0 = 22 and 9 px/s) |
| Ball spawn point | x = 600 px (0.50 W), y = 226.5 px (0.315 H), zero initial speed | V2 | Two kickoffs, fitted y0 = 226.7 and 226.2 |
| Kickoff text | "KICK OFF" in yellow outlined lettering with a ball icon above, at match start; no 3-2-1 countdown seen | V1 | Frame at t=22 s |
| Goal feedback | Big gold italic "GOAL!" banner, letters animate in, covers about 0.7 W by 0.4 H of screen centre, ball keeps rolling during it | V1, V2 | Frames at V2 t=38.0, 60.0, 83.0 |
| Ball stuck rule | UNKNOWN. Tried: wiki Glitches, searches. Wiki only notes a ball "stalling in the air" glitch that was patched. | W-GL | |
| Standing in own goal | UNKNOWN as a rule. Wiki lists an own-goal glitch for Senegal only. Players can walk into the goal mouth up to head-box x 46 (see 4). | W-GL | |
| Modes (for scope) | Arcade (single match), Tournament, Survival, League (added 2.0), Head Cup (3.0), more later | W-UH, AS | |

## 2. Controls (base game)

| item | value | source | method |
|---|---|---|---|
| On-screen buttons | Left arrow "L" and right arrow "R" at bottom left; "Kick" and "Jump" at bottom right; a "Power" button appears left of Kick only when the gauge is full | V1, V2, W-CT | Frames; wiki "appears only when the power bar is full" |
| Move | Hold L or R to keep walking; speed set instantly (no ramp visible) | V2, W-CT | See 5 |
| Jump | Single button, one jump, can steer in the air | V2 | Per-frame jump track |
| Kick | Button swings the boot out toward the opponent side. Works while airborne (seen at kickoff, player mid-jump, boot extended to the ball). In that example a ball on the ground was sent left at about 520 px/s with a slight lift (vy about -90 px/s). General lift behaviour: UNKNOWN. | V2 | Frames 39.84 to 40.5 s, ball track 40.2 to 40.5 s |
| Heading | No button. Head is a solid body; ball bounces off it (ball left a head at 646 px/s, vx 341, vy -549) | V2 | Track at 100.6 s |
| Dash | Not in the early footage (no dash button). Current app adds double tap dash. | V2, W-CT | |
| Combos | Controls can be combined (kick while running, power while jumping) | W-CT | |
| Power activation | Tap Power when gauge is full; then the next ball touch becomes the power shot | W-CT | |
| Key bindings | n/a on mobile. (Browser clones use A/D/W/S/Q, not the original.) | | |

## 3. Power shot

| item | value | source | method |
|---|---|---|---|
| Gauge fills over | Game clock, roughly linearly. Rate about 5.3 to 5.4 px/s on a 480 px wide frame. Empty to full about 20 clock seconds (range 19 to 23) | V1 | Left bar leading edge tracked at 10 Hz for 22 to 108 s; rate held between plateaus where the clock was frozen. Cycle check: reset at about 78 s, full at about 105 s with about 20 timer-seconds elapsed |
| Gauge after using power | Empties instantly, screen dims (lightning cutscene) for about 0.9 s, then refills from zero | V1 | Bar not visible 48.5 to 49.4 s, refilled from 49.4 s |
| Concede bonus | Being scored on tops the gauge up. Seen 2 of 2: 86% to full (at 46.5 s) and 66% to full (at 63.3 s). Whether it sets full or adds at least 34%: UNKNOWN | V1 | Bar edge jump right after the GOAL banner |
| Scoring bonus | None seen (3 of 3 own goals: gauge unchanged) | V1 | Plateaus at 30, 38 to 40, 80 s |
| Touch-based fill | Not supported by data (steady ramp between events) | V1 | |
| Full state cues | Gauge turns saturated orange/red with a glow; the character gets a yellow glow (early versions, removed after 3.0); Power button appears left of Kick | V1, V2, W-CT | Frames |
| Gauge look | Flame/lightning shaped bar with "POWER" printed in it, white/grey outline when empty, fills from the flag outward in yellow-green, yellow, orange, red | V1, V2 | Frames |
| Sudden death | Gauges do not charge | W-SD | |
| CPU behaviour | CPU fires its power shot as soon as it has it | W-PS | |
| Default character | South Korea (only one not needing unlock). Its shot is a "straight-line shot"; wiki advice is to jump and fire from own half; knocks the opponent out every third use (current app). Speed and trajectory numbers: UNKNOWN | W-CH, W-PS | |
| Cutscene | Power use triggers a dim/dark screen with lightning streaks, about 1 s | V1 | |
| Counter | A power shot can instantly block an opponent's power shot | W-PS | |

## 4. Field geometry (V2 frame, W=1196, H=720)

| item | px | fraction | source / method |
|---|---|---|---|
| Game frame | 1196 x 720 | aspect 1.661 | Black from x=1196. About 800x480 at 1.495 |
| Camera | static, no scroll or zoom | | Whole match |
| Ground (boot soles) | y = 598 | 0.831 H | Player blob bottom at standing, both players, all kickoffs |
| Ball resting-centre on ground | y about 574 to 578 | 0.80 H | Bounce data; bottom about 595, within 3 px of soles |
| Ground inside goal (ball) | ball centre y = 586 at x = 30 | | Ball rested in left net 112.0 to 113.2 s |
| Player head width | 80 | 0.067 W, 0.111 H | Blob bbox, many frames |
| Player head height | 70 (hair top y=506 to chin y about 577) | 0.097 H | Crop with grid |
| Player total height | 92 (y 506 to 598) | 0.128 H | Blob bbox |
| Boots and body | tiny: black boots about 60 to 65 wide, short neck/shirt band, about 22 tall below the head | 0.05 W | Crop with grid |
| Ball diameter | 37 (+-2) | 0.031 W, 0.051 H, 0.46 head width | Blob bbox 38x36, 42x38 |
| Player start x (head centre) | left 248, right 948 (head box 208..288 and 908..988) | 0.207 W and 0.793 W | Kickoffs at 38.87, 43.74 s, repeatable to 2 px |
| Player x limits (head box) | 46 to 1150 | 0.039 W to 0.961 W | Min x0 and max x1 over 91 s of play; symmetric (1196-1150=46) |
| Goal depth (screen x) | left 0..66, right 1130..1196 | 0.055 W | Row scan: front white post x 36..44 (left) and 1152..1160 (right), grey side face to x 66 and 1130 |
| Goal top edge (crossbar top) | y = 404 | 0.561 H | Column scan at x=1170, dark outline at y=404 |
| Goal frame bottom | y = 607 | 0.843 H | Column scan at x=1190 |
| Goal height | 203 (frame), 194 above the soles | 0.28 H, 5.5 balls, 2.5 head widths | |
| Crossbar thickness | UNKNOWN. Goal is a perspective sprite: top strip about 30 px tall including net roof; the white bar edge by eye about 8 to 10 px | | Crop view, low confidence |
| Crossbar a flat ledge the ball rests on | UNKNOWN. No resting ball near goal top in 91 s of 10 Hz tracking; physics shape not visible | | |
| Jump vs crossbar | Jump apex head top y=436, crossbar top y=404: a player's head never reaches the bar height | | Jump track |
| Ceiling | None observed up to ball top edge y about 78 (ball apex 99.55 s, centre y about 97, smooth arc behind the HUD). Above that UNKNOWN | | Crops 99.2 to 99.8 s |
| Side walls | Playfield ends at the goal backs (x=0 and x=1196). Ball seen resting with centre x=30 in the net. | | Track |
| Stadium layers (top to bottom) | HUD strip over night sky (y 0 to about 120), grey upper stand wall, two tiers of crowd (y about 130 to 330), teal/blue banner strips, crowd tier 2, red/yellow barrier, ad-board band (y about 500 to 545), grass (y about 545 to 720) | | Frames |

## 5. Physics (V2 unless noted)

| item | value | fraction | source / method |
|---|---|---|---|
| Ball gravity | 705 px/s^2 (+-20) | 0.98 H/s^2 | Five clean fits: kickoff drops 693, 709 (v0=0 forced; rms 1.7 px, 30 pts); same drops free fit 697, 708; free arc 100.63 to 101.94 s 719 (39 pts, rms 3.9; up leg 707, down leg 736); bounce-drop 75.0 to 75.93 s 718 (28 pts, rms 1.9). Two noisier arcs gave 600 to 670 (arc near HUD, coarse 0.1 s samples); not used |
| Gravity in 480-high logical px | 470 (+-14) | | Derived: 705 / 1.5. Valid only if logical height = 480 |
| Ball vertical restitution (ground) | 0.64 (+-0.04) | | Three successive apexes at x=600: y=424.1, 511.1, 548.9, ground-contact centre y about 576: heights 152, 65, 27, ratios 0.43 and 0.42, e=sqrt = 0.65 and 0.64. Time-based check gave 0.60. Window 75.0 to 77.3 s |
| Ball air drag | negligible: horizontal speed fit 341 px/s with curvature -35 px/s^2 over 1.3 s | | Free arc fit |
| Ball launch speed after contact | 520 to 700 px/s typical (0.43 to 0.58 W/s); head hit 646; fastest sustained flight seen 800 to 870 px/s (0.7 W/s, unverified cause, maybe a hard kick or power shot) | | Boot kick 40.2 to 40.5 s (513 px/s); head hit 100.6 s; 0.1 s track speeds, smooth runs only |
| Player walk speed | 315 px/s (+-10) | 0.263 W/s, 3.9 head widths/s | 10 ground runs, 0.1 s samples, 277 to 337 px/s with most at 310 to 320 (e.g. 93.6 to 94.7 s: 316 px in 1.0 s). Reaches full speed within about 0.1 s |
| Air control | Horizontal velocity kept in the air (320 px/s over a full jump) | | Jump track 78.35 to 78.98 s |
| Jump height | 70 px (head top 506 to 436) | 0.097 H, 0.88 head widths, 0.34 goal heights | Per-frame track of a full jump; 6 more jumps at 0.1 s samples gave apex 434 to 440 |
| Jump airtime | 0.87 s (+-0.03): leaves ground between 78.345 and 78.378 s, back down by 79.246 s; apex at about 78.80 s | | Per-frame blob track |
| Jump take-off speed | 322 px/s up (0.45 H/s) | | Derived: v0 = 4h/T = 4*70/0.87 |
| Player gravity (implied) | 740 px/s^2 | 1.03 H/s^2 | Derived: g = 8h/T^2. Within 5% of ball gravity, so likely the same world gravity |
| Ball spin | Pattern visibly rotates in flight; angular speed UNKNOWN | | Frames |
| Physics engine | Box2D (store listing) | | AS |
| Kick impulse model, mass ratios, friction | UNKNOWN | | |

## 6. HUD (V2 frame, 1196 x 720; V1 same layout)

| element | position and look |
|---|---|
| Layout | Single strip at top, mirror symmetric around x=602: [left power gauge][left flag][TIME + clock][right flag][right power gauge][pause button] |
| Flags | National flag in a 100 x 63 box with thin light-green border. Left x 413 to 513, right x 692 to 792, y 20 to 83. Flag shows the character's country; no names or portraits |
| Clock | Dark rounded "TIME" label (yellow caps) above white "0:52" digits with dark outline, x about 535 to 690, y 10 to 80 |
| Score | Large gold italic digits with dark outline directly below each flag: left centre x about 467, right about 745, y about 84 to 120 (about 40 px tall) |
| Three small round grey icons (shield, "D", ball) under the clock, x about 560 to 660, y about 70 to 100. Meaning UNKNOWN |
| Power gauges | Flame shaped bars, left x about 90 to 400, right x about 798 to 1105, y about 28 to 78. "POWER" text on the outer half. Fill starts at the flag and grows outward |
| Pause | Round button, two vertical bars, brown ring, centre (1154, 44), diameter about 64 (x 1122 to 1186) |
| Move buttons | Two gold arrow shapes "L" and "R", brown outline, semi-transparent, x 23 to 418, y 627 to 710, about 190 px each with a 15 px gap |
| Kick, Jump | Rounded gold buttons with brown outline, Kick x 765 to 970, Jump x 985 to 1181, y 624 to 708 |
| Power button | Same style, left of Kick, x about 554 to 772, only while gauge is full |
| GOAL banner | Gold gradient italic "GOAL!", blue-white inner outline, dark drop shadow, huge, letters slam in; bbox up to about x 112..950, y 198..502 mid animation |
| Pre-kickoff | "KICK OFF" text at match start only. No numeric countdown seen |
| Player names/portraits | None in match HUD. Portraits appear on Player Select (big faces, "VS" lightning, PLAY button) and Result screens |

## 7. Look (describe, do not copy)

| item | description |
|---|---|
| Style | Chibi cartoon: huge heads, tiny black boots, almost no body, big eyes with bold brows, soft outlines, glossy gold UI with brown strokes. Crowd is tiny pixel-art spectators, so art is a mix of smooth and pixel |
| Sky and stadium | Night: dark navy (#002a48 at top centre to #13497d / #1e5c7b at the sides) with big white spotlight glows (blue-white). Grey concrete upper wall (#b2b0b6, #696967) |
| Crowd | Two tiers of pixel spectators in mixed shirt colours (red, yellow, green, blue, white), some waving yellow/red banners. Teal-blue banner strips (#0d85ef family) between tiers |
| Ad board band | Continuous board about 45 px tall, y 500 to 545: pink/magenta, sky blue (#009ee2, #0982c0), red, white lettering ("SPECIAL THANKS ..." style). Red barrier strip above |
| Grass | Light yellow-green #9ec46a base with #aed077 bands, soft horizontal stripes, white lines (#bfdd9c to #c8e3a3 thin) with a centre circle near x=600 and penalty boxes at each end |
| Goals | White tubular frame, grey inner side face, light grey/white net grid with a slight red tint from the barrier behind, drawn in perspective (top frame leans toward the pitch) |
| Ball | White with black pentagon pattern, outlined, no shading to speak of |
| Characters | Per country: national flag in HUD, hair, skin tone and face differ, kit colours differ. Black boots on all in footage |
| Power effects | Yellow glow on a charged character, flame-colour gauge, dark screen with lightning streaks for the shot, characters shout the shot name (TV Tropes) |

## Not found / UNKNOWN (and what was tried)

- Ball-stuck rule, own-goal standing rule: wiki Glitches page, searches; nothing stated as a rule.
- Crossbar thickness (exact) and whether the bar is a ledge: no still with clean edge; no resting ball seen; physics shape not visible.
- Ceiling above y about 78: highest ball seen is behind the HUD; no ball seen hitting a top boundary.
- Default character's stats, shot speed and trajectory: wiki gives only "straight-line shot".
- Whether the concede bonus sets full or adds a fixed share (only two observations, both reaching full).
- Ball angular speed, kick impulse, friction, mass: not isolable from 30 fps lossy video.
- Right-hand (opponent) gauge fill: detector failed on the right bar; only left (South Korea) measured.
- Official web version: none found. Only third party clones and unofficial Chrome extensions. dnddream.com lists no web build.
- Store screenshots: App Store and Play pages did not expose image URLs to the fetch tool, so geometry comes from video frames instead.
