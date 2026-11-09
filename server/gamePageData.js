'use strict';
/* The words on each game's own page (/games/<page>, server/gamePages.js), 2026-11-01.

   One entry per game in the lobby that is built and playable. A game that is locked (shared/lockedGames.js) or
   Coming soon (server/comingSoon.js, today agar.io and Battleship) keeps its entry but has no page, no list card and
   no sitemap line until it is live again: that is a runtime switch, so its page comes back with the switch.

   page    the address, /games/<page>: our own name for it (as name), lower case and hyphens. An old address is
           in MOVED (a 301).
   share   its shared/shareGames.js slug: Play goes to /play/<share>, and its 1200 x 630 picture is the link preview.
   name    our own name for it: the h1, the title, the link preview and the JSON-LD name. The lobby card's name
           (public/v2.html GAMES, shared/chompName.js, SwimSim.NAME) where that is ours, else a plain word like
           shared/shareGames.js uses.
   like    the other publisher's game it plays like, when the lobby card is named after one: the lede says
           "like <like>", and that is the only place the page names it.
   kind    'arena' (a room you drop into, KIND.arena) or 'duel' (a 1v1 you are matched into, KIND.duel).
   title   the page's title, before " | DuelSeries"; description  the search result's words (and the link preview's).

   The rules for these words (test/gamePages.test.js holds them):
   - Honest. Every rule here was read from the game's code that day (controls, timers, scores); no promise of
     winning or of money, and the paid paragraph says what a player can lose.
   - title and description never mention money (they leave the site in search results and link previews, the same
     rule as shareGames.js); the money is on the page, in KIND, under Play for money.
   - Safe names (Owen, 2026-11-01): the title, description, link preview and JSON-LD carry our own name only,
     the rule shared/shareGames.js and shared/chompName.js keep for shared links. Another publisher's game is named
     in the body alone, as "like X", and every page's footer says the site is not affiliated with them (DISCLAIMER).
   - Plain words: no em dashes, no hype. */

const SHARE = require('../shared/shareGames');
const CHOMP_NAME = require('../shared/chompName');
const CROSSY_BEHIND = require('../shared/crossySim').DUEL.BEHIND_LOSE;   // rows behind that lose a Crossy duel (the how-to-play says it)

