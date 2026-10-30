'use strict';
/* scripts/sl-split.sh's paid-seat guard (server split spec 13), run by bash in a temp app directory with a stub pm2 and
   a stub curl (no real server, no network, no pm2):

   - /api/live does not answer (curl fails): the guard refuses with its own FAILED line and the --force hint, where
     set -e used to end the script silently with curl's code
   - /api/live answers but cannot read a game that holds money (unknown 'all', 'slpaid'): refused, never "nobody seated"
   - unknown 'sl' and 'br' only (a slither process that is not reporting; they hold no money): off still goes
   - a paid seat refuses with its count; --force goes anyway

   Skipped where no bash is found (on Windows only Git for Windows' bash is used, never another one on PATH). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'sl-split.sh');
const posix = (p) => p.replace(/\\/g, '/');

function findBash() {
  const list = process.platform === 'win32'
    ? [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
      .map((d) => path.join(d, 'Git', 'bin', 'bash.exe')).filter((b) => fs.existsSync(b))
    : ['bash'];
  for (const b of list) {
    const r = spawnSync(b, ['-c', 'echo ok'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && String(r.stdout).trim() === 'ok') return b;
  }
  return null;
}
const BASH = findBash();

const CURL = `#!/usr/bin/env bash
case "$*" in
  *api/live*)
    n=$(cat "$STUB/count" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > "$STUB/count"
    f="$STUB/live.$n"
    [ -f "$f" ] || f="$STUB/live"
    body=$(cat "$f")
    if [ "$body" = "EXIT7" ]; then exit 7; fi
    printf '%s' "$body" ;;
  *-D*) printf 'HTTP/1.1 200 OK\\r\\nx-ds-proc: main\\r\\n\\r\\n' ;;
  *) printf '0{"sid":"abc","upgrades":[]}' ;;
esac
`;
const PM2 = `#!/usr/bin/env bash
if [ "$1" = "jlist" ]; then printf '%s' '[{"name":"duelseries","pid":111,"pm2_env":{"env":{}}}]'; exit 0; fi
printf '%s\\n' "pm2 $*" >> "$STUB/pm2.log"
exit 0
`;
const CLEAN = '{"lobbies":[{"stake":0,"players":2}],"stakes":[0,0.5,1],"extras":[],"br":null,"counts":null}';

// A temp app directory (server/index.js, .env with the split on), the stubs, and the /api/live answers in order
// (then CLEAN for every later one). 'EXIT7' makes that answer a refused connection.
function rig(answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slsplit-sh-'));
  const app = path.join(dir, 'app');
  const bin = path.join(dir, 'bin');
  const stub = path.join(dir, 'stub');
  for (const d of [path.join(app, 'server'), bin, stub]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(app, 'server', 'index.js'), '// stub\n');
  fs.writeFileSync(path.join(app, '.env'), 'PORT=3000\nREGION=na\nSL_SPLIT=1\n');
  // as the box has it (LF), whatever this checkout's line endings
  fs.writeFileSync(path.join(app, 'sl-split.sh'), fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(bin, 'curl'), CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pm2'), PM2, { mode: 0o755 });
  answers.forEach((a, i) => fs.writeFileSync(path.join(stub, 'live.' + (i + 1)), a));
  fs.writeFileSync(path.join(stub, 'live'), CLEAN);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^sl_split_public$/i.test(k)) env[k] = v;
  env.STUB = posix(stub);
  env.STUB_BIN = posix(bin);
  // the stubs go first on PATH inside bash (Git for Windows' bash puts its own directories first at start)
  const inBash = 'export PATH="$(cygpath -u "$STUB_BIN" 2>/dev/null || printf %s "$STUB_BIN"):$PATH"; exec bash sl-split.sh "$@"';
  const run = (...args) => {
    const r = spawnSync(BASH, ['-c', inBash, 'sl-split', ...args], { cwd: app, env, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  const restarts = () => {
    const f = path.join(stub, 'pm2.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^pm2 restart /.test(l)) : [];
  };
  const envFile = () => fs.readFileSync(path.join(app, '.env'), 'utf8');
  return { run, restarts, envFile };
}

test('sl-split.sh: /api/live not answering is "cannot tell": FAILED with the --force hint, no restart', { skip: !BASH && 'no bash' }, () => {
  const r = rig(['EXIT7']);
  const x = r.run('off');
  assert.strictEqual(x.status, 1, x.out);
  assert.match(x.out, /^FAILED drain: \/api\/live did not answer on 127\.0\.0\.1:3000 \(pass --force to go anyway\)$/m);
  assert.deepStrictEqual(r.restarts(), []);
  assert.match(r.envFile(), /^SL_SPLIT=1$/m, 'the switch is untouched');
});

test('sl-split.sh: a game /api/live could not read is never "nobody seated"; sl and br alone do not block off', { skip: !BASH && 'no bash' }, () => {
  const all = rig(['{"lobbies":[],"stakes":[0,0.5,1],"extras":[],"br":null,"counts":null,"unknown":["all"]}']);
  let x = all.run('off');
  assert.strictEqual(x.status, 1, x.out);
  assert.match(x.out, /^FAILED drain: \/api\/live could not read all, so it cannot tell whether paid seats are in play \(pass --force to go anyway\)$/m);
  assert.deepStrictEqual(all.restarts(), []);
  const paid = rig(['{"lobbies":[{"stake":0,"players":2}],"unknown":["sl","slpaid"]}']);
  x = paid.run('off');
  assert.strictEqual(x.status, 1, x.out);
  assert.match(x.out, /could not read slpaid,/);
  assert.deepStrictEqual(paid.restarts(), []);
  // what a slither process that is not reporting says: the rollback goes
  const stale = rig(['{"lobbies":[{"stake":0,"players":2}],"unknown":["sl","br"]}']);
  x = stale.run('off');
  assert.strictEqual(x.status, 0, x.out);
  assert.match(x.out, /^OK off$/m);
  assert.deepStrictEqual(stale.restarts(), ['pm2 restart duelseries']);
  assert.match(stale.envFile(), /^SL_SPLIT=0$/m);
});

test('sl-split.sh: a paid seat refuses with its count; --force goes even when /api/live does not answer', { skip: !BASH && 'no bash' }, () => {
  const seated = rig(['{"lobbies":[{"stake":0,"players":4},{"stake":0.5,"players":1,"parked":1}]}']);
  let x = seated.run('off');
  assert.strictEqual(x.status, 1, x.out);
  assert.match(x.out, /^FAILED drain: 2 paid seat\(s\) in play; wait for them or pass --force$/m);
  assert.deepStrictEqual(seated.restarts(), []);
  const forced = rig(['EXIT7']);
  x = forced.run('off', '--force');
  assert.strictEqual(x.status, 0, x.out);
  assert.match(x.out, /^OK off$/m);
  assert.deepStrictEqual(forced.restarts(), ['pm2 restart duelseries']);
});
