// Client world for the agar.io redo: the node table, the live / dying / own lists and everything a
// server message does to them. It decodes nothing and draws nothing; it takes the mirror messages
// of build brief section 6 (from agNet on the shipped page, from the harness feed in the parity
// harness) and keeps the state the renderer, the camera and the HUD read.
//
// Rules followed (spec sections):
// - protocol-semantics 2 to 8 and its traps T1 to T12 (eats do not delete, flags per record, colour
//   and name sticky, own cells show the local nickname, own = announced AND seen, spawn camera
//   x = 0, fade counted from the last update, list positions, removed ids come back as new nodes);
// - client-camera-input 4 (the 100 ms interpolation window, eat slide, removal fade, clears, spawn);
// - client-render 4.1 to 4.4 (node fields, swap-with-last list removal, interpolation snap rule,
//   one Math.random() per node creation for its membrane ring) and 11 (every f32 rounding point).
// FFA is internal mode 0 (build brief 2.22); only the mode-0 branches exist here.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};
  if (!A.agMath && typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    try { require('./agMath.js'); } catch (e) { /* the page loads agMath.js by <script> first */ }
  }

  var INTERP_MS = 100;          // fixed interpolation and fade window (client-camera-input 1)
  var SIZE_SNAP = 0.01;         // |interpolated size - target| below this shows the target (render 4.3)
  var EAT_TARGET_SIZE = 5;      // an eaten node shrinks toward radius 5 (protocol-semantics 3.2)

  function M() { return A.agMath; }
  function f32(v) { return Math.fround(v); }

  // t = clamp((now - updateTime) / 100, 0, 1), in doubles, NaN passes through like theirs.
  function stepT(now, updateTime) {
    var t = (now - updateTime) / INTERP_MS;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  // f32(t * f32(to - from) + from): the difference is a float subtraction, the rest is double maths
  // rounded once (client-camera-input 4.1).
  function lerp(t, from, to) { return f32(t * f32(to - from) + from); }
  // The size snaps when the INTERPOLATED size is within 0.01 of the target (render 4.3, trap 15).
  function snap(si, to) { return Math.abs(f32(si - to)) < SIZE_SNAP ? to : si; }

  // What drawNode and the camera do every frame: rewrite the displayed x, y, size from from/to.
  function interpolate(n, now) {
    var t = stepT(now, n.updateTime);
    n.x = lerp(t, n.fromX, n.toX);
    n.y = lerp(t, n.fromY, n.toY);
    n.size = snap(lerp(t, n.fromSize, n.toSize), n.toSize);
    return n;
  }

  // A dying node is drawn at 1 - (now - updateTime) / 100, clamped (render 6.1).
  function fadeAlpha(n, now) {
    var r = (now - n.updateTime) / INTERP_MS;
    return r < 0 ? 1 : (r > 1 ? 0 : 1 - r);
  }

  // Re-base a node at a message's receipt time with its OLD from/to/updateTime: the shown value at
  // that moment becomes both the displayed and the from value (render 4.3, trap 16). The caller has
  // already read the old targets; it then writes the new ones.
  function rebase(n, t, oldToX, oldToY, oldToSize) {
    var x = lerp(t, n.fromX, oldToX);
    var y = lerp(t, n.fromY, oldToY);
    var s = snap(lerp(t, n.fromSize, oldToSize), oldToSize);
    n.x = n.fromX = x;
    n.y = n.fromY = y;
    n.size = n.fromSize = s;
  }

  // Remove one element by swapping it with the last and popping (their list removal; it reorders).
  function swapPop(list, item) {
    var i = list.indexOf(item);
    if (i < 0) return false;
    var last = list.length - 1;
    list[i] = list[last];
    list[last] = item;
    list.pop();
    return true;
  }
  // Remove the first equal element keeping the order of the rest (the own lists erase in place).
  function eraseFirst(list, item) {
    var i = list.indexOf(item);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  function newLife() {
    return {
      spawnTime: 0, deathTime: 0, foodEaten: 0, highestMass: 0, leaderboardTime: 0,
      cellsEaten: 0, virusesEaten: 0, topPosition: 0, onBoard: false, massHistory: []
    };
  }

  function createWorld(opts) {
    opts = opts || {};
    var nodes = new Map();     // id -> node (dying nodes are not in it)
    var live = [];             // drawn after the dying list; sorted by size each frame by the renderer
    var dying = [];            // removed nodes fading out
    var own = [];              // own nodes, in promotion order
    var ownIds = [];           // ids announced by 'own' (duplicates kept, like theirs)
    var listeners = {};

    var W = {
      nick: typeof opts.nick === 'string' ? opts.nick : '',
      now: 0,                  // last client clock value: frame start or world-message receipt
      ready: false,            // first world message seen on this connection
      firstBorder: false,      // the first border of a connection moves the camera (camera-input 5.4)
      spectating: false,       // set by the session when it sends spectate; cleared at spawn
      alive: false,
      mode: 0,
      border: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      arena: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      ownColor: [0, 0, 0],
      board: [],
      life: newLife(),
      // world-message arrival statistics (mean and variance of the interval, only while alive)
      msgStats: { last: 0, mean: 0, variance: 0, count: 0 },
      cleanupArmed: true       // set at start-up, cleared by every cleanup pass

    };

    function on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return function () { off(name, fn); };
    }
    function off(name, fn) {
      var l = listeners[name];
      if (!l) return;
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
    function emit(name, payload) {
      var l = listeners[name];
      if (!l || !l.length) return;
      l = l.slice();
      for (var i = 0; i < l.length; i++) l[i](payload);
    }

    function random() {
      var r = opts.random;
      return typeof r === 'function' ? r() : Math.random();
    }

    // Names go through opts.setName(node, name) when given (the renderer's name cache keeps a
    // count of the nodes using each name); otherwise the field is just written.
    function setName(n, name) {
      if (typeof opts.setName === 'function') opts.setName(n, name);
      else n.name = name;
    }

    function inOwn(node) { return own.indexOf(node) >= 0; }
    function isOwnId(id) { return ownIds.indexOf(id) >= 0; }

    // A new node (render 4.1, protocol-semantics 3.3): from = to = displayed = packet values,
    // updateTime 0 so it shows at once at full alpha; black unless a colour came with it.
    function createNode(c) {
      var x = f32(c.x), y = f32(c.y), s = f32(c.size);
      var n = {
        id: c.id >>> 0,
        x: x, y: y, size: s,
        fromX: x, fromY: y, fromSize: s,
        toX: x, toY: y, toSize: s,
        updateTime: 0,
        lastDrawTime: 0,
        r: 0, g: 0, b: 0,
        name: '',
        accountId: 0,
        virus: false, food: false, agitated: false, ejected: false, flag40: false,
        highlight: false, friend: false,
        dying: false,
        updatable: true,
        circle: 1,             // drawn as a plain circle until the membrane step decides (render 5.2)
        textStarted: false,
        lastMassPx: -1000,     // last on-screen mass text size (render 4.1)
        maxR: 0,
        // The membrane ring starts as ONE point, and that point costs exactly one Math.random()
        // here, at creation, in record order (render 5.1). The renderer's point-count step
        // extends it by copying the last point; that is the same ring theirs builds at creation.
        points: null
      };
      n.points = [{ cid: n.id, px: x, py: y, cx: 0, sy: 0, r: s, v: f32(random() - 0.5) }];
      if (c.rgb) { n.r = c.rgb[0] & 255; n.g = c.rgb[1] & 255; n.b = c.rgb[2] & 255; }
      n.rgb = [n.r, n.g, n.b];  // the same colour as one array, the shape the renderer reads
      nodes.set(n.id, n);
      live.push(n);
      return n;
    }

    // Removal (protocol-semantics 3.6): mark dying, drop from every list and the id map (only if
    // the map still points at this node), then append to the dying list. Returns true when the
    // node was an own node.
    function unlist(n) {
      swapPop(live, n);
      swapPop(dying, n);
      if (nodes.get(n.id) === n) nodes.delete(n.id);
      if (eraseFirst(own, n)) {
        eraseFirst(ownIds, n.id);
        return true;
      }
      return false;
    }
    function removeNode(n) {
      if (n.dying) return false;
      n.dying = true;
      // Only a removal gives up the node's name (clear-all and the end of a fade do not).
      if (typeof opts.dropName === 'function') opts.dropName(n);
      var wasOwn = unlist(n);
      dying.push(n);
      emit('remove', { node: n, wasOwn: wasOwn });
      return wasOwn;
    }

    // Destroy every node at once, no fade (their clear-all and the reset on connect).
    function clearAllNodes() {
      var gone = live.concat(dying);
      live.length = 0;
      dying.length = 0;
      own.length = 0;
      ownIds.length = 0;
      nodes.clear();
      for (var i = 0; i < gone.length; i++) emit('delete', gone[i]);
    }

    // Leaderboard stats (protocol-semantics 8.3): first 'me' row at index n gives a best position
    // of n + 1, and "on the visible board" = n < 10; absent or empty counts as on the board.
    function boardStats() {
      for (var i = 0; i < W.board.length; i++) {
        if (W.board[i] && W.board[i].me) {
          var pos = i + 1;
          W.life.topPosition = W.life.topPosition ? (pos < W.life.topPosition ? pos : W.life.topPosition) : pos;
          W.life.onBoard = i < 10;
          return;
        }
      }
      W.life.onBoard = true;
    }

    function setFlags(n, c) {
      n.virus = !!c.virus;
      n.food = !!c.food;
      n.agitated = !!c.agitated;
      n.ejected = !!c.ejected;
      n.flag40 = !!c.flag40;
      n.highlight = !!c.party;
    }

    // One eat record (protocol-semantics 3.2, camera-input 4.3). Returns true when the eaten node
    // was an own node (that marks a possible death).
    function applyEat(eaterId, eatenId, now) {
      var eater = nodes.get(eaterId >>> 0), eaten = nodes.get(eatenId >>> 0);
      if (!eater || !eaten) return false;
      var eatenWasOwn = inOwn(eaten);
      if (eaten.updatable) {
        // Every input is read before anything is written (eater and eaten use their displayed
        // values as last computed: the previous frame, or a message since).
        var ex = eater.x, ey = eater.y, es = eater.size;
        var dy = f32(eaten.y - ey), dx = f32(eaten.x - ex);
        var depth = f32(es + f32(eaten.size * -0.5));
        var angle = M().atan2f(dy, dx);
        var oldToX = eaten.toX, oldToY = eaten.toY, oldToSize = eaten.toSize;
        var t = stepT(now, eaten.updateTime);
        eaten.toY = f32(Math.sin(angle) * depth + ey);
        eaten.toX = f32(Math.cos(angle) * depth + ex);
        eaten.toSize = EAT_TARGET_SIZE;
        eaten.updateTime = now;
        rebase(eaten, t, oldToX, oldToY, oldToSize);
      }
      eaten.updatable = false;

      var eaterOwn = inOwn(eater), eatenOwn = inOwn(eaten);
      // Life stats count only an own eater eating something that is not own (death screen).
      if (eaterOwn && !eatenOwn) {
        if (eaten.food || (eaten.ejected && eaten.flag40)) W.life.foodEaten++;
        else if (eaten.virus) W.life.virusesEaten++;
        else if (!eaten.ejected) W.life.cellsEaten++;
      }
      // Sound moments (their sounds are off by default and never ship; ours play at these points).
      var sound = null;
      if (!eaten.food && !eaten.virus && !eaten.ejected) {
        sound = (!eaterOwn && eatenOwn && own.length <= 1) ? 'gameOver' : 'eatCell';
      }
      emit('eat', { eater: eater, eaten: eaten, eaterOwn: eaterOwn, eatenOwn: eatenOwn, sound: sound });
      if (eaterOwn && eatenOwn) emit('merge', { eater: eater, eaten: eaten });
      if (eaten.virus) emit('virusEaten', { eater: eater, eaten: eaten });
      return eatenWasOwn;
    }

    // One node record (protocol-semantics 3.3 and 3.4).
    function applyCell(c, now) {
      var id = c.id >>> 0;
      var n = nodes.get(id);
      var created = !n;
      if (created) {
        n = createNode(c);
      } else {
        if (n.updatable) {
          var t = stepT(now, n.updateTime);
          var oldToX = n.toX, oldToY = n.toY, oldToSize = n.toSize;
          n.updateTime = now;
          n.toX = f32(c.x);
          n.toY = f32(c.y);
          n.toSize = f32(c.size);
          rebase(n, t, oldToX, oldToY, oldToSize);
        }
        if (c.rgb) { n.r = c.rgb[0] & 255; n.g = c.rgb[1] & 255; n.b = c.rgb[2] & 255; n.rgb = [n.r, n.g, n.b]; }
      }
      setFlags(n, c);
      if (created) emit('create', n);
      // A server name sticks; an empty one never clears it; own ids keep the local nickname.
      if (typeof c.name === 'string' && c.name.length > 0 && !isOwnId(id)) {
        var changed = n.name !== c.name;
        setName(n, c.name);
        emit('name', { node: n, name: c.name, own: false, changed: changed });
      }
      // Promotion: announced id + a record = own. The first own node is the spawn.
      if (isOwnId(id) && !inOwn(n)) {
        var first = own.length === 0;
        if (first) W.ownColor = [n.r, n.g, n.b];
        own.push(n);
        if (first) spawn(n, now);
      }
    }

    function spawn(n, now) {
      W.spectating = false;
      W.alive = true;
      W.life.spawnTime = now;
      W.msgStats.mean = 0;
      W.msgStats.variance = 0;
      W.msgStats.count = 0;
      W.msgStats.last = now;
      // Camera snap (trap T5): x to 0.0, NOT the cell's x; y to the cell's displayed y; scale 1.
      emit('spawn', { node: n, camX: 0, camY: n.y, drawScale: 1, now: now });
    }

    function death(now) {
      W.alive = false;
      W.life.deathTime = now;
      var L = W.life;
      var stats = {
        foodEaten: L.foodEaten, highestMass: L.highestMass, timeAlive: now - L.spawnTime,
        leaderboardTime: L.leaderboardTime, cellsEaten: L.cellsEaten, topPosition: L.topPosition,
        virusesEaten: L.virusesEaten, avgMessageInterval: W.msgStats.mean,
        sdMessageInterval: Math.sqrt(W.msgStats.variance)
      };
      // The board flags are recomputed after the stats are taken and before the board redraws.
      boardStats();
      emit('death', { now: now, stats: stats, life: L, ownColor: W.ownColor.slice() });
      // Mode 0: every per-life stat and the mass history start again from zero.
      W.life = newLife();
    }

    function applyWorld(msg, now, isSync) {
      // Arrival statistics use the clock as it was BEFORE this message (last frame or message).
      if (W.alive) {
        var S = W.msgStats;
        var interval = W.now - S.last;
        S.count++;
        var prevMean = S.mean;
        S.mean = prevMean + (interval - prevMean) / S.count;
        if (S.count > 1) {
          var dv = interval - S.mean;
          S.variance = (S.count - 1) / S.count * S.variance + 1 / (S.count - 1) * dv * dv;
        }
        S.last = W.now;
      }
      W.now = now;
      if (!W.ready) {
        W.ready = true;
        emit('ready', { now: now });
      }
      var ownGone = false;
      var i, list;
      list = msg.eats || [];
      for (i = 0; i < list.length; i++) {
        var e = list[i];
        if (e && applyEat(e[0], e[1], now)) ownGone = true;
      }
      list = msg.cells || [];
      var listed = isSync ? new Set() : null;
      for (i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c) continue;
        applyCell(c, now);
        if (listed) listed.add(c.id >>> 0);
      }
      // Own nodes always carry the local nickname (trap T3), every world message.
      for (i = 0; i < own.length; i++) {
        var on = own[i];
        var changed = on.name !== W.nick;
        setName(on, W.nick);
        emit('name', { node: on, name: W.nick, own: true, changed: changed });
      }
      list = msg.removed || [];
      for (i = 0; i < list.length; i++) {
        var n = nodes.get(list[i] >>> 0);
        if (n && removeNode(n)) ownGone = true;
      }
      if (isSync) {
        // Our resync (build brief 8): every known live node not listed counts as removed.
        var snapshot = live.slice();
        for (i = 0; i < snapshot.length; i++) {
          if (!listed.has(snapshot[i].id) && removeNode(snapshot[i])) ownGone = true;
        }
      }
      if (ownGone && own.length === 0) death(now);
    }

    function applyBorder(msg) {
      var a = +msg.minX, b = +msg.minY, c = +msg.maxX, d = +msg.maxY;
      var minX = Math.min(a, c), maxX = Math.max(a, c), minY = Math.min(b, d), maxY = Math.max(b, d);
      var withMode = msg.mode !== undefined && msg.mode !== null;
      if (withMode) {
        W.mode = msg.mode | 0;
        W.arena = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
      }
      W.border = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
      var first = !W.firstBorder;
      var payload = { border: W.border, withMode: withMode, first: first };
      if (first) {
        W.firstBorder = true;
        payload.camTargetX = (minX + maxX) * 0.5;
        payload.camTargetY = (minY + maxY) * 0.5;
        payload.noCellsZoomBase = 1;
        payload.snapCamera = own.length === 0;   // hard cut: camera = centre, draw scale 1
      }
      emit('border', payload);
    }

    function apply(msg, now) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'world': applyWorld(msg, now, false); break;
        case 'sync': applyWorld(msg, now, true); break;
        case 'own': ownIds.push(msg.id >>> 0); emit('own', { id: msg.id >>> 0 }); break;
        case 'clearOwn':
          own.length = 0;
          ownIds.length = 0;
          emit('clearOwn', {});
          break;
        case 'clearAll':
          clearAllNodes();
          emit('clearAll', {});
          break;
        case 'border': applyBorder(msg); break;
        case 'cam':
          emit('cam', { x: f32(msg.x), y: f32(msg.y), zoom: f32(msg.zoom) });
          break;
        case 'board':
          W.board = Array.isArray(msg.rows) ? msg.rows.slice() : [];
          boardStats();
          emit('board', { rows: W.board });
          break;
        case 'hello': emit('hello', msg); break;
        default: break;
      }
    }

    // Free dying nodes whose fade is over (render 4.4). It clears the "cleanup armed" flag first.
    // Who calls it, as theirs (agMain owns the schedule): the end of every drawn frame runs
    // cleanupIfPending(now) then armCleanup(); the once-a-second tick does the same with the world
    // clock; the idle step runs cleanupIfPending(world clock) after interpolateAll().
    function cleanup(now) {
      var k, n;
      W.cleanupArmed = false;
      for (k = 0; k < live.length; k++) {
        n = live[k];
        if (n.dying && stepT(now, n.updateTime) >= 1) { unlist(n); emit('delete', n); k--; }
      }
      for (k = 0; k < dying.length; k++) {
        n = dying[k];
        if (n.dying && stepT(now, n.updateTime) >= 1) { unlist(n); emit('delete', n); k--; }
      }
    }
    function cleanupIfPending(now) { if (W.cleanupArmed) cleanup(now === undefined ? W.now : now); }
    function armCleanup() { W.cleanupArmed = true; }

    // Re-interpolate every node, dying list first, at the world clock (the idle step's job: it
    // refreshes the displayed values between frames, so a message's own clock moves them too).
    function interpolateAll(now) {
      var t = now === undefined ? W.now : now, i;
      for (i = 0; i < dying.length; i++) interpolate(dying[i], t);
      for (i = 0; i < live.length; i++) interpolate(live[i], t);
    }

    // Reconnect: everything goes, the next border is "first" again, spawn waits for a world message.
    function reset() {
      clearAllNodes();
      W.ready = false;
      W.firstBorder = false;
      W.spectating = false;
      W.alive = false;
      W.border = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      W.board = [];
      W.life = newLife();
      W.cleanupArmed = true;
      emit('reset', {});
    }

    function debugLists() {
      function row(n) { return [n.x, n.y, n.size, n.toX, n.toY, n.toSize]; }
      return { listA: live.map(row), listB: dying.map(row) };
    }

    return {
      apply: apply,
      cleanup: cleanup,
      cleanupIfPending: cleanupIfPending,
      armCleanup: armCleanup,
      interpolateAll: interpolateAll,
      reset: reset,
      on: on,
      off: off,
      interpolate: interpolate,
      fadeAlpha: fadeAlpha,
      setNow: function (now) { W.now = now; },
      setNick: function (nick) { W.nick = typeof nick === 'string' ? nick : ''; },
      setSpectating: function (v) { W.spectating = !!v; },
      node: function (id) { return nodes.get(id >>> 0) || null; },
      // The real arrays. main / fading / ownCells / border are the same lists under the names
      // the renderer reads.
      lists: function () {
        return { live: live, dying: dying, own: own, ownIds: ownIds,
          main: live, fading: dying, ownCells: own, border: W.border };
      },
      debugLists: debugLists,
      state: function () { return W; }
    };
  }

  var agWorld = {
    INTERP_MS: INTERP_MS,
    SIZE_SNAP: SIZE_SNAP,
    EAT_TARGET_SIZE: EAT_TARGET_SIZE,
    createWorld: createWorld,
    interpolate: interpolate,
    fadeAlpha: fadeAlpha,
    stepT: stepT
  };
  A.agWorld = agWorld;
  if (typeof module !== 'undefined' && module.exports) module.exports = agWorld;
})(typeof window !== 'undefined' ? window : globalThis);