const PAGES = Object.freeze([
  {
    page: 'chomp', share: 'chomp', name: 'Chomp', like: CHOMP_NAME, kind: 'arena',
    title: 'Chomp: Multiplayer Maze Game, Play Free Online',
    description: 'Play a multiplayer maze game free in your browser. Eat the dots, dodge the ghosts, and grab a power pellet to turn the tables on everyone. No download.',
    short: 'Eat the dots, dodge the ghosts, hunt other players.',
    lede: 'A maze like ' + CHOMP_NAME + ' that you share with other players. Eat the dots, stay clear of the ghosts, and grab a power pellet to hunt them, and anyone near you, for a few seconds.',
    about: [
      'Everyone runs the same maze at once, and its edges wrap around. You get one life: a ghost that catches you ends the run. A power pellet turns the ghosts blue for you alone for six seconds, speeds you up, and lets you eat ghosts and other players. A cherry gives a short burst of speed.',
      'Computer players keep the maze busy when it is quiet, and one room holds up to 100 players.',
    ],
    how: [
      ['Move', 'Arrow keys or WASD on a computer. On a phone, drag anywhere to steer; lift your thumb and you keep running the same way.'],
      ['Eat', 'Clear the dots as you go, and pick up cherries for a burst of speed.'],
      ['Turn the tables', 'Grab a power pellet: for six seconds the ghosts turn blue for you, and you can eat them and other players.'],
      ['Stay alive', 'You have one life, so watch the corners: a ghost or a powered-up player that catches you ends the run.'],
    ],
    genre: ['Arcade', 'Maze', 'Multiplayer'],
  },
  {
    page: 'snake', share: 'snake', name: 'Snake', like: 'Slither.io', kind: 'arena',
    title: 'Snake: Multiplayer Snake Game, Play Free Online',
    description: 'Play a multiplayer snake game free in your browser. Eat to grow, boost past rivals, and cut other snakes off before they cut you off. Phone and PC, no download.',
    short: 'Grow, boost, and cut other snakes off.',
    lede: 'A snake arena like Slither.io: eat to grow, boost to get ahead, and make the other snakes run into you.',
    about: [
      'Every snake shares one big arena. Run into another snake\'s body or the border and you are out, and everything you grew drops as food for whoever is close. Boosting makes you faster but sheds a little length, so pick your moments.',
      'The free arena is always running, with computer snakes in it, so there is a game the moment you press Play.',
    ],
    how: [
      ['Steer', 'Move the mouse and your snake follows it. The Left and Right arrows turn too. On a phone, use the thumb stick.'],
      ['Boost', 'Hold a mouse button, Space or the Up arrow. On a phone, hold a second finger down, or double tap and hold.'],
      ['Grow', 'Eat the glowing food, and the trail a crashed snake leaves behind.'],
      ['Cut them off', 'Put your body in front of another snake\'s head. If it hits you, it is out.'],
    ],
    genre: ['Arcade', 'IO game', 'Snake', 'Multiplayer'],
  },
  {
    page: 'cells', share: 'cells', name: 'Cells', like: 'Agar.io', kind: 'arena',
    title: 'Cells: Multiplayer Cell Game, Play Free Online',
    description: 'Play a multiplayer cell game free in your browser. Eat anything smaller than you, split to chase, and stay clear of anything bigger. Phone and PC, no download.',
    short: 'Eat smaller cells, split to chase.',
    lede: 'A cell game like Agar.io. Start small, eat whatever is smaller than you, and stay out of reach of whatever is bigger.',
    about: [
      'A cell can eat another that is clearly smaller than it. Split to lunge at a smaller cell, eject mass to feed or bait, and keep away from the viruses once you are big. Split pieces merge back together after about thirty seconds.',
      'Your run ends when your last cell is eaten. The free room has computer cells in it, some hunting and some shy.',
    ],
    how: [
      ['Steer', 'Move the mouse. On a phone, use the thumb stick.'],
      ['Split', 'Space, or the Split button, throws half of you forward to catch a smaller cell.'],
      ['Eject', 'W, or the Eject button, shoots out a little mass.'],
      ['Survive', 'Anything noticeably bigger than you can eat you, so keep an eye on the edges of the screen.'],
    ],
    genre: ['Arcade', 'IO game', 'Multiplayer'],
  },
  {
    page: 'paper', share: 'paper', name: 'Paper', like: 'Paper.io', kind: 'arena',
    title: 'Paper: Multiplayer Territory Game, Play Free Online',
    description: 'Play a multiplayer territory game free in your browser. Leave your zone, draw a loop, and get home to claim the ground before anyone crosses your trail. No download.',
    short: 'Draw a loop, get home, claim the ground.',
    lede: 'A territory game like Paper.io. Take the map one loop at a time. Leave your zone, draw a line, and make it home before anyone cuts your trail.',
    about: [
      'Outside your own ground you leave a trail behind you. Close the loop back in your zone and everything inside it becomes yours. If another player crosses your trail first you are out, and the same goes for hitting the wall, crossing your own trail or being surrounded.',
      'The arena grows a little as players join and shrinks slowly as they leave. The free arena fills up with computer players when it is quiet.',
    ],
    how: [
      ['Move', 'Arrow keys or WASD, or point with the mouse. On a phone, use the thumb stick.'],
      ['Draw', 'Head out of your zone and your trail follows you.'],
      ['Claim', 'Get back into your own ground to fill in the loop.'],
      ['Cut', 'Cross another player\'s trail while they are out to knock them out, and keep your own loops short when anyone is near.'],
    ],
    genre: ['Arcade', 'IO game', 'Multiplayer'],
  },
  {
    page: 'head-soccer', share: 'headsoccer', name: 'Head Soccer', kind: 'duel',
    title: 'Head Soccer: 1v1 Football Game, Play Free Online',
    description: 'Play a 1v1 head soccer game free in your browser. Jump, kick and head the ball into the other goal in a two minute match. Phone and PC, no download.',
    short: 'One on one football with oversized heads.',
    lede: 'One on one, oversized heads, and a ball that rarely goes where you meant it to.',
    about: [
      'A match lasts two minutes, and whoever has scored more at the whistle takes it. Level at full time means golden goal: the next goal decides it, for up to a minute, and still level after that is a draw. Every kick-off starts with a three second countdown.',
    ],
    how: [
      ['Move', 'A and D, or the Left and Right arrows. On a phone, the Left and Right buttons.'],
      ['Jump', 'W or the Up arrow, or the Jump button. Head the ball while it is in the air.'],
      ['Kick', 'Space or K, or the Kick button, when the ball is at your feet.'],
      ['Score more', 'The most goals after two minutes takes the match.'],
    ],
    genre: ['Sports', 'Football', 'Soccer'],
  },
  {
    page: 'swim', share: 'swim', name: 'Swim', kind: 'duel',
    title: 'Swim: 1v1 Traffic Racing Game, Play Free Online',
    description: 'Play Swim, a 1v1 traffic racing game, free in your browser. Weave through endless traffic: touch a car or fall 200 m behind and you lose. Phone and PC, no download.',
    short: 'A 1v1 race through endless traffic.',
    lede: 'A 1v1 race down the same endless highway. Touch a car, or fall 200 m behind, and you lose.',
    about: [
      'You both drive the same road at the same time and pass straight through each other, so it is each of you against the traffic. The road keeps getting faster and busier. The first to touch a traffic car loses, and so does anyone who falls 200 metres behind. Crashing at the same moment is a draw.',
    ],
    how: [
      ['Speed up', 'W or the Up arrow. On a phone, hold Gas.'],
      ['Brake', 'S or the Down arrow. On a phone, hold Brake.'],
      ['Steer', 'A and D, or the Left and Right arrows. On a phone, drag on the left side of the screen.'],
      ['Keep up', 'Stay close to your rival without touching a single car.'],
    ],
    genre: ['Racing', 'Arcade'],
  },
  {
    page: '8-ball-pool', share: 'pool', name: '8 Ball Pool', kind: 'duel',
    title: '8 Ball Pool Online: 1v1 Pool Game, Play Free',
    description: 'Play 8 ball pool online free in your browser. Pot your group, call your pocket, and sink the eight before your opponent does. 1v1 on phone and PC, no download.',
    short: 'Call your pocket and sink the eight first.',
    lede: 'Break, pot your group, call your pocket, and sink the eight before they do.',
    about: [
      'One rack of eight ball, taking turns. Pot all of your group, solids or stripes, then the eight in the pocket you called. Potting the eight early, in the wrong pocket or with a foul loses the rack, and a foul gives your opponent ball in hand anywhere on the table.',
      'Every shot has a 25 second clock, and a third timeout loses the match.',
    ],
    how: [
      ['Aim', 'The cue follows the mouse, and the wheel or arrow keys fine-tune it. On a phone, drag on the table or tap a ball to aim at it.'],
      ['Shoot', 'Press, pull back and let go: how far you pull sets the power. On a phone, pull down the power bar on the left.'],
      ['Spin', 'Use the cue ball button to put spin on a shot.'],
      ['Call the eight', 'With only the eight left, tap the pocket you are aiming for, then sink it.'],
    ],
    genre: ['Sports', 'Billiards', 'Pool'],
  },
  {
    page: 'air-hockey', share: 'airhockey', name: 'Air Hockey', kind: 'duel',
    title: 'Air Hockey Online: 1v1 Game, Play Free in Your Browser',
    description: 'Play air hockey online free in your browser. One puck, two mallets, and first to seven goals takes the 1v1 match. Phone and PC, no download.',
    short: 'One puck, two mallets, first to seven.',
    lede: 'One puck, two mallets, and a goal at each end. First to seven.',
    about: [
      'First to seven goals takes the match, or whoever leads after four minutes. Level at that point means a minute of sudden death, then a draw. Your mallet stays on your half, a puck kept on one side for seven seconds goes to the other player, and after a goal the puck is served to whoever let it in.',
    ],
    how: [
      ['Move', 'Your mallet follows the mouse. On a phone, drag anywhere and it sits just above your finger.'],
      ['Strike', 'Hit the puck square for speed, or off the side walls for an angle.'],
      ['Defend', 'Get back in front of your goal after every shot.'],
      ['Score seven', 'The first to seven goals takes it.'],
    ],
    genre: ['Sports', 'Arcade'],
  },
  {
    page: 'knockout', share: 'knockout', name: 'Knockout', kind: 'duel',
    title: 'Knockout: 1v1 Strategy Game, Play Free Online',
    description: 'Play Knockout free in your browser: a 1v1 game of two pieces each on a shrinking disc. Aim both, lock in, and see whose read was right. Phone and PC, no download.',
    short: 'Two pieces each on a shrinking disc.',
    lede: 'Two pieces each on a shrinking disc. Aim both, commit blind, and find out together whose read was right.',
    about: [
      'Each turn you have 15 seconds to aim both of your pieces. Neither of you sees the other\'s moves until both lock in, then every piece launches at once. A piece that slides off the edge is gone, and the disc gets smaller every turn. Lose both pieces and you lose; if the last pieces on both sides fall together, it is a draw.',
    ],
    how: [
      ['Aim', 'Press one of your pieces and drag out an arrow: its direction is where the piece goes and its length is how hard.'],
      ['Aim the other', 'Do the same with your second piece.'],
      ['Lock in', 'Press Lock in. Once you both have, every piece moves at once.'],
      ['Stay on', 'Knock their pieces off the edge and keep yours on as the disc shrinks.'],
    ],
    genre: ['Strategy', 'Physics'],
  },
  {
    page: 'battleship', share: 'battleship', name: 'Battleship', kind: 'duel',
    title: 'Battleship Online: 1v1 Game, Play Free in Your Browser',
    description: 'Play Battleship online free in your browser. Hide your fleet, then find theirs first, one shot a turn in a 1v1 match. Phone and PC, no download.',
    short: 'Hide your fleet, find theirs first.',
    lede: 'Hide your fleet, then find theirs before they find yours.',
    about: [
      'Two 10 by 10 grids and five ships each, 17 squares in all. You get a minute to place your fleet, then you take turns firing one shot each, hit or miss, with ten seconds a shot. Sink the whole fleet first to take the match.',
    ],
    how: [
      ['Place', 'Drag your ships onto your grid. Tap a ship or press R to turn it, or press Auto.'],
      ['Confirm', 'Press Confirm when your fleet is set.'],
      ['Fire', 'Tap or click a square on their grid. One shot a turn.'],
      ['Sink them all', 'Follow up your hits. The first to sink the whole fleet takes the match.'],
    ],
    genre: ['Strategy', 'Board game'],
  },
  {
    page: 'rooftop-duel', share: 'rooftop', name: 'Rooftop Duel', like: 'Rooftop Snipers', kind: 'duel',
    title: 'Rooftop Duel: 1v1 Sniper Game, Play Free Online',
    description: 'Play a 1v1 rooftop sniper game free in your browser. Jump, aim and fire to knock the other sniper off the roof. First to five. Phone and PC, no download.',
    short: 'Two snipers on one wobbly roof.',
    lede: 'A 1v1 like Rooftop Snipers: two snipers on one wobbly roof. Knock the other one off five times first.',
    about: [
      'Both snipers wobble on their feet. Hold to raise your gun and let go to fire; a hit shoves the other sniper back, and whoever falls off the roof loses the round. First to five rounds takes the match. Later rounds can change the roof, the weapons and the weather, or drop things from the sky.',
    ],
    how: [
      ['Jump', 'W, or the Jump button on a phone.'],
      ['Aim', 'Hold E, or the Shoot button: your gun rises while you hold it.'],
      ['Fire', 'Let go to shoot.'],
      ['Stay on the roof', 'Five falls and you are out, so keep your balance.'],
    ],
    genre: ['Action', 'Shooter', 'Physics'],
  },
  {
    page: 'road-hop', share: 'crossy', name: 'Road Hop', like: 'Crossy Road', kind: 'duel',
    title: 'Road Hop: 1v1 Road Crossing Race, Play Free Online',
    description: 'Play a 1v1 road crossing race free in your browser. Hop the same roads, rivers and rails as your rival; the first one hit loses. Phone and PC, no download.',
    short: 'Hop the same roads as your rival.',
    lede: 'A 1v1 race like Crossy Road. Hop the same roads, rivers and rails as your rival. Get hit or fall too far behind and you lose.',
    about: [
      'You both hop the same map at the same time. Getting hit, falling in the river or riding a log off the edge loses the race, and so does falling ' + CROSSY_BEHIND + ' rows behind your rival. The camera follows you and nothing chases you: the only clock is the other player. If you both go out at once, the coins you picked up decide it, and after five minutes whoever is further ahead takes it.',
    ],
    how: [
      ['Hop', 'Arrow keys or WASD: you hop when you let go of the key. Space or a click hops forward.'],
      ['On a phone', 'Tap to hop forward, swipe to hop any way.'],
      ['Time it', 'Wait for a gap in the cars, ride the logs, and watch for the train warning.'],
      ['Keep up', 'Fall ' + CROSSY_BEHIND + ' rows behind your rival and you lose. The gap shows next to their score and turns red as it gets close.'],
    ],
    genre: ['Arcade', 'Racing'],
  },
].map((p) => {
  const share = SHARE.bySlug(p.share);
  if (!share) throw new Error('gamePageData: no shareGames entry ' + p.share);
  return Object.freeze(Object.assign({}, p, { game: share.game, about: Object.freeze(p.about.slice()),
    how: Object.freeze(p.how.map((s) => Object.freeze(s.slice()))), genre: Object.freeze(p.genre.slice()) }));
}));

