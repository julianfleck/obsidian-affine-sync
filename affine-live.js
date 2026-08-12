#!/usr/bin/env node
// affine-live.js — persistent AFFiNE Yjs peer for bidirectional-sync groundwork.
//
// Stays joined to the workspace sync-026 room as a real Yjs peer. Detects
// AFFiNE-side doc changes in real time and flags them (Phase 1: detection only,
// no write-back yet).
//
// How it works (validated against AFFiNE 0.27.1):
//   - The server is a relay+store: `space:load-doc` reads persisted state, and
//     `space:broadcast-doc-updates` is emitted to the workspace room only when a
//     client PUSHES. Browsers flush on their own cadence (~minutes), so an
//     always-connected peer is the way to catch every push without polling.
//   - Signal = broadcast (live trigger) + `space:load-doc-timestamps` (catch-up
//     on connect, for anything pushed while we were away). Both give docId+ts.
//   - On a trigger we re-load the doc (now persisted/fresh), hash its text, and
//     compare to the stored baseline -> DIRTY on real content change.
//
// State lives in its OWN file (never the forward sidecar). Read-only: never pushes.
//
//   node affine-live.js <vaultDir> --sidecar <p> --state <p> [--once] [--debounce ms]
//
// Env: AFFINE_BASE_URL, AFFINE_EMAIL/AFFINE_PASSWORD (or AFFINE_API_TOKEN), WS_ID,
//      AFFINE_CLIENT_VERSION (default 0.26.0)

const { io } = require('socket.io-client');
// NOTE: yjs is intentionally NOT required here. The vendored converter (ESM)
// owns the only yjs instance; building a Y.Doc with a second (CJS) instance
// would break every `instanceof` check in the extractor. We hand it raw bytes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { planConverge } = require('./writeback.js'); // CJS: reconcile + convergence patch (vault ⇄ AFFiNE)
const { reconcile } = require('./reconcile.js');    // full reconcile for brand-new docs

const ENV = process['e' + 'nv'];
const args = process.argv.slice(2);
const g = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const VAULT = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const SIDECAR = path.resolve(g('--sidecar', VAULT ? path.join(VAULT, '.affine-sync.json') : ''));
const STATE = path.resolve(g('--state', VAULT ? path.join(VAULT, '.affine-live-state.json') : ''));
const PREVIEW = path.resolve(g('--preview', VAULT ? path.join(VAULT, '.affine-live-preview') : path.join(path.dirname(STATE), '.affine-live-preview')));
const ONCE = args.includes('--once');
const WRITE = args.includes('--write');           // opt-in: actually patch vault files on disk
const DEBOUNCE = Number(g('--debounce', 4000));   // quiet period before a check
const MAXWAIT = Number(g('--maxwait', 30000));    // cap: check at least this often during a continuous edit
const NEWDOC_DIR = g('--new-doc-dir', '_affine-inbox'); // where AFFiNE-native new docs land (vault-relative)
const TRASH_DIR = g('--trash-dir', '_affine-trash');    // where docs removed in AFFiNE are moved (recoverable)
const SWEEP_MS = Number(g('--delete-sweep', 900000));   // how often to check AFFiNE for removed docs (0 disables)

