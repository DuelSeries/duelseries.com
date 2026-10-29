'use strict';
/* ─── In-game chat guard: the ONE server-side gate every game's chat line goes through ──────────────────────────────
   Owen 2026-10-16 ("get the chat dialed in"). Public chat on a real-money site, so the client is never trusted: every
   game's socket handler hands the raw text here and only sends on what comes back.

     check(key, raw, now) -> { ok: true, text } | { ok: false, why, note }
       key   the sender's socket id (one bucket per connection)
       text  the line to broadcast: cleaned, capped, swear words masked
       why   'bad' (not a string, or absurdly long), 'empty', 'rate', 'dup', 'muted', 'link', 'addr', 'secret', 'abuse'
       note  a short line for the SENDER only (null when one was sent too recently, or for 'bad' and 'empty')

   What it does, in order:
     1. Shape: a string of at most MAX_RAW units, else refused unread.
     2. Clean: NFKC (folds full-width and styled letters), HTML tags and any < > removed (pages print text nodes only,
        this is a second wall), control, zero-width and bidi characters removed (they spoof and dodge the filters),
        stacked accents cut, long runs of one character cut, spaces collapsed, MAX_LEN characters kept.
     3. Rate: a bucket of RATE.burst lines refilled one per RATE.refillMs, never two within RATE.minGapMs; the same
        line again within DUP_MS is dropped.
     4. Scams: links (any scheme, www., a domain with a known ending, "dot com" spellings, IPs, invite and short
        links, any host with a path, a handle on a chat app) and wallet addresses (Solana base58, 0x, bc1, and one
        split up with spaces) are refused, and so is any line asking about a recovery phrase, seed or private key.
     5. Abuse: slurs and "kill yourself" refused, also spelt with numbers, symbols, look-alike letters or spaces.
        Common swear words are masked (f***), not refused.
     Three refusals for 4 or 5 within STRIKES.windowMs pause that sender's chat for STRIKES.muteMs.

   Nothing here logs message text. The word lists are ROT13 so the file reads clean; decoded once at load. */

const MAX_LEN = 120;          // characters kept (the pages' input cap too, public/js/shared/dsChat.js)
const MAX_RAW = 2000;         // longer than this is refused without being read
const RATE = { burst: 4, refillMs: 2000, minGapMs: 400 };
const DUP_MS = 15000;
const STRIKES = { count: 3, windowMs: 120000, muteMs: 120000 };
const NOTE_GAP_MS = 2500;     // at most one note per sender this often
const IDLE_MS = 10 * 60 * 1000;

const NOTES = {
  rate: 'Slow down a little.',
  dup: 'You just said that.',
  muted: 'Your chat is paused for a couple of minutes.',
  link: 'Links can\u2019t be posted in chat.',
  addr: 'Wallet addresses can\u2019t be posted in chat.',
  secret: 'Never share a recovery phrase or private key. Message not sent.',
  abuse: 'That message wasn\u2019t sent. Keep chat friendly.'
};

const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97));
const words = (s) => rot13(s).split(' ');

// Refused as whole words (after look-alikes are undone).
const SLURS = new Set(words('snt sntf snttbg snttbgf sntbg xvxr xvxrf fcvp fcvpf puvax puvaxf genaal genaavrf ergneq ' +
  'ergneqf ergneqrq pbba pbbaf tbbx tbbxf jrgonpx jrgonpxf qlxr qlxrf avttre avttref avttn avttnf avt avtf avtyrg xlf'));
// Refused anywhere inside a word, or inside letters spelt out one or two at a time ("n i g g a", "n.i.g.g.a").
const SLUR_RUNS = [/n+i+g{2,}(?:e+r+|a+h*|u+h+|r+|z+)/, /f+a+g{2,}o+t/];
const KYS_RE = /\bkill+ ?(?:your|ur|yo|you) ?sel(?:f|ves)\b/;
// Masked: words that start with one of these, and these exact words.
const SWEAR_STEMS = words('shpx spx shx cuhpx fuvg ovgpu phag zbgures juber fyhg onfgneq qvpxurnq pbpxfhpx chffl nffubyr ' +
  'wnpxnff qhzonff jnax gjng');
const SWEAR_WORDS = new Set(words('nff nffrf qvpx qvpxf pbpx pbpxf gvgf cvff cevpx'));

// Look-alikes undone before the word checks (digits and symbols for letters, Cyrillic and Greek letters NFKC keeps).
const LOOK = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i',
  '|': 'i', '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u04cf': 'i', '\u03bf': 'o', '\u03b1': 'a', '\u03b9': 'i', '\u03ba': 'k',
  '\u03bd': 'v', '\u03c1': 'p', '\u0442': 't', '\u043a': 'k', '\u043d': 'h', '\u043c': 'm', 'q': 'g'
};
function unlook(s) {
  let out = '';
  for (const ch of s.toLowerCase()) out += LOOK[ch] || ch;
  return out;
}
const squeeze = (w) => w.replace(/(.)\1+/g, '$1');

