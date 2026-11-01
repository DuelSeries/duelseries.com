'use strict';
/* ─── npm test: every test file, each in its own process, every result kept ──────
   npm test                          every test/*.test.js
   npm test -- test/a.test.js ...    just those files
   TEST_JOBS=n                       files at once (default: CPUs - 1, as node --test)
   TEST_FILE_TIMEOUT_MS=ms           a file still running after this fails as hung (default 20 minutes)

   Why not `node --test --test-force-exit` (what npm test was until 2026-11-01):
   under --test each file runs in a child that reports to the parent through the
   v8-serializer reporter, and --test-force-exit calls process.exit() in that
   child while report events are still queued in its reporter stream. Every test
   runs, but the tail of the report is dropped: in five full runs 27 files
   reported a different number of tests each time (duelWatchPage 25, 13, 47, 30,
   66), and a failure in the dropped tail showed only as "<file> test failed",
   with no test name or message. It happens with tests that hold the event loop
   for about 100 ms or more, on Node 22.23, 24.13, 24.22 and 26.13 alike (a file
   of 60 synchronous 250 ms tests reported 30 to 55 of them).

   Here each file runs as `node --test-force-exit <file>` with NODE_TEST_CONTEXT
   set to 'child', node:test's own child mode with the TAP reporter: the same
   process per file, the same force exit (23 files keep a server or a timer alive
   after their last test and rely on it), and every result reaches this parent
   (60 of 60 in every run of that same file). NODE_TEST_CONTEXT is also what
   server/rpcDay.js reads to keep a test run's RPC day in memory, as under --test.

   Each file gets its own process group (POSIX), killed when the file ends, so a
   server a test forgot to stop does not outlive it. Exit code 1 if any file
   failed, hung, or did not report a summary. */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POSIX = process.platform !== 'win32';

const given = process.argv.slice(2).filter((a) => a !== '--');
const files = given.length ? given : fs.readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const JOBS = Math.max(1, Number(process.env.TEST_JOBS) || cpus - 1);
const TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS) || 20 * 60 * 1000;

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const live = new Set();

function summaryOf(out) {
  const s = {};
  for (const k of KEYS) {
    const m = out.match(new RegExp('^# ' + k + ' (\\d+)$', 'gm'));
    s[k] = m ? Number(m[m.length - 1].split(' ')[2]) : null;
  }
  return s;
}

function killGroup(child) {
  try {
    if (POSIX) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (_) { /* already gone */ }
}

function runFile(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test-force-exit', file], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { NODE_TEST_CONTEXT: 'child' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: POSIX,
    });
    live.add(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    let hung = false;
    const timer = setTimeout(() => { hung = true; killGroup(child); }, TIMEOUT_MS);
    // On exit, whatever the file left running in its group goes too (a server holding the output pipes would
    // otherwise keep 'close' from ever coming).
    child.on('exit', () => killGroup(child));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      const s = summaryOf(out);
      const failed = hung || code !== 0 || signal !== null || s.tests === null || s.fail > 0 || s.cancelled > 0;
      resolve({ file, failed, hung, code, signal, s, secs: (Date.now() - t0) / 1000, out, err });
    });
  });
}

// The failing tests' TAP blocks (not ok and its YAML), and the end of stderr.
function failureText(r) {
  const lines = r.out.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok /.test(lines[i])) continue;
    keep.push(lines[i]);
    for (i++; i < lines.length && !/^\s*\.\.\.$/.test(lines[i]); i++) keep.push(lines[i]);
  }
  if (r.err.trim()) keep.push('stderr (end):', ...r.err.trim().split('\n').slice(-20));
  return keep.map((l) => '    ' + l).join('\n');
}

async function main() {
  const t0 = Date.now();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const r = await runFile(files[next++]);
      results.push(r);
      const n = r.s.tests === null ? '?' : r.s.tests;
      console.log((r.failed ? 'FAIL' : 'ok  ') + ' ' + r.secs.toFixed(1).padStart(6) + 's ' + String(n).padStart(4) +
        ' tests  ' + r.file + (r.hung ? '  (hung: killed after ' + TIMEOUT_MS / 1000 + ' s)' : ''));
      if (r.failed) console.log(failureText(r));
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
  const sum = (k) => results.reduce((t, r) => t + (r.s[k] || 0), 0);
  const bad = results.filter((r) => r.failed).map((r) => r.file).sort();
  console.log('\n' + results.length + ' files, ' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed; ' +
    sum('tests') + ' tests: ' + sum('pass') + ' pass, ' + sum('fail') + ' fail, ' + sum('cancelled') + ' cancelled, ' +
    sum('skipped') + ' skipped, ' + sum('todo') + ' todo; ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  for (const f of bad) console.log('  failed: ' + f);
  process.exitCode = bad.length ? 1 : 0;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of live) killGroup(c);
    process.exit(130);
  });
}

main();