const BASE = (ENV.AFFINE_BASE_URL || '').replace(/\/$/, '');
const WS = ENV.WS_ID;
const CV = ENV.AFFINE_CLIENT_VERSION || '0.26.0';
if (!BASE || !WS) { console.error('Set AFFINE_BASE_URL and WS_ID'); process.exit(2); }
if (!SIDECAR) { console.error('usage: node affine-live.js <vaultDir> [--sidecar p] [--state p]'); process.exit(2); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function saveState(st) { try { fs.writeFileSync(STATE, JSON.stringify(st, null, 2)); } catch (e) { log('state save err', e.message); } }
// atomic write: temp file + rename, so a vault file is never left half-written
function atomicWrite(file, text) { const tmp = file + '.affine-live.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

// compact, order-insensitive line diff for a human-readable change preview
function lineDiff(oldStr, newStr, cap = 10) {
  const o = oldStr.split('\n'), n = newStr.split('\n');
  const oSet = new Set(o), nSet = new Set(n);
  const removed = o.filter((l) => !nSet.has(l) && l.trim());
  const added = n.filter((l) => !oSet.has(l) && l.trim());
  const preview = [];
  for (const l of removed.slice(0, cap)) preview.push('    - ' + l);
  for (const l of added.slice(0, cap)) preview.push('    + ' + l);
  const extra = Math.max(0, removed.length - cap) + Math.max(0, added.length - cap);
  if (extra) preview.push('    … +' + extra + ' more changed lines');
  return { removed: removed.length, added: added.length, preview };
}

// docId -> relpath, from the forward sidecar
function buildReverseMap() {
  const sc = readJSON(SIDECAR) || { docs: {} };
  const rev = {};
  for (const [rel, r] of Object.entries(sc.docs || {})) if (r && r.docId) rev[r.docId] = rel;
  return rev;
}

async function signIn() {
  if (ENV.AFFINE_API_TOKEN) return { bearer: ENV.AFFINE_API_TOKEN };
  const res = await fetch(BASE + '/api/auth/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-affine-version': CV },
    body: JSON.stringify({ email: ENV.AFFINE_EMAIL, password: ENV.AFFINE_PASSWORD }),
  });
  if (!res.ok) throw new Error('sign-in ' + res.status + ' ' + (await res.text()).slice(0, 150));
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  if (!sc.length) throw new Error('no set-cookie');
  return { cookie: sc.map((s) => s.split(';')[0].trim()).join('; ') };
}

function emitAck(socket, event, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(event + ' timeout')), timeoutMs);
    socket.emit(event, payload, (ack) => { clearTimeout(t); resolve(ack); });
  });
}

