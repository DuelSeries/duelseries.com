'use strict';
// The /sl probe (task T15 tool; SERVER-BUILD-BRIEF 1.3 "Production probe: 0 undecodable bundles over 10 minutes";
// SERVER-DESIGN 14.1). ONE wanderer of scripts/slLoad.js plays on a server for --minutes and every bundle it gets goes
// through the same client model (createTracker): a wire_error, an unknown id, a food the client does not hold, a
// kind-15 or off-grid number is a failure.
//
// It plays as a player: on the live server it takes a seat in the free room and the owner gets the join push
// (C_PUSH). Run it there only with Owen's go (T19); this task ran it only against a local server.
//
// Usage: node scripts/slProbe.js --url https://example.test [--minutes 10] [--transport polling|websocket]
// Exit code 1 when a bundle failed or the probe never joined.

const { createWanderers } = require('./slLoad');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// opts: { url, minutes, ms (tests: overrides minutes), transport, now } -> Promise of the summary
function probe(opts) {
  const o = opts || {};
  const run = createWanderers({ url: o.url, clients: 1, polling: o.transport === 'websocket' ? 0 : 1, seed: 1,
    nickBase: 'Probe', now: o.now });
  run.start();
  return new Promise((resolve) => {
    setTimeout(() => {
      run.stop();
      resolve(run.summary());
    }, o.ms !== undefined ? o.ms : Math.max(1, o.minutes) * 60000);
  });
}

async function main() {
  const url = arg('url', '');
  if (!url) {
    console.error('slProbe: --url is required');
    process.exit(2);
  }
  const sum = await probe({ url, minutes: Number(arg('minutes', '10')), transport: arg('transport', 'polling') });
  console.log(JSON.stringify({ joins: sum.joins, lives: sum.lives, bundles: sum.bundles, bytes: sum.bytes,
    failures: sum.failures, fail: sum.fail, samples: sum.samples, kicks: sum.kicks, drops: sum.drops, refusals: sum.refusals,
    rttMs: sum.rttMs, gapMs: sum.gapMs }, null, 2));
  const ok = sum.failures === 0 && sum.joins > 0;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + sum.bundles + ' bundles, ' + sum.failures + ' undecodable or inconsistent');
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

if (require.main === module) main();

module.exports = { probe };