/* What each kind of game says under Free or for money. The paid words were checked against the code and the terms
   that day: fixed $0.50 and $1.00 buy-ins, paid in SOL from the player's own wallet, a 10% house fee (90% of worth on
   a cash-out; a duel's pot less 10%, server/duelMoney.js), a duel refunded on a draw or a Cancel while nobody has
   taken the table (shared/duelWait.js), a paid duel never against a bot, a free one against a labelled bot after
   ten seconds, and 21 as the minimum age (public/terms.html). */
const KIND = Object.freeze({
  arena: Object.freeze({
    facts: 'Multiplayer arena · Free in your browser · Phone and PC · No download',
    paidTag: '$0.50 / $1 rooms, 21+',
    free: 'Free rooms cost nothing and pay nothing, and need no sign-up: press Play and you are in as a guest.',
    paid: 'Paid rooms take a $0.50 or $1.00 buy-in, paid in SOL from your own wallet and shown in dollars. Hold Q, or the cash out button on a phone, for three seconds to cash out: 90% of what you hold goes to your wallet and 10% is the house fee. Knocked out first, you lose what you held, buy-in included. Rooms can include computer players run by the site. Only for players 21 and over, where playing skill games for money is legal.',
  }),
  duel: Object.freeze({
    facts: '1v1 duel · Free in your browser · Phone and PC · No download',
    paidTag: '$0.50 / $1 duels, 21+',
    free: 'Free games cost nothing and pay nothing, and need no sign-up. You wait up to ten seconds for another player, then play a computer player that is labelled as one.',
    paid: 'Paid duels are $0.50 or $1.00 a side, paid in SOL from your own wallet and shown in dollars. The winner gets both buy-ins less a 10% house fee ($1.80 from a $1 duel), and the loser loses their buy-in. A draw gives both back, and so does Cancel while nobody has taken your table. Only for players 21 and over, where playing skill games for money is legal.',
  }),
});