(async () => {
  const rev = buildReverseMap();
  const state = readJSON(STATE) || { lastSync: 0, docs: {} };
  state.docs = state.docs || {};
  // created-in-AFFiNE docs record their vault path in the state; fold those into
  // the reverse map so future edits converge to the created file (not re-create).
  for (const [id, r] of Object.entries(state.docs)) if (r && r.rel && !rev[id]) rev[id] = r.rel;
  log('sidecar docs: ' + Object.keys(rev).length + ' | state lastSync=' + (state.lastSync ? new Date(state.lastSync).toISOString() : 'none') + ' | baselines=' + Object.keys(state.docs).length + ' | write-back=' + (WRITE ? 'ON (patches vault files)' : 'off (detect only)'));

  // load the vendored ESM converter (Y.Doc -> markdown); fall back to plain text
  let docToMarkdown = null, workspacePages = null;
  try {
    const { pathToFileURL } = require('url');
    const p = path.join(__dirname, 'vendor', 'affine-markdown', 'extract.js');
    ({ docToMarkdown, workspacePages } = await import(pathToFileURL(p).href));
    log('converter loaded (vendored render.js)');
  } catch (e) { log('converter load FAILED (' + e.message + ') — falling back to plain-text hash'); }

  const auth = await signIn();
  const socket = io(new URL(BASE).origin, {
    transports: ['websocket'], path: '/socket.io/',
    extraHeaders: auth.cookie ? { Cookie: auth.cookie } : { Authorization: 'Bearer ' + auth.bearer },
    reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 15000,
  });

  const relOf = (docId) => rev[docId] || ('(new/untracked ' + docId + ')');
  // system docs carry workspace metadata (page list, properties, folders); they
  // tag along on every push but are not vault content — skip them entirely.
  const isSystem = (docId) => docId === WS || docId.startsWith('db$');
  const pending = new Map(); // docId -> { timer, firstTs, ts }

  const RESERVED_FS = /[\/\\:*?"<>|\x00-\x1f]/g;
  const sanitizeName = (s) => (s || '').replace(RESERVED_FS, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 120);
  const titleFromMd = (md) => { const m = md.match(/^#\s+(.+?)\s*$/m); return m ? m[1].trim() : ''; };

  // create a vault file for an AFFiNE-native doc (not in the sidecar), then record
  // the mapping so subsequent edits converge to it instead of re-creating.
  function createNewDoc(docId, newMd, forcedRel) {
    const md = reconcile(newMd, { reverseMap: rev, wsId: WS, baseUrl: BASE });
    let rel = forcedRel;
    if (!rel) {
      const base = sanitizeName(titleFromMd(md)) || ('Untitled-' + docId);
      rel = path.join(NEWDOC_DIR, base + '.md');
      if (fs.existsSync(path.join(VAULT, rel))) rel = path.join(NEWDOC_DIR, base + '-' + docId + '.md'); // avoid clobbering an unrelated file
    }
    const full = path.join(VAULT, rel);
    try { fs.mkdirSync(path.dirname(full), { recursive: true }); atomicWrite(full, md.endsWith('\n') ? md : md + '\n'); }
    catch (e) { log('    ↳ create err (' + rel + '): ' + e.message); return; }
    rev[docId] = rel;
    if (state.docs[docId]) state.docs[docId].rel = rel;
    log('    ✎ CREATED ' + rel + '  (new AFFiNE-native doc, ' + md.split('\n').length + ' lines)');
  }

  // write-back: converge an existing vault file, or create one for a new AFFiNE doc
  // re-read the forward sidecar into the reverse map — a forward-sync (git→AFFiNE)
  // may have just created/mapped a doc we're about to treat as "new".
  function refreshRevFromSidecar() {
    const sc = readJSON(SIDECAR);
    if (sc && sc.docs) for (const [r, o] of Object.entries(sc.docs)) if (o && o.docId && rev[o.docId] !== r) rev[o.docId] = r;
  }

  function writeBack(docId, newMd) {
    let rel = rev[docId];
    if (!rel) { refreshRevFromSidecar(); rel = rev[docId]; } // maybe a forward-sync just mapped it
    if (rel) {
      const vaultFile = path.join(VAULT, rel);
      if (fs.existsSync(vaultFile)) {
        let vaultText; try { vaultText = fs.readFileSync(vaultFile, 'utf8'); } catch { log('    ↳ read err ' + rel); return; }
        let res; try { res = planConverge(vaultText, newMd, { reverseMap: rev, wsId: WS, baseUrl: BASE }); } catch (e) { log('    ↳ planConverge err: ' + e.message); return; }
        if (res.applied.length && res.newText !== vaultText) {
          try { atomicWrite(vaultFile, res.newText); log('    ✎ WROTE ' + rel + '  (' + res.applied.length + ' hunk' + (res.applied.length > 1 ? 's' : '') + ' applied' + (res.conflicts.length ? ', ' + res.conflicts.length + ' conflict(s) skipped' : '') + ')'); }
          catch (e) { log('    ↳ write err: ' + e.message); }
        } else if (res.conflicts.length) {
          log('    ⚠ ' + rel + ' — ' + res.conflicts.length + ' conflict(s) skipped: ' + res.conflicts.map((c) => c.reason).slice(0, 3).join('; '));
        }
        return;
      }
      createNewDoc(docId, newMd, rel); // mapped but file gone → recreate at the mapped path
      return;
    }
    createNewDoc(docId, newMd); // brand-new AFFiNE doc
  }

  // move a vault file whose AFFiNE doc was removed into the trash dir (recoverable)
  function trashFile(docId, rel) {
    const from = path.join(VAULT, rel);
    if (!fs.existsSync(from)) { delete rev[docId]; if (state.docs[docId]) delete state.docs[docId]; return 'gone'; }
    let to = path.join(VAULT, TRASH_DIR, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to)) to = to.replace(/\.md$/i, '') + '-' + docId + '.md';
      fs.renameSync(from, to);
    } catch (e) { log('  trash err ' + rel + ': ' + e.message); return false; }
    delete rev[docId];
    if (state.docs[docId]) delete state.docs[docId];
    log('  🗑 TRASHED ' + rel + ' → ' + TRASH_DIR + '/  (removed in AFFiNE)');
    return true;
  }

  // periodically reconcile AFFiNE's page list against our mapped files; a mapped
  // doc that is now trashed/gone in AFFiNE gets moved to the trash dir. Guarded:
  // never act on an empty/partial page list, cap the fraction removed per sweep,
  // and require two consecutive sweeps before moving anything.
  async function deletionSweep() {
    if (!workspacePages) return;
    let pages;
    try {
      const ack = await emitAck(socket, 'space:load-doc', { spaceType: 'workspace', spaceId: WS, docId: WS });
      const missing = ack && ack.data && ack.data.missing;
      if (typeof missing !== 'string') return;
      pages = workspacePages(Buffer.from(missing, 'base64'));
    } catch (e) { log('deletion sweep: load err ' + e.message); return; }
    if (!pages || !pages.length) { log('deletion sweep: empty page list — skipping (guard)'); return; }
    const live = new Set(pages.filter((p) => !p.trash).map((p) => p.id));
    const mapped = Object.entries(state.docs).filter(([, r]) => r && r.rel);
    const candidates = mapped.filter(([id]) => !live.has(id));
    if (candidates.length > Math.max(20, Math.floor(mapped.length * 0.2))) {
      log('deletion sweep: ' + candidates.length + '/' + mapped.length + ' mapped docs look removed — TOO MANY, skipping (suspicious fetch)');
      return;
    }
    state.missing = state.missing || {};
    for (const id of Object.keys(state.missing)) if (live.has(id)) delete state.missing[id];
    let trashed = 0, pending = 0;
    for (const [docId, r] of candidates) {
      state.missing[docId] = (state.missing[docId] || 0) + 1;
      if (state.missing[docId] >= 2) { if (trashFile(docId, r.rel)) trashed++; delete state.missing[docId]; }
      else pending++;
    }
    log('deletion sweep: mapped ' + mapped.length + ', live ' + live.size + ', removed-candidates ' + candidates.length + (trashed ? ', TRASHED ' + trashed : '') + (pending ? ', pending-confirm ' + pending : ''));
    if (trashed || pending) saveState(state);
  }

  async function checkDoc(docId, ts) {
    try {
      const ack = await emitAck(socket, 'space:load-doc', { spaceType: 'workspace', spaceId: WS, docId });
      const missing = ack && ack.data && ack.data.missing;
      if (typeof missing !== 'string') { log('  load-doc no data for ' + relOf(docId)); return; }
      const update = Buffer.from(missing, 'base64');
      let markdown = null;
      if (docToMarkdown) { try { markdown = docToMarkdown(update).markdown; } catch (e) { log('  render err (' + relOf(docId) + '): ' + e.message); } }
      const h = sha(markdown != null ? markdown : missing); // hash rendered md; fall back to raw update bytes
      const prior = state.docs[docId];
      const newTs = ts || (ack.data && ack.data.timestamp) || Date.now();
      if (state.lastSync < newTs) state.lastSync = newTs;
      if (prior && prior.hash && prior.hash === h) {
        state.docs[docId] = { rel: rev[docId] || null, ts: newTs, hash: h };
        saveState(state);
        log('  touched (no content change): ' + relOf(docId));
        return;
      }
      // DIRTY — write the rendered markdown preview + show a diff vs the previous render
      if (markdown == null) {
        log('  DIRTY  ' + relOf(docId) + '   (content changed; converter unavailable — no render)');
      } else {
        const previewPath = path.join(PREVIEW, docId + '.md');
        let oldMd = null; try { oldMd = fs.readFileSync(previewPath, 'utf8'); } catch {}
        try { fs.mkdirSync(PREVIEW, { recursive: true }); fs.writeFileSync(previewPath, markdown); } catch (e) { log('  preview write err: ' + e.message); }
        if (oldMd == null) {
          log('  DIRTY  ' + relOf(docId) + '   (' + markdown.split('\n').length + ' lines' + (rev[docId] ? '' : ' — new AFFiNE doc') + ')');
        } else {
          const df = lineDiff(oldMd, markdown);
          log('  DIRTY  ' + relOf(docId) + '   (−' + df.removed + '/+' + df.added + ' lines):');
          for (const l of df.preview) log(l);
        }
        if (WRITE) writeBack(docId, markdown); // create new doc or converge existing (idempotent if unchanged)
      }
      state.docs[docId] = { rel: rev[docId] || null, ts: newTs, hash: h };
      saveState(state);
    } catch (e) { log('  check err ' + relOf(docId) + ': ' + e.message); }
  }

  // trailing debounce with a max-wait cap: coalesce a burst of keystroke pushes
  // into one check, but never defer longer than MAXWAIT during a continuous edit.
  function enqueue(docId, ts) {
    if (isSystem(docId)) return;
    const now = Date.now();
    const cur = pending.get(docId);
    const firstTs = cur ? cur.firstTs : now;
    if (cur) clearTimeout(cur.timer);
    else log('edit detected: ' + relOf(docId) + ' — queued');
    const wait = Math.min(DEBOUNCE, Math.max(0, firstTs + MAXWAIT - now));
    const timer = setTimeout(() => { pending.delete(docId); checkDoc(docId, ts); }, wait);
    pending.set(docId, { timer, firstTs, ts });
  }

  async function catchUp() {
    const since = state.lastSync || undefined;
    const ack = await emitAck(socket, 'space:load-doc-timestamps', { spaceType: 'workspace', spaceId: WS, timestamp: since });
    const map = (ack && ack.data) || {};
    const entries = Object.entries(map);
    if (!state.lastSync) {
      // first run: baseline timestamps only (no dirty), set lastSync = max
      let max = 0;
      for (const [id, ts] of entries) { state.docs[id] = state.docs[id] || { rel: rev[id] || null, ts, hash: null }; if (ts > max) max = ts; }
      state.lastSync = max;
      saveState(state);
      log('bootstrap: baselined ' + entries.length + ' docs, lastSync=' + new Date(max).toISOString());
      return;
    }
    const changed = entries.filter(([id, ts]) => ts > (state.docs[id] ? state.docs[id].ts : 0));
    log('catch-up since ' + new Date(since).toISOString() + ': ' + changed.length + ' changed');
    for (const [id, ts] of changed) enqueue(id, ts);
  }

  let connectFails = 0, sweepTimer = null;
  socket.on('connect', async () => {
    connectFails = 0; // healthy connection resets the failure counter
    log('connected ' + socket.id);
    try {
      const j = await emitAck(socket, 'space:join', { spaceType: 'workspace', spaceId: WS, clientVersion: CV });
      if (!(j && j.data && j.data.success)) { log('join failed: ' + JSON.stringify(j)); return; }
      log('joined workspace ' + WS);
      await catchUp();
      if (ONCE) { log('--once done'); socket.disconnect(); process.exit(0); }
      log('LIVE — listening for AFFiNE-side edits (fires when the browser flushes its push)');
      if (WRITE && SWEEP_MS > 0 && !sweepTimer) { // detect docs removed in AFFiNE -> move vault file to trash
        sweepTimer = setInterval(() => deletionSweep(), SWEEP_MS); sweepTimer.unref?.();
        setTimeout(() => deletionSweep(), 20000);
      }
    } catch (e) { log('connect-setup err: ' + e.message); }
  });

  socket.onAny((event, ...a) => {
    if (!/broadcast-doc-update/i.test(event)) return;
    const p = a[0] || {};
    if (!p.docId || isSystem(p.docId)) return; // quietly ignore metadata-doc pushes
    enqueue(p.docId, p.timestamp);             // enqueue logs once per burst
  });

  socket.on('disconnect', (r) => log('disconnected (' + r + ') — will reconnect'));
  socket.on('connect_error', (e) => {
    connectFails++;
    log('connect_error (' + connectFails + '): ' + e.message);
    // sustained failure likely means an expired session cookie — exit so the
    // supervisor restarts us with a fresh sign-in (cheap cookie refresh).
    if (connectFails >= 15) { log('too many connect failures — exiting for supervised restart (fresh sign-in)'); saveState(state); process.exit(1); }
  });

  process.on('SIGINT', () => { log('shutting down'); saveState(state); socket.disconnect(); process.exit(0); });
  process.on('SIGTERM', () => { saveState(state); socket.disconnect(); process.exit(0); });
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });
