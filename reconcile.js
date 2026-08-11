'use strict';
// reconcile.js — reverse AFFiNE's lossy markdown-export transforms back toward
// Obsidian/vault style. Pure string transforms; safe to run on rendered output.

// AFFiNE over-escapes punctuation in prose; unescape the safe set.
const UNESCAPE_RE = /\\([\\`*_{}\[\]()#+\-.!|<>~&@:;,'"=/])/g;
function unescapePunct(s) { return s.replace(UNESCAPE_RE, '$1'); }

// Hard line breaks and a few HTML entities the exporter emits.
function decodeEntities(s) {
  return s.replace(/&#10;/g, '\n').replace(/&#9;/g, '\t')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// [label](scheme://host) where the (de-escaped) label equals the host -> bare host.
function reverseDomainAutolinks(s) {
  return s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
    const bareLabel = label.replace(/\\(.)/g, '$1');
    const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return bareLabel === host ? bareLabel : m;
  });
}

// AFFiNE bolds the header row of every table; unbold header cells.
function unboldTableHeaders(md) {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[i + 1])) {
      lines[i] = lines[i].replace(/\*\*([^*]+)\*\*/g, '$1');
    }
  }
  return lines.join('\n');
}

// Normalize spaced separators "| --- | --- |" -> "|---|---|".
function normalizeTableSeparators(md) {
  return md.replace(/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, (row) => {
    const cols = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
    return '|' + Array(cols).fill('---').join('|') + '|';
  });
}

// form-A internal links -> [[wikilinks]] via the sidecar reverse map (docId -> relpath).
function formAToWikilinks(md, opts) {
  const { reverseMap, wsId, baseUrl } = opts || {};
  if (!reverseMap || !wsId || !baseUrl) return md;
  const esc = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\[([^\\]]+)\\]\\(' + esc + '/workspace/' + wsId + '/([A-Za-z0-9_-]+)[^)]*\\)', 'g');
  return md.replace(re, (m, label, docId) => {
    const rel = reverseMap[docId];
    if (!rel) return m;
    const base = rel.replace(/\.md$/, '').split('/').pop();
    const cleanLabel = label.replace(/\\(.)/g, '$1');
    return cleanLabel === base ? `[[${base}]]` : `[[${base}|${cleanLabel}]]`;
  });
}

function reconcile(md, opts = {}) {
  let s = md;
  s = formAToWikilinks(s, opts);   // internal links (URL is unescaped) first
  s = decodeEntities(s);
  s = reverseDomainAutolinks(s);
  s = unboldTableHeaders(s);
  s = normalizeTableSeparators(s);
  s = unescapePunct(s);
  return s;
}

module.exports = { reconcile, unescapePunct, decodeEntities, reverseDomainAutolinks, unboldTableHeaders, normalizeTableSeparators, formAToWikilinks };