const INDEX = Object.freeze({
  title: 'Free Multiplayer Browser Games',
  h1: 'Free multiplayer games in your browser',
  description: 'Snake, maze and territory arenas, plus 1v1 games like 8 ball pool, air hockey and head soccer. Free in your browser on phone and PC, no download.',
  lede: 'Arenas you drop into and 1v1 games you are matched into, all free in your browser on a phone or a computer. Players 21 and over can also play for money where that is legal.',
});

const DISCLAIMER = 'Where a game is said to be like another game, that name belongs to its owner. DuelSeries is independent and is not affiliated with or endorsed by the owners of those names.';

/* The first addresses, named after other publishers' games (2026-11-01, live for an afternoon): each is a 301 to
   our own (server/gamePages.js), so a link or a search result already out there still lands. Never reused. */
const MOVED = Object.freeze({
  'pac-man': 'chomp', 'slither-io': 'snake', 'agar-io': 'cells', 'paper-io': 'paper',
  'rooftop-snipers': 'rooftop-duel', 'crossy-road': 'road-hop',
});

const byPage = (page) => PAGES.find((p) => p.page === page) || null;
const byShare = (slug) => PAGES.find((p) => p.share === slug) || null;

module.exports = { PAGES, KIND, INDEX, DISCLAIMER, MOVED, byPage, byShare };
