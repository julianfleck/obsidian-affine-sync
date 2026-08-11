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
- **Folders** — vault subfolders are recreated as AFFiNE sidebar folders (nested), and each note is placed in its folder. Moving a note between folders relocates it on the next sync. Disable with `--no-folders`.
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

node affine-sync.js <workspaceId> <vaultDir> [--sidecar <path>] [--dry-run] [--no-folders]
```

- `<workspaceId>` — the AFFiNE workspace UUID (find it in the workspace URL, or list them with the MCP server).
- `<vaultDir>` — path to your Markdown folder (scanned recursively; `.git`, `.obsidian`, `node_modules`, etc. are skipped).
- `--sidecar <path>` — override the sidecar location (default `<vaultDir>/.affine-sync.json`).
- `--dry-run` — plan only, no writes.
- `--no-folders` — do not mirror subfolders as AFFiNE sidebar folders.

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
- [ ] Optional deletion of orphaned docs
- [ ] Bidirectional sync (AFFiNE → Markdown) with conflict handling — non-trivial due to export escaping, LinkedPage/property round-tripping, and merge semantics

## License

Apache-2.0 © Julian Fleck
