# Vendored converter — attribution

The following files in this directory are vendored (with light adaptation) from
**affine-mcp-server** by DAWNCR0W, licensed **MIT**:

- `render.js`  — `dist/markdown/render.js` (`renderBlocksToMarkdown`)
- `richText.js` — `dist/markdown/richText.js`
- `safety.js`  — `dist/markdown/safety.js`
- `urlSafety.js` — `dist/urlSafety.js`
- `extract.js` — block-index builder + table extractor adapted from
  `dist/tools/docs.js` (`collectDocForMarkdown` / `extractTableData`)

Adaptations: `render.js` import path (`../urlSafety.js` → `./urlSafety.js`);
`extract.js` factored into a standalone module exposing `docToMarkdown(ydoc)`.

Upstream: https://github.com/DAWNCR0W/affine-mcp-server (MIT). Pinned to the
`0.x` line matching AFFiNE server 0.27.1's BlockSuite schema.

MIT License

Copyright (c) DAWNCR0W

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
