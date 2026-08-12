'use strict';
// writeback.js — plan a minimal, change-only patch of a vault file from an
// AFFiNE-side edit. Strategy: diff the OLD vs NEW AFFiNE render (identical
// format, so only the genuine edit survives), reconcile the hunks to vault
// style, then LOCATE each hunk by content in the vault file and splice it in —
// leaving every other line (spacing included) untouched. Never overwrites the
// whole doc. Hunks that can't be uniquely located are reported as conflicts and
// skipped (both-sides-changed / structural). No git, no I/O — pure planning.
const { reconcile } = require('./reconcile.js');

// LCS line diff -> ops [{t:'eq'|'del'|'ins', s}]
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', s: a[i] }); i++; }
    else { ops.push({ t: 'ins', s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: 'del', s: a[i++] });
  while (j < m) ops.push({ t: 'ins', s: b[j++] });
  return ops;
}

function hunksFrom(ops) {
  const hunks = []; let cur = null;
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.t === 'eq') { if (cur) { cur.after = o.s; hunks.push(cur); cur = null; } continue; }
    if (!cur) cur = { before: k > 0 && ops[k - 1].t === 'eq' ? ops[k - 1].s : null, after: null, del: [], ins: [] };
    if (o.t === 'del') cur.del.push(o.s); else cur.ins.push(o.s);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

const norm = (s) => s.trim();
// find every start index where `needle` (array of lines) matches vault lines
// contiguously by trimmed equality; returns array of start indices.
function findRuns(vault, needle) {
  const starts = [];
  if (needle.length === 0) return starts;
  for (let i = 0; i + needle.length <= vault.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) if (norm(vault[i + k]) !== norm(needle[k])) { ok = false; break; }
    if (ok) starts.push(i);
  }
  return starts;
}
function findAnchors(vault, line) {
  const t = norm(line), out = [];
  for (let i = 0; i < vault.length; i++) if (norm(vault[i]) === t) out.push(i);
  return out;
}

function planPatch(vaultText, oldRender, newRender, opts = {}) {
  const oldRec = reconcile(oldRender, opts).split('\n');
  const newRec = reconcile(newRender, opts).split('\n');
  const hunks = hunksFrom(diffLines(oldRec, newRec));
  const vault = vaultText.split('\n');
  const applied = [], conflicts = [];

  for (const h of hunks) {
    const del = h.del.filter((s) => s.trim() !== '');
    const ins = h.ins.filter((s) => s.trim() !== '');
    if (del.length === 0 && ins.length === 0) continue;

    if (del.length > 0) {
      const starts = findRuns(vault, del);
      if (starts.length !== 1) {
        conflicts.push({ kind: 'replace', del, ins, reason: starts.length === 0 ? 'not located in vault (both sides changed?)' : starts.length + ' ambiguous matches' });
        continue;
      }
      vault.splice(starts[0], del.length, ...ins);
      applied.push({ kind: ins.length ? 'replace' : 'delete', at: starts[0], del, ins });
    } else {
      // pure insertion — anchor on the preceding context line
      if (h.before == null) { conflicts.push({ kind: 'insert', ins, reason: 'no anchor context' }); continue; }
      const beforeRec = reconcile(h.before, opts);
      const anchors = findAnchors(vault, beforeRec);
      if (anchors.length !== 1) { conflicts.push({ kind: 'insert', ins, reason: anchors.length === 0 ? 'anchor not found' : 'anchor ambiguous' }); continue; }
      vault.splice(anchors[0] + 1, 0, '', ...ins);
      applied.push({ kind: 'insert', at: anchors[0] + 1, ins });
    }
  }
  return { newText: vault.join('\n'), applied, conflicts };
}

const isTableLine = (s) => /^\s*\|/.test(s);
const isSeparatorRow = (s) => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(s);

