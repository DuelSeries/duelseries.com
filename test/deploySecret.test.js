'use strict';
/* The Privy app secret reaches the box's .env on deploy (2026-11-02): on ssh's stdin to scripts/privy-env.sh, never
   in a remote command line (ssh-action's `envs` put it in /proc/<pid>/cmdline for the whole deploy: Fable review),
   only to the pinned host key, and never printed (the repo and its Actions logs are public). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const YML = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts/privy-env.sh');

test('deploy.yml: the secret goes on stdin to the pinned host, before the restart, and never via envs', () => {
  const live = YML.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/envs:\s*.*PRIVY_APP_SECRET/.test(live), 'not exported into the remote shell');
  assert.match(live, /printf '%s\\n' "\$PRIVY_APP_SECRET" \| ssh -i ~\/\.ssh\/deploy_key -o BatchMode=yes -o StrictHostKeyChecking=yes/);
  assert.match(live, /echo '16\.54\.23\.244 ssh-ed25519 AAAA[A-Za-z0-9+/=]+' > ~\/\.ssh\/known_hosts/);
  assert.match(live, /bash <\(git show origin\/main:scripts\/privy-env\.sh <\/dev\/null\)/);
  assert.ok(!/echo[^\n]*\$PRIVY_APP_SECRET/.test(live), 'never echoed');
  assert.ok(live.indexOf('Privy secret into NA .env') < live.indexOf('pm2 restart duelseries'), 'written before the restart');
  assert.match(live, /- name: Privy secret into NA \.env\s+continue-on-error: true/, 'a failure here never blocks a deploy');
});

test('privy-env.sh: never prints or passes the secret as an argument', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /IFS= read -r PRIVY_APP_SECRET/);
  assert.match(src, /ENVIRON\["PRIVY_APP_SECRET"\]/);
  assert.ok(!/(echo|printf)[^\n]*\$\{?PRIVY_APP_SECRET/.test(src), 'no echo of the value');
  assert.ok(!/awk -v/.test(src), 'not on awk\'s command line');
});

const bash = spawnSync('bash', ['-c', 'command -v awk && command -v cmp'], { encoding: 'utf8' });
test('privy-env.sh on a fake .env: one id line, one secret line, placeholder gone, 600', { skip: bash.status !== 0 && 'no bash/awk here' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privyenv-'));
  try {
    const env = path.join(dir, '.env');
    const start = 'A=1\nPRIVY_APP_ID=appX\nPRIVY_APP_SECRET=placeholder16chr\nPRIVY_APP_ID=appX\nPRIVY_APP_SECRET=privy_app_secret_OLDFAKE\nB=2\n';
    const run = (input) => spawnSync('bash', [SCRIPT], { cwd: dir, input, encoding: 'utf8' });
    fs.writeFileSync(env, start);
    let r = run('');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(env, 'utf8'), 'A=1\nPRIVY_APP_ID=appX\nPRIVY_APP_SECRET=privy_app_secret_OLDFAKE\nB=2\n', 'empty: deduped, last kept');
    r = run('not a "secret" at all\n');
    assert.match(r.stdout, /does not look like a Privy app secret; not written/);
    assert.ok(!r.stdout.includes('not a'), 'the bad value is not printed');
    r = run('privy_app_secret_NEWFAKE1234567890abcdef\n');
    assert.match(r.stdout, /Privy lines updated/);
    assert.ok(!r.stdout.includes('NEWFAKE'));
    assert.strictEqual(fs.readFileSync(env, 'utf8'), 'A=1\nPRIVY_APP_ID=appX\nPRIVY_APP_SECRET=privy_app_secret_NEWFAKE1234567890abcdef\nB=2\n');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(env).mode & 0o777, 0o600);
    assert.match(run('privy_app_secret_NEWFAKE1234567890abcdef').stdout, /unchanged/, 'no trailing newline is the same secret');
    fs.writeFileSync(env, 'A=1\n');
    run('privy_app_secret_ADDED1234567890abcdefgh\n');
    assert.strictEqual(fs.readFileSync(env, 'utf8'), 'A=1\nPRIVY_APP_SECRET=privy_app_secret_ADDED1234567890abcdefgh\n');
    fs.rmSync(env);
    assert.match(run('privy_app_secret_X1234567890abcdefghij\n').stdout, /none here/);
    assert.ok(!fs.existsSync(env), 'no .env is never made');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