// Domain endings that mark a link. Short common words (to, so, me, in, us, it, lol) are left out on purpose: "ok.so"
// and "gg.lol" are chat, not links.
const TLDS = 'com|net|org|io|gg|xyz|co|app|link|site|online|top|ru|cc|tk|ly|sh|fun|club|live|shop|store|pro|info|biz|' +
  'dev|money|cash|win|bet|casino|vip|tv|uk|ca|eu|de|fr|ai|sol|fi|finance|exchange|network|page|click|icu|cn|su|pw|ws|' +
  'ga|ml|cf|gq|st|claims?|airdrop|wallet|gift|life|world|space|sbs|zip|mov|tech';
const LINK_RES = [
  /\b(?:https?|ftp|hxxps?)\s*:\s*\/\//i,
  /\bwww\s*\./i,
  new RegExp('\\b[a-z0-9][a-z0-9-]*(?:\\.|\\s*[([{]\\s*(?:\\.|dot)\\s*[)\\]}]\\s*|\\s+dot\\s+)(?:' + TLDS + ')\\b', 'i'),
  /\b(?:discord\s*\.?\s*gg|discord(?:app)?\s*\.\s*com\s*\/\s*invite|dsc\s*\.\s*gg|(?<![\w'’])t\s*\.\s*me\b|bit\s*\.\s*ly|tinyurl|linktr\s*\.\s*ee)/i,
  /\b\d{1,3}(?:\s*\.\s*\d{1,3}){3}\b/
];
const SECRET_RE = /\b(?:seed|recovery|secret|mnemonic|backup|wallet)\s*(?:phrase|words?)\b|\bprivate\s*keys?\b/i;
// Asking for a seed or key without the word "phrase" ("send me your seed", "whats your 12 words", "send me ur pk"), and
// a lure off site to a handle ("dm me on telegram @x", "discord: name#1234"). Read on the text as typed: undoing
// look-alikes would turn "12" into "i2". A bare "recovery" or "backup" stays chat ("nice recovery", "need backup").
// (night review 2026-10-29)
const SECRET_ASK_RE = /\b(?:send|give|share|tell|dm|paste|enter|type|whats|what['’]?s)\b.{0,24}\b(?:seed|recovery\s*(?:code|key)s?|backup\s*codes?|pk|priv(?:ate)?\s*keys?|(?:12|24)\s*words?)\b/i;
const CONTACT_RE = /\b(?:telegram|tg|whatsapp|discord|signal)\b.{0,30}(?:@[a-z0-9_]{3,}|#\d{4}\b)|(?:@[a-z0-9_]{3,}|#\d{4}\b).{0,30}\b(?:telegram|tg|whatsapp|discord|signal)\b/i;

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
function hasAddress(text) {
  const toks = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const t of toks) {
    if (/^0x[0-9a-f]{40}$/i.test(t)) return true;
    if (/^(?:bc1|tb1)[a-z0-9]{20,}$/i.test(t)) return true;
    if (t.length >= 32 && t.length <= 44 && B58.test(t)) return true;
    if (t.length >= 26 && /[0-9]/.test(t) && /[a-z]/i.test(t)) return true;
  }
  // an address split into pieces ("7xKX tg2C W87d ..."): base58 runs that join into one long, mixed string
  let run = '';
  for (const t of toks.concat([''])) {
    if (t.length >= 3 && B58.test(t)) {
      run += t;
      continue;
    }
    if (run.length >= 32 && (run.match(/[0-9]/g) || []).length >= 3 && (run.match(/[A-Z]/g) || []).length >= 3) return true;
    run = '';
  }
  return false;
}

function isAbuse(text) {
  const ws = unlook(text).split(/[^a-z]+/).filter(Boolean);
  const bad = (w) => SLURS.has(w) || SLURS.has(squeeze(w)) || SLUR_RUNS.some((re) => re.test(w));
  let run = '';
  for (const w of ws.concat([''])) {
    if (w && bad(w)) return true;
    if (w && w.length <= 2) {
      run += w;
      continue;
    }
    if (run.length >= 3 && bad(run)) return true;
    run = '';
  }
  return KYS_RE.test(ws.join(' '));
}

// "fucking hell" -> "f****** hell". Masks inside the cleaned text, keeping everything else as typed.
function maskSwears(text) {
  return text.replace(/[\p{L}\p{N}@$!|]+/gu, (w) => {
    const n = unlook(w).replace(/[^a-z]/g, '');
    if (!n) return w;
    const sq = squeeze(n);
    const hit = SWEAR_WORDS.has(n) || SWEAR_WORDS.has(sq) ||
      SWEAR_STEMS.some((s) => n.startsWith(s) || sq.startsWith(squeeze(s)));
    if (!hit) return w;
    const chars = Array.from(w);
    return chars[0] + '*'.repeat(chars.length - 1);
  });
}

// Zero-width, bidi and other invisible format characters (they spoof and dodge the filters). Player names lose the
// same set (server/playerName.js, night review 2026-10-29). Only ever used with replace(), never test().
const INVISIBLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;

// -> the cleaned line ('' when nothing is left), or null when raw is not something to read at all.
function clean(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null;
  let s = raw.normalize('NFKC');
  s = s.replace(/<[^>]{0,200}>/g, ' ').replace(/[<>]/g, '');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  s = s.replace(INVISIBLE_RE, '');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  s = s.replace(/(.)\1{5,}/gu, (m, c) => c.repeat(5));
  s = s.replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > MAX_LEN) s = chars.slice(0, MAX_LEN).join('').trim();
  return s;
}

// -> why the line may not be posted, or null.
function contentProblem(text) {
  const lookless = unlook(text);
  if (SECRET_RE.test(text) || SECRET_RE.test(lookless)) return 'secret';
  if (SECRET_ASK_RE.test(text)) return 'secret';
  /* The ways round the link rules (night review 2026-10-29): the ideographic full stops a browser reads as a dot; a
     space BEFORE the dot ("solgift .com", "solgift . com"; prose never puts one there, so it is closed up for every
     ending); a space only after it for the scam endings that are not words ("solgift. com", while "good game. gg"
     stays chat); any host with a path whatever its ending ("x.me/claim"); and a handle on a chat app. */
  const linky = text.replace(/[。｡]/g, '.').replace(/\s+\.\s*/g, '.');
  for (const re of LINK_RES) if (re.test(text) || re.test(linky)) return 'link';
  if (/\b[a-z0-9][a-z0-9-]*\.\s+(?:com|org|xyz|io|ru|cn)\b/i.test(text)) return 'link';
  if (/\b[a-z0-9][a-z0-9-]{1,62}\.[a-z]{2,24}\/\S/i.test(linky)) return 'link';
  if (CONTACT_RE.test(text)) return 'link';
  if (hasAddress(text)) return 'addr';
  if (isAbuse(text)) return 'abuse';
  return null;
}

function createChatGuard(opts) {
  const o = opts || {};
  const rate = Object.assign({}, RATE, o.rate || {});
  const strikes = Object.assign({}, STRIKES, o.strikes || {});
  const dupMs = o.dupMs != null ? o.dupMs : DUP_MS;
  const states = new Map();
  let checks = 0;

  function sweep(now) {
    for (const [k, st] of states) if (now - st.seen > IDLE_MS) states.delete(k);
  }

  function stateOf(key, now) {
    let st = states.get(key);
    if (!st) {
      st = { tokens: rate.burst, at: now, lastSent: -Infinity, lastText: '', lastTextAt: -Infinity, strikes: [],
        mutedUntil: 0, noteAt: -Infinity, seen: now };
      states.set(key, st);
    }
    if (now < st.seen) {            // a clock that went back: start the sender's timings over, keep any pause
      st.at = now;
      st.lastSent = st.lastTextAt = st.noteAt = -Infinity;
      st.strikes = [];
    }
    st.seen = now;
    return st;
  }

  function refuse(st, why, now) {
    let note = null;
    if (NOTES[why] && now - st.noteAt >= NOTE_GAP_MS) {
      note = NOTES[why];
      st.noteAt = now;
    }
    return { ok: false, why, note };
  }

  function check(key, raw, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    if (++checks % 500 === 0 || states.size > 5000) sweep(t);
    const text = clean(raw);
    if (text === null) return { ok: false, why: 'bad', note: null };
    if (!text) return { ok: false, why: 'empty', note: null };
    const st = stateOf(String(key), t);
    if (st.mutedUntil > t) return refuse(st, 'muted', t);
    st.tokens = Math.min(rate.burst, st.tokens + (t - st.at) / rate.refillMs);
    st.at = t;
    if (st.tokens < 1 || t - st.lastSent < rate.minGapMs) return refuse(st, 'rate', t);
    const problem = contentProblem(text);
    if (problem) {
      st.strikes = st.strikes.filter((x) => t - x < strikes.windowMs);
      st.strikes.push(t);
      st.tokens -= 1;               // a refused line still costs: probing the filter is rate-limited too
      if (st.strikes.length >= strikes.count) {
        st.mutedUntil = t + strikes.muteMs;
        st.strikes = [];
        st.noteAt = -Infinity;
        return refuse(st, 'muted', t);
      }
      return refuse(st, problem, t);
    }
    const norm = text.toLowerCase();
    if (norm === st.lastText && t - st.lastTextAt < dupMs) return refuse(st, 'dup', t);
    st.tokens -= 1;
    st.lastSent = t;
    st.lastText = norm;
    st.lastTextAt = t;
    return { ok: true, text: maskSwears(text) };
  }

  return {
    check,
    forget(key) { states.delete(String(key)); },
    size() { return states.size; }
  };
}

// One guard for the socket handlers of every game but slither (socket ids are unique across games); each slither room
// keeps its own (server/sl/slRoom.js), keyed the same way.
const shared = createChatGuard();

module.exports = { createChatGuard, shared, clean, contentProblem, maskSwears, unlook, INVISIBLE_RE, MAX_LEN, NOTES };
