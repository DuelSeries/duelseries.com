'use strict';
/* Pac-Man lab server (branch chomp-rethink only): node scripts/chomp-lab.js   then open http://localhost:3004/lab/

   A tiny static server for the Pac-Man prototypes in lab/chomp/. It is NOT the game server: no sockets, no money,
   no database, nothing from server/ is loaded. The prototypes run their sim in the page with bots so Owen can feel
   each idea; whichever he picks gets built into the real, server-authoritative game later.

   Serves /lab/* from lab/chomp/, and only the read-only browser files the prototypes reuse from the real game:
   /shared/chomp*.js (rules, maze, movement, wall tracer), /js/chomp/chompPixel.js + chompSound.js (the arcade
   renderer and synthesized sounds), /js/dsSfx.js (the sound engine). Refuses NODE_ENV=production. */
const path = require('path');
const express = require('express');

if (process.env.NODE_ENV === 'production') {
  console.error('[chomp-lab] refusing to run with NODE_ENV=production');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const PORT = +(process.env.CHOMP_LAB_PORT || 3004);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const SHARED = ['chompRules.js', 'chompMaze.js', 'chompMove.js', 'chompWalls.js'];
SHARED.forEach(f => app.get('/shared/' + f, (req, res) => res.sendFile(path.join(ROOT, 'shared', f))));
['chompPixel.js', 'chompSound.js'].forEach(f => app.get('/js/chomp/' + f, (req, res) => res.sendFile(path.join(ROOT, 'public', 'js', 'chomp', f))));
app.get('/js/dsSfx.js', (req, res) => res.sendFile(path.join(ROOT, 'public', 'js', 'dsSfx.js')));
app.get('/img/favicon-32.png', (req, res) => res.sendFile(path.join(ROOT, 'public', 'img', 'favicon-32.png')));
app.use('/lab', express.static(path.join(ROOT, 'lab', 'chomp'), { index: 'index.html' }));
app.get('/', (req, res) => res.redirect('/lab/'));

app.listen(PORT, '127.0.0.1', () => console.log('[chomp-lab] http://localhost:' + PORT + '/lab/'));