// contiguous runs of table lines (>=2 lines: at least a header + separator)
function findTables(lines) {
  const tables = []; let i = 0;
  while (i < lines.length) {
    if (isTableLine(lines[i])) {
      let j = i; while (j < lines.length && isTableLine(lines[j])) j++;
      if (j - i >= 2) tables.push({ start: i, end: j - 1, lines: lines.slice(i, j) });
      i = j;
    } else i++;
  }
  return tables;
}
// rows of trimmed cells, ignoring the separator row — for content comparison
function tableCells(tlines) {
  return tlines.filter((l) => !isSeparatorRow(l))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
}
const tablesContentEqual = (a, b) => JSON.stringify(tableCells(a)) === JSON.stringify(tableCells(b));

// whole-table reconciliation: positionally match vault tables to render tables;
// where cell CONTENT differs (reorder / cell edit / row add-remove) swap the whole
// vault table block for the render's. Content-compared, so pure formatting never
// triggers a rewrite. Count mismatch (table added/removed) → conflict, skip.
function reconcileTables(vaultLines, newRecLines) {
  const vT = findTables(vaultLines), nT = findTables(newRecLines);
  const applied = [], conflicts = [];
  if (vT.length !== nT.length) {
    if (vT.length || nT.length) conflicts.push({ kind: 'table', reason: 'table count differs (' + vT.length + ' vault / ' + nT.length + ' AFFiNE) — skipped' });
    return { applied, conflicts };
  }
  for (let i = vT.length - 1; i >= 0; i--) { // bottom-up so earlier indices stay valid
    if (!tablesContentEqual(vT[i].lines, nT[i].lines)) {
      vaultLines.splice(vT[i].start, vT[i].end - vT[i].start + 1, ...nT[i].lines);
      applied.push({ kind: 'table', at: vT[i].start, rows: tableCells(nT[i].lines).length });
    }
  }
  return { applied, conflicts };
}

// CONVERGENCE: on a dirty signal, reconcile the two targets directly — diff the
// vault file against the current (reconciled) AFFiNE render and apply every
// genuine content difference. Self-healing: no baseline/preview needed, and it
// catches edits made while we weren't watching. Blank-only hunks are ignored
// (formatting residue); table/structural hunks are skipped (line-patching can't
// reorder a table without corrupting it — block handling is a separate step).
function planConverge(vaultText, newRender, opts = {}) {
  const newRec = reconcile(newRender, opts).split('\n');
  const vault = vaultText.split('\n');
  const hunks = hunksFrom(diffLines(vault, newRec));
  const applied = [], conflicts = [];
  for (const h of hunks) {
    const del = h.del.filter((s) => s.trim() !== '');
    const ins = h.ins.filter((s) => s.trim() !== '');
    if (del.length === 0 && ins.length === 0) continue;               // blank-only → formatting, ignore
    if (del.some(isTableLine) || ins.some(isTableLine)) continue;     // tables handled in pass 2
    if (del.length > 0) {
      const starts = findRuns(vault, del);
      if (starts.length !== 1) { conflicts.push({ kind: 'replace', reason: starts.length === 0 ? 'not located (both sides changed?)' : starts.length + ' ambiguous matches', del, ins }); continue; }
      vault.splice(starts[0], del.length, ...ins);
      applied.push({ kind: ins.length ? 'replace' : 'delete', at: starts[0], del, ins });
    } else {
      if (h.before == null) { conflicts.push({ kind: 'insert', reason: 'no anchor context', ins }); continue; }
      const anchors = findAnchors(vault, h.before);
      if (anchors.length !== 1) { conflicts.push({ kind: 'insert', reason: anchors.length === 0 ? 'anchor not found' : 'anchor ambiguous', ins }); continue; }
      vault.splice(anchors[0] + 1, 0, '', ...ins);
      applied.push({ kind: 'insert', at: anchors[0] + 1, ins });
    }
  }
  // pass 2: whole-table reconciliation (content-aware block swap)
  const t = reconcileTables(vault, newRec);
  applied.push(...t.applied); conflicts.push(...t.conflicts);
  return { newText: vault.join('\n'), applied, conflicts };
}

module.exports = { planPatch, planConverge, reconcileTables, findTables, diffLines, hunksFrom };
