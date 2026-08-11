// extract.js — Y.Doc (BlockSuite) -> { rootBlockIds, blocksById } -> markdown.
//
// The block-index builder + table extractor are adapted from affine-mcp-server
// (MIT, DAWNCR0W) `dist/tools/docs.js` (collectDocForMarkdown / extractTableData),
// paired with the vendored `render.js`. See NOTICE for attribution.
import * as Y from "yjs";
import { richTextValueToString, richTextValueToDeltas } from "./richText.js";
import { renderBlocksToMarkdown } from "./render.js";

function asText(value) {
  if (value instanceof Y.Text) return value.toString();
  if (typeof value === "string") return value;
  return "";
}
function asStringOrNull(value) {
  return typeof value === "string" ? value : null;
}
function childIdsFrom(value) {
  if (!(value instanceof Y.Array)) return [];
  const childIds = [];
  value.forEach((entry) => {
    if (typeof entry === "string") { childIds.push(entry); return; }
    if (Array.isArray(entry)) { for (const e of entry) if (typeof e === "string") childIds.push(e); }
  });
  return childIds;
}
function findBlockById(blocks, blockId) {
  const value = blocks.get(blockId);
  return value instanceof Y.Map ? value : null;
}
function findBlockIdByFlavour(blocks, flavour) {
  for (const [, value] of blocks) {
    if (value && value.get && value.get("sys:flavour") === flavour) return String(value.get("sys:id"));
  }
  return null;
}
function mapEntries(value) {
  if (value instanceof Y.Map) { const e = []; value.forEach((v, k) => e.push([k, v])); return e; }
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

function extractTableData(block) {
  const cmp = (l, r) => (l < r ? -1 : l > r ? 1 : 0);
  let rowEntries = mapEntries(block.get("prop:rows")).map(([rowId, p]) => ({
    rowId, order: p && typeof p === "object" && typeof p.order === "string" ? p.order : rowId,
  })).sort((a, b) => cmp(a.order, b.order));
  let columnEntries = mapEntries(block.get("prop:columns")).map(([columnId, p]) => ({
    columnId, order: p && typeof p === "object" && typeof p.order === "string" ? p.order : columnId,
  })).sort((a, b) => cmp(a.order, b.order));
  let cells = new Map();
  if (rowEntries.length === 0 || columnEntries.length === 0) {
    // self-hosted flat dot-notation layout: prop:rows.{id}.order / prop:columns.{id}.order / prop:cells.{r}:{c}.text
    const flatRows = new Map(), flatCols = new Map(), flatCells = new Map();
    block.forEach((value, key) => {
      let m;
      if ((m = key.match(/^prop:rows\.([^.]+)\.order$/))) { flatRows.set(m[1], typeof value === "string" ? value : m[1]); return; }
      if ((m = key.match(/^prop:columns\.([^.]+)\.order$/))) { flatCols.set(m[1], typeof value === "string" ? value : m[1]); return; }
      if ((m = key.match(/^prop:cells\.([^.]+:[^.]+)\.text$/))) { flatCells.set(m[1], { text: richTextValueToString(value), deltas: richTextValueToDeltas(value) ?? [] }); }
    });
    if (flatRows.size > 0 && flatCols.size > 0) {
      rowEntries = Array.from(flatRows.entries()).map(([rowId, order]) => ({ rowId, order })).sort((a, b) => cmp(a.order, b.order));
      columnEntries = Array.from(flatCols.entries()).map(([columnId, order]) => ({ columnId, order })).sort((a, b) => cmp(a.order, b.order));
      cells = flatCells;
    }
  } else {
    for (const [cellKey, payload] of mapEntries(block.get("prop:cells"))) {
      let textValue = null;
      if (payload instanceof Y.Map) textValue = payload.get("text");
      else if (payload && typeof payload === "object" && "text" in payload) textValue = payload.text;
      else continue;
      cells.set(cellKey, { text: richTextValueToString(textValue), deltas: richTextValueToDeltas(textValue) ?? [] });
    }
  }
  if (rowEntries.length === 0 || columnEntries.length === 0) return null;
  const tableData = [], tableCellDeltas = [];
  for (const { rowId } of rowEntries) {
    const row = [], rowDeltas = [];
    for (const { columnId } of columnEntries) {
      const cell = cells.get(`${rowId}:${columnId}`);
      row.push(cell?.text ?? "");
      rowDeltas.push(cell?.deltas ?? []);
    }
    tableData.push(row); tableCellDeltas.push(rowDeltas);
  }
  return { tableData, tableCellDeltas };
}

function collectDocForMarkdown(doc) {
  const blocks = doc.getMap("blocks");
  const pageId = findBlockIdByFlavour(blocks, "affine:page");
  const noteId = findBlockIdByFlavour(blocks, "affine:note");
  const blocksById = new Map();
  const visited = new Set();
  let title = "";
  const rootBlockIds = [];
  if (pageId) {
    const pageBlock = findBlockById(blocks, pageId);
    if (pageBlock) { title = asText(pageBlock.get("prop:title")); rootBlockIds.push(...childIdsFrom(pageBlock.get("sys:children"))); }
  } else if (noteId) {
    rootBlockIds.push(noteId);
  }
  if (rootBlockIds.length === 0) for (const [id] of blocks) rootBlockIds.push(String(id));
  const visit = (blockId) => {
    if (visited.has(blockId)) return;
    visited.add(blockId);
    const block = findBlockById(blocks, blockId);
    if (!block) return;
    const childIds = childIdsFrom(block.get("sys:children"));
    const textValue = block.get("prop:text");
    const table = block.get("sys:flavour") === "affine:table" ? extractTableData(block) : null;
    blocksById.set(blockId, {
      id: blockId,
      parentId: asStringOrNull(block.get("sys:parent")),
      flavour: asStringOrNull(block.get("sys:flavour")),
      type: asStringOrNull(block.get("prop:type")),
      text: richTextValueToString(textValue) || null,
      textDeltas: richTextValueToDeltas(textValue),
      checked: typeof block.get("prop:checked") === "boolean" ? Boolean(block.get("prop:checked")) : null,
      language: asStringOrNull(block.get("prop:language")),
      childIds,
      url: asStringOrNull(block.get("prop:url")),
      sourceId: asStringOrNull(block.get("prop:sourceId")),
      caption: asStringOrNull(block.get("prop:caption")),
      tableData: table?.tableData ?? null,
      tableCellDeltas: table?.tableCellDeltas ?? null,
    });
    for (const childId of childIds) visit(childId);
  };
  for (const rootId of rootBlockIds) visit(rootId);
  for (const [id] of blocks) visit(String(id));
  return { title, rootBlockIds, blocksById };
}

// Accepts a Y.Doc OR a Yjs update (Uint8Array/Buffer). Prefer passing the raw
// update bytes so the doc is built HERE with this module's yjs instance —
// crossing yjs instances breaks every `instanceof` check in the extractor.
export function docToMarkdown(input) {
  let ydoc;
  if (input instanceof Y.Doc) {
    ydoc = input;
  } else {
    ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, input instanceof Uint8Array ? input : new Uint8Array(input));
  }
  const c = collectDocForMarkdown(ydoc);
  const r = renderBlocksToMarkdown({ rootBlockIds: c.rootBlockIds, blocksById: c.blocksById });
  return { title: c.title, markdown: r.markdown, lossy: r.lossy, warnings: r.warnings, stats: r.stats };
}
