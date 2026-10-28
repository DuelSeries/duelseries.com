# Air Hockey: the design calls

Owen gave no reference ("honestly just make this one yourself", 2026-10-27), so every number here is ours. Each one
says why it is what it is. Code: `shared/ahSim.js` (the physics, run by the server and replayed by the page),
`server/AirHockeyRoom.js` (rules), `server/AirHockeyLobby.js` (Knockout's queue), `server/ahBot.js`,
`public/airhockey.html` + `public/js/airhockey.js` + `public/js/airhockey/ahArt.js` + `public/js/airhockeySound.js`.

## The table

| What | Value | Why |
| --- | --- | --- |
| Surface | 600 x 1000 units, corners rounded 70 | A real table is about 1.9 long to 1 wide; 1.67 fits a phone held upright with room for the score strip and a thumb. |
| Goal mouth | 210 wide (35% of the width) | Wide enough that a straight shot past a careless defender scores, narrow enough that a mallet (80 across) parked in front makes a shooter work for the corners. |
| Puck | radius 26 | About a real puck's share of the table width, a little bigger so it reads on a phone. |
| Mallet | radius 40 | Ditto; bigger than the puck so blocking is possible. |
| Halfway line | a mallet's centre stays 20 units on its own side | The real rule (a mallet never crosses), with just enough reach that a puck sitting on the line can be hit by either player. |

## The physics (feel first)

- **The puck glides**: drag 0.22 per second plus a tiny constant slowing (14 units/s²), so a hard shot keeps about 80% of its speed after a second and a puck at rest stays put.
- **Rails bounce hard**: restitution 0.9, keeping 97% of the speed along the rail. Bank shots are a real weapon. Posts (the mouth's edges) bounce at 0.75.
- **Top speed 2400 units/s**: end to end in about 0.42 s. Fast enough to feel violent, slow enough that a defender at 100 ms ping still has a chance.
- **A mallet is a hand**: it is never pushed by the puck (infinite mass), goes where you point at up to 2600 units/s (a flick catches up within two frames, so there is no felt lag), and the motion is spread evenly over each step so its speed is smooth.
- **A hit is a bounce off a moving mallet**: restitution 0.78 plus the mallet's own speed along the line of contact. A still mallet blocks; a swing fires the puck faster than the swing.
- **4 sub-steps per 60 Hz step** (240 Hz): the fastest puck moves 10 units a sub-step, under half its radius, so it can never tunnel through a mallet or a rail.
- **Pinned puck**: when a mallet traps the puck against a rail, the puck stays on the table and the mallet is held off it.

## The rules

- **First to 7.** Bot vs bot matches run about two minutes.
- **Serve**: the first one goes to a random seat after a 3, 2, 1. After a goal the puck is served, still, on the spot in the middle of the half of whoever conceded (real air hockey).
- **The 7 second rule**: a puck that stays on one half for 7 seconds is served to the other player, with a red ring round the puck counting down from 4 s. This is the real rule, and it is what stops a leader in a paid match from sitting on the puck until the clock runs out.
- **Clock safety**: 4 minutes of play (the clock stops during goal breaks). At 0:00 the leader wins. Level at 0:00 is sudden death: one more minute where the next goal wins. Still level after it is a draw and each seat is refunded its own stake.
- **Leaving forfeits** (Knockout's rule, inherited). Leaving during the 2.5 s hold after the winning goal is settled by the score, never by who stayed.

## Netcode

- Server authoritative at 60 Hz, snapshots 30 a second, volatile (the mobile rule).
- The page runs **ahead** of the server by its one-way trip plus 2 steps and stamps every pointer sample with the step it was drawn on. The server holds an early sample until that step and applies it exactly then, so your own mallet and your own hits match the server and are almost never corrected (measured at 100 ms ping: your mallet's correction p90 under 10 units).
- Rewind and replay for the puck from every snapshot, like Head Soccer's. The other player's hand is guessed as still heading for its last target; when it was wrong the difference is eased out over 90 ms (a serve snaps).
- Each input message repeats the last 4 samples (dropped packets cost nothing) and is sent at most once a step.
- Hits, rails and posts the page predicted make their sound and flash on that frame. The other player's hits also come from the server, used only when the page did not already guess them.

## Controls

- **Mouse**: the mallet goes where the cursor is (the cursor is hidden over the table: the mallet is the cursor).
- **Finger**: touch anywhere; the mallet keeps its place above your finger (at least 62 px above it, so the finger never covers it) and follows the finger from there. The table sits under the score strip with room left below it for a thumb.
- Each player always sees their own goal at the bottom: the top seat's screen draws the table turned 180 degrees.

## Look and sound

Three looks were built (`?look=arcade`, `?look=house`, `?look=rink`): see the judge panel below for the pick. All art is drawn in code and all sounds are synthesised (dsSfx), no downloaded assets.

Hit feel: the puck flashes white, a ring and sparks burst from the contact point, the mallet lights, the screen shakes a little (up to 7 px, scaled by the hit; 40% under reduced motion), and a plastic clack plays louder and deeper the harder the hit. A goal lights the goal mouth in the scorer's colour up the table, shakes 11 px, slams GOAL with the scorer's name, and plays the drop into the slot and a buzzer.

## The bot (free tables only)

It sees the puck 130 ms late and guesses forward from that, so bank shots and quick changes fool it the way they fool a person. Its hand moves at 1500 units/s (2200 when it swings), well under a person's 2600. Puck on its half: it lines up behind the puck on a line to the goal (40% of the time a bank off a side rail) and drives through it, with a little miss in every swing. Puck coming at it: it slides to where the puck will cross its defending line, kept near the mouth. Otherwise it waits between the puck and its goal. Beatable with fast shots and banks; not dumb.

## Paid

$0.50 and $1 rungs on Knockout's money code, `AH_PAID_ON` in `server/index.js` plus the owner's door `ah:paid:off` / `ah:paid:on` (saved across restarts, like `hs:paid:off`).

## Tools

- `node scripts/ahPlay.js --two --delay 50 --secs 30` plays two headless pages against each other at about 100 ms of extra ping and reports corrections. `--phone` steers with a finger, `--look` picks a look, `--shots dir` saves screenshots.
