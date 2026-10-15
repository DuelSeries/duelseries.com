'use strict';
// The battle royale room's map border (slSim opts.makeBorder): the free room's crowd border (server/sl/slBorder.js,
// every rule and number its own) that can be HELD. Between matches the arena is the free room's, its edge growing and
// shrinking with the crowd. While a match runs the edge is held where the match began, because the event's own
// circle (brZone) lives inside it and a crowd edge closing in as snakes die could cut through that circle. Released,
// it moves toward the crowd target from where it was held at the same L11.step rate, never a jump.

const { createBorder, step } = require('../sl/slBorder');

function createHeldBorder(laws, opts) {
  const inner = createBorder(laws, opts);
  let radius = inner.radius();
  let held = false;
  return {
    radius: () => radius,
    target: () => inner.target(),
    due: () => inner.due(),
    tick(nowMs, count) {
      const fired = inner.tick(nowMs, count);
      if (fired && !held) radius = step({ radius, target: inner.target() }, laws);
      return fired;
    },
    hold(on) {
      held = on === true;
    },
    held: () => held,
    stats: () => Object.assign(inner.stats(), { radius, held }),
  };
}

module.exports = { createHeldBorder };
