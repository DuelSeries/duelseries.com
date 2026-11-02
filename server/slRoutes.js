'use strict';
/* Who may get public/sl.html, the new slither.io client (task T-1 of the slither.io server design, section 13
   item 2). server/index.js installs these routes BEFORE express.static, so the static file is never handed out
   while the game is closed.

   SL_ENABLED  OFF BY DEFAULT. 1, true, on, yes: on. Unset, empty, 0, false, off, no: off. Anything else is not a
               switch value: it says so and fails CLOSED (off). This is agar's agSwitch (server/ag/agBoot.js) with
               the default flipped: the server for this page does not exist yet, so Play could never connect.

   Closed: /sl and the file's own name answer CLOSED_PAGE, 503 (what /ag answers while closed), never stored.
   Open:   /sl serves the file; the file's own name sends the browser to /sl, so the page lives at one address
           (the /ag.html pattern).

   The file's own name is matched by what express.static would resolve, not by one exact path. serve-static
   decodes and normalizes the path before it looks on disk, so /./sl.html, //sl.html, /x/../sl.html and
   /sl%2Ehtml all reach the file; an exact app.get('/sl.html') would miss every one of them. */

const path = require('path');

function slSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '' || v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  (log || console).error('[SL] SL_ENABLED=' + JSON.stringify(String(raw).slice(0, 20)) +
    ' is not a switch value; slither.io stays OFF (fails closed)');
  return false;
}

/* True when express.static at the site root would resolve this request path to public/sl.html. Lower-cased
   because a case-insensitive disk (Windows) serves /SL.HTML too; backslashes count as separators for the same
   reason. A path that does not decode is refused by serve-static itself (400), so it is not the file. */
function isSlFile(pathname) {
  let p;
  try { p = decodeURIComponent(String(pathname == null ? '' : pathname)); } catch (_) { return false; }
  p = path.posix.normalize('/' + p.replace(/\\/g, '/')).replace(/\/+$/, '');
  return p.toLowerCase() === '/sl.html';
}

/* Self-contained: no stylesheet, script or image from the site, so it renders whatever else is down. The back
   control is a real link to the lobby (target _top, so it never loads the lobby inside a frame); inside the
   lobby's frame it sends game:done instead, the message every game page sends to close itself. */
const CLOSED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>slither.io - DuelSeries</title></head>'
  + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;'
  + 'box-sizing:border-box;background:#000;color:#f4f1ea;font:16px/1.5 Archivo,\'Segoe UI\',system-ui,sans-serif;'
  + 'text-align:center;-webkit-font-smoothing:antialiased">'
  + '<div><p style="margin:0 0 20px;font-size:19px;font-weight:600">slither.io is not open yet.</p>'
  + '<a id="back" href="/" target="_top" style="display:inline-flex;align-items:center;justify-content:center;'
  + 'min-height:52px;min-width:200px;box-sizing:border-box;font:700 16px Archivo,\'Segoe UI\',system-ui,sans-serif;'
  + 'padding:0 24px;border-radius:10px;background:#f4f1ea;color:#000;text-decoration:none">Back to lobby</a></div>'
  + '<script>document.getElementById("back").onclick=function(e){'
  + 'if(window.parent&&window.parent!==window){e.preventDefault();window.parent.postMessage("game:done","*")}};'
  + '</script></body></html>';

function sendClosed(res) {
  res.set('Cache-Control', 'no-store');
  res.status(503).type('html').send(CLOSED_PAGE);
}

// open: the boot-time switch value. file: the absolute path of public/sl.html.
function slRoutes(app, { open, file }) {
  app.get('/sl', (_req, res) => {
    if (!open) return sendClosed(res);
    res.set('Cache-Control', 'no-store');
    res.sendFile(file);
  });
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !isSlFile(req.path)) return next();
    if (!open) return sendClosed(res);
    res.redirect(302, '/sl');
  });
}

module.exports = { slSwitch, isSlFile, slRoutes, CLOSED_PAGE };
