# obsidian-affine-sync

> One-way sync of an Obsidian / Markdown vault into a self-hosted [AFFiNE](https://affine.pro) workspace — with wikilink resolution, frontmatter mapping, and folder mirroring.

`obsidian-affine-sync` pushes a folder of Markdown notes into an AFFiNE workspace and keeps them updated in place. It resolves Obsidian `[[wikilinks]]` into real AFFiNE internal links, maps YAML frontmatter to AFFiNE **tags**, **custom properties**, and the doc **icon**, and mirrors your vault's **subfolders** as AFFiNE sidebar folders. Your Markdown files are never modified — the note→doc mapping lives in a small sidecar file.

**Direction:** Markdown/Obsidian → AFFiNE (one-way). Changes made in AFFiNE do **not** flow back to your vault yet — see [Roadmap](#roadmap).

> Unofficial community tool. Not affiliated with AFFiNE. Built on the third-party [`affine-mcp-server`](https://github.com/DAWNCR0W/affine-mcp-server).

## Features

- **Idempotent** — a sidecar (`<vault>/.affine-sync.json`) maps each note's relative path to its AFFiNE `docId`. Re-runs update existing docs instead of creating duplicates. Unchanged notes (by content hash) are skipped.
- **Wikilinks** — `[[Note]]`, `[[Note|alias]]`, and `[[Note#heading]]` become `[label](<base>/workspace/<ws>/<docId>)` links that the AFFiNE frontend resolves to real internal references. Targets not in the vault are left as-is and reported.
- **Frontmatter mapping**
  | Frontmatter | → AFFiNE |
  | --- | --- |
  | `title:` | doc title |
  | `tags:` (list/inline) | workspace tags |
  | `icon:` (emoji) | doc icon |
  | scalar keys (`status: active`, `priority: 2`, `done: true`, `due: 2026-08-11`) | custom properties (text / number / checkbox / date, inferred) |
- **Folders** — vault subfolders are recreated as AFFiNE sidebar folders (nested), each note placed in its folder; moved notes relocate on the next sync. Disable with `--no-folders`.
- **Excludes** — a **`.affineignore`** file in the vault root (gitignore syntax: globs, `#` comments, `!` negation, `**`) and/or repeated `--exclude <glob>` flags keep notes out of the sync. (Only `.md` files are synced; `.mdx` and other extensions are ignored.)
- **Non-destructive metadata** — only the tags/properties/placement this tool applied (tracked in the sidecar) are reconciled, so anything you add by hand in AFFiNE is left alone.
- **`--dry-run`** — see what would be created/linked without writing anything.

## Requirements

- Node.js 18+ (spawns `npx affine-mcp-server`, fetched automatically)
- A self-hosted AFFiNE instance and an account on it (email/password, or an API token)

## Usage

```sh
export AFFINE_BASE_URL="https://affine.example.com"
export AFFINE_EMAIL="you@example.com"
export AFFINE_PASSWORD="..."           # or: export AFFINE_API_TOKEN="ut_..."

node affine-sync.js <workspaceId> <vaultDir> [--sidecar <path>] [--dry-run] [--no-folders] [--exclude <glob>]
```

- `<workspaceId>` — the AFFiNE workspace UUID (find it in the workspace URL, or list them with the MCP server).
- `<vaultDir>` — path to your Markdown folder (scanned recursively; `.git`, `.obsidian`, `node_modules`, etc. are skipped).
- `--sidecar <path>` — override the sidecar location (default `<vaultDir>/.affine-sync.json`).
- `--dry-run` — plan only, no writes.
- `--no-folders` — do not mirror subfolders as AFFiNE sidebar folders.
- `--exclude <glob>` — exclude paths (repeatable); combined with `<vaultDir>/.affineignore`.

### `.affineignore`

Put a `.affineignore` in the vault root, gitignore-style:

```gitignore
# don't sync these
TRASH/
templates/
Readwise/
drafts/**/*.private.md
```

Example first run:

```sh
node affine-sync.js 65d0b27a-...-b510f9 ~/vault --dry-run   # preview
node affine-sync.js 65d0b27a-...-b510f9 ~/vault             # apply
```

## How it works

The tool drives AFFiNE through the `affine-mcp-server` (Model Context Protocol) over stdio. It runs in passes: first it ensures a doc exists for every note (recording each `docId` in the sidecar and building a name→docId map from filenames, titles, H1s and aliases); then it strips frontmatter from each body, rewrites wikilinks, pushes the body, and applies tags / properties / icon; finally it mirrors subfolders as sidebar folders and places each note. The full-file content hash gates re-syncs, so editing a note re-triggers a push while untouched notes are skipped.

**Why "form-A" links?** AFFiNE's native inline reference (LinkedPage) does not survive Markdown export (it comes back blank), and the Markdown importer does not auto-convert reference syntaxes. A plain link whose href is the full doc URL is resolved by the AFFiNE frontend into a navigable internal link **and** round-trips cleanly through Markdown, so it is used as the link representation.

## Limitations

- **One-way** (vault → AFFiNE).
- **Frontmatter** is stripped from the doc body and mapped to metadata; arbitrary/complex YAML beyond scalars and simple lists is coerced to text.
- **Orphans** — if you delete a note locally, its AFFiNE doc is *reported* but not deleted (safe default).
- AFFiNE's folder/organize API is marked experimental upstream; folder mirroring depends on it.
- AFFiNE's own Markdown export escapes punctuation heavily, so exports are not byte-identical to your source.

## Roadmap

- [x] Mirror vault subfolders as AFFiNE sidebar folders (organize API)
- [x] `.affineignore` / `--exclude` path filtering
- [ ] Map Obsidian daily notes to AFFiNE **journal** entries — the journal date is a reserved `journal` key in AFFiNE's `docProperties` CRDT, which the MCP can't currently write; needs upstream `affine-mcp-server` support
- [ ] Multi-sync config (`--config`) for several vault→workspace jobs
- [ ] Optional deletion of orphaned docs
- [ ] Bidirectional sync (AFFiNE → Markdown) with conflict handling

## License

Apache-2.0 © Julian Fleck

## Bidirectional sync (experimental): `affine-live.js`

`affine-sync.js` pushes your vault **into** AFFiNE. `affine-live.js` is the reverse
direction — a persistent process that watches AFFiNE for edits and writes them **back**
into your vault Markdown, so changes made in the AFFiNE UI land in your files.

It connects to AFFiNE's realtime sync socket as a headless Yjs peer (the same protocol
the web app uses), so it sees an edit the moment the browser flushes it — even on an
always-open, multi-user workspace. On a change it:

1. **renders** the doc to Markdown via the vendored AFFiNE converter in
   `vendor/affine-markdown/` (MIT — see its `NOTICE.md`);
2. **reconciles** AFFiNE's lossy export back toward vault style (`reconcile.js`):
   unescape punctuation, decode hard breaks, restore bare-domain autolinks, un-bold
   table headers, `form-A` doc URLs → `[[wikilinks]]`;
3. **converges** (`writeback.js`): diffs the vault file directly against the current
   render and applies each genuine content difference as a minimal, in-place edit —
   never a whole-file overwrite. Blank-only (formatting) and table/structural hunks
   are skipped, not force-applied.

Writes are atomic (temp + rename). Version control is left to you — there is no git
built in.

```bash
export AFFINE_BASE_URL="https://affine.example.com"
export AFFINE_EMAIL="you@example.com"
export AFFINE_PASSWORD="..."          # or AFFINE_API_TOKEN
export WS_ID="<workspace-id>"

node affine-live.js <vaultDir> \
  --sidecar  <vaultDir>/.affine-sync.json \
  --state    <path>/live-state.json \
  --preview  <path>/live-preview \
  --write                              # omit --write for detect-only (dry run)
```

**Status / limits.** Detection, reconciliation, and change-only write-back of
paragraph/line edits work end-to-end. In progress: table (and other block-level
structural) changes are detected but **skipped** for safety rather than applied;
inserted lines with an ambiguous anchor are skipped; AFFiNE-native new docs (not in
the sidecar) are not created yet. Requires the `socket.io-client` and `yjs`
dependencies.
