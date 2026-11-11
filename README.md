# skeleton

Copy a web page's rendered layout and replace its content.

The tool loads a page in headless Chromium, keeps the **live rendered DOM** and
the page's **own stylesheets**, and writes a single HTML file in which every text
node is lorem and every image is replaced by a tiny 16-cell colour mosaic of the
original (or a solid `placehold.co` block when the image cannot be downloaded).
Layout, typography, color and spacing survive exactly as the browser rendered
them; the imagery is deliberately coarse.

It is a **layout copy, not an anonymizer**: original class names, ids and CSS
survive. See [Fidelity vs. anonymization](#fidelity-vs-anonymization).

## Quick start (Docker)

```bash
docker build -t skeleton .

docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/out:/out" \
  skeleton https://example.com -o /out/page.html
```

Open `out/page.html` in a browser. Mosaics are embedded in the file, webfonts
still load from the original site, and only fallback images hit `placehold.co`,
so the file needs network access for fonts and fallbacks.

For a local file, mount it and pass a `file://` URL:

```bash
docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/test:/test" \
  -v "$PWD/out:/out" \
  skeleton file:///test/fixture.html -o /out/fixture.html
```

## Usage

```
skeleton <url> [options]

  -o, --out <file>        Output HTML file (default: out.html)
      --viewport <WxH>    Capture viewport (default: 1440x900)
      --seed <number>     Lorem seed (default: 42)
      --title <text>      Output page title (default: "Placeholder clone")
      --images <mode>     mosaic (16-cell pixel grid) or solid (dominant-colour
                          block) (default: mosaic)
  -h, --help              Show help
```

Reruns with the same seed produce identical lorem, which makes diffs useful.

### Image placeholders

By default every image is replaced by a coarse version of itself: it is
downloaded and reduced to a grid with **16 cells on its long edge** (proportional
on the short edge), each cell filled with that region's most common colour. The
grid is embedded as a tiny PNG data URI and upscaled with
`image-rendering: pixelated`, so image-led layouts keep their colour composition
without reproducing the photo. This covers `<img>` elements and CSS image
`url()`s (backgrounds, masks, border images, inline styles).

When an image cannot be downloaded or decoded, the replacement falls back to a
solid [placehold.co](https://placehold.co/) block tinted with its dominant colour
(or `d8d8d8` when nothing could be sampled). Pass `--images solid` to use those
solid blocks for every image instead.

Mosaics are embedded per occurrence, so a logo reused across a page duplicates
its (small) data URI each time.

Colour sampling covers `<img>` (including `srcset`), posters, inline styles and
stylesheet image `url()`s. Very large or unreachable images fall back to the
solid placeholder.

## How it works

```
load  ->  settle  ->  inline  ->  sample  ->  clone  ->  emit
```

1. **load** — opens the URL in Chromium at the requested viewport with a normal
   Chrome user agent, waiting for `domcontentloaded` so a stalled request cannot
   block the capture.
2. **settle** — waits for fonts, scrolls through the page to trigger lazy
   content, waits for `networkidle`, then waits until `document.styleSheets`
   stops growing. Many CMSs inject `<link>` tags after `load`; snapshotting CSS
   too early silently loses base styles.
3. **inline** — reads every stylesheet the page actually applied. Cross-origin
   sheets are fetched through the browser context so cookies and referrers
   match. `@import` and `@charset` are stripped, webfont URLs become absolute,
   and image `url()` references become mosaic PNGs (or solid `placehold.co`
   fallbacks).
4. **sample** — fetches every unique image the page references, downsizes it in
   a canvas, and picks its most frequent colour bucket. In mosaic mode (the
   default) it also builds a 16-cell grid used as the replacement image.
5. **clone** — deep-clones `<body>`, replaces text with lorem of the same word
   count, strips content attributes, points every image at a same-size 16-cell
   mosaic PNG (or a solid `placehold.co` fallback), and swaps
   video/iframe/canvas/svg elements for placeholder images of the same rendered
   size.
6. **emit** — writes one self-contained HTML file: inlined CSS, the cloned body,
   and the original `<html>`/`<body>` classes and inline styles so the page's own
   selectors still match.

## What is replaced

- every text node (lorem, sized to the original word count)
- links (`href="#"`), `alt`, `title`, `value`, `placeholder`, `content`
- every `src`, `srcset`, `poster` and image `url()` (backgrounds, masks,
  borders, data URIs), replaced by the sampled mosaic PNG, or by
  `https://placehold.co/<width>x<height>` when the original cannot be downloaded
- `aria-*`, `data-*` and event handlers (attributes referenced by CSS
  selectors are kept so scoped styles still match)
- scripts, `meta`, `link`, `base`, `noscript`, `template`

## What is kept

- DOM structure, class names, ids
- the page's own CSS, inlined (this is most of the output size)
- `<html>` and `<body>` classes and inline styles
- webfonts, still pointing at their original URLs
- gradients, colors, spacing, borders, radii, shadows, animations

## Known limitations

- **Not anonymized.** Class names, ids and the full original stylesheet are in
  the output; anything brand-specific that lives in CSS or markup survives.
- **Needs network** for webfonts, and for `placehold.co` when an image falls
  back to a solid block.
- **Media is generic.** Mosaics keep `<img>` elements and CSS image `url()`s as
  16-cell colour grids; `<video>`, `<iframe>`, canvas and inline SVG still become
  plain placeholder images. Image-led layouts keep their boxes but lose their
  detail by design.
- **Colour sampling is best effort.** Images that cannot be fetched, decoded or
  exceed the sampling budget fall back to a solid `d8d8d8` placeholder. Only the
  first 1000 unique image URLs are sampled.
- **Size.** The whole stylesheet is inlined: 34 KB for Hacker News, 576 KB for
  Wikipedia, 3.9 MB for GitHub.
- **Frozen in time.** JS-driven content is captured once. Carousels and rotating
  heroes make reruns differ, and forms/counters stop working.
- **Shadow DOM is not cloned**; custom elements keep only their light DOM.
- **Single viewport.** The copy keeps the page's own media queries, so it still
  reflows, but it was only captured at one size.

## Fidelity vs. anonymization

This project previously measured each element's geometry and rebuilt a flow
layout from scratch, leaving no original markup behind. That pipeline is in the
first commit (`47ac300`) if you need it back.

The trade is:

| approach | fidelity | size | anonymized |
|---|---|---|---|
| measured flow rebuild (old) | 50–80% | 25–150 KB | yes |
| copy DOM + CSS + mosaics (current) | structure exact, media replaced | 34 KB–3.9 MB | no |

If anonymization is the requirement, the middle ground is to emit *computed*
styles per element instead of the original stylesheet — same fidelity, no
borrowed CSS. See `TODO.md`.

## Examples

`test/suite.mjs` captures a matrix of representative pages and writes one
placeholder clone per site — nothing else (no screenshots, no report, no JSON).
It writes mosaics by default; set `IMAGE_MODE=solid` to write the solid variant
instead.

```bash
docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/test:/app/test:ro" \
  -v "$PWD/out:/out" \
  --entrypoint node skeleton /app/test/suite.mjs
```

Or locally:

```bash
npm run examples
npm run examples:mosaic
```

Clones land in `out/tests/<slug>.html` (solid) and `out/mosaic/<slug>.html`
(mosaic); the Docker run writes to the same paths inside the mounted `out/`.
Open one directly in a browser; solid clones load images from `placehold.co`,
mosaic clones embed them, and both load webfonts from the original site.

The examples index is the static page in `site/index.html`; `npm run examples`
copies it to `out/index.html` (or run `npm run landing` on its own). The landing
page is published at the site root, <https://copiamasnaofazigual.com.br/>.

Every push to `main` that touches `src/`, `test/`, `site/` or the package files
regenerates the clones and publishes them to GitHub Pages at
<https://copiamasnaofazigual.com.br>:

- https://copiamasnaofazigual.com.br/tests/wikipedia.html
- https://copiamasnaofazigual.com.br/tests/hackernews.html
- https://copiamasnaofazigual.com.br/tests/bbc.html
- https://copiamasnaofazigual.com.br/tests/github.html
- https://copiamasnaofazigual.com.br/tests/apple.html
- https://copiamasnaofazigual.com.br/mosaic/wikipedia.html
- https://copiamasnaofazigual.com.br/mosaic/hackernews.html
- https://copiamasnaofazigual.com.br/mosaic/bbc.html
- https://copiamasnaofazigual.com.br/mosaic/github.html
- https://copiamasnaofazigual.com.br/mosaic/apple.html

### Custom domain

The custom domain is configured in the repository's Pages settings; with an
Actions-based publishing workflow no `CNAME` file is needed (GitHub ignores one
if present). The current configuration can be checked or restored with:

```bash
gh api repos/Joilson-Julkoski/skeleton/pages
gh api --method PUT repos/Joilson-Julkoski/skeleton/pages \
  --field cname=copiamasnaofazigual.com.br \
  --field https_enforced=true
```

The domain is registered at Registro.br but its nameservers currently point to
GoDaddy (`ns31.domaincontrol.com` and `ns32.domaincontrol.com`), so the DNS zone
lives in GoDaddy. (If you prefer Registro.br's DNS, change the nameservers at
Registro.br first; that replaces the GoDaddy zone.)

The zone currently has the required records:

| Type | Name | Value |
|---|---|---|
| A | `@` (empty) | `185.199.108.153` |
| A | `@` (empty) | `185.199.109.153` |
| A | `@` (empty) | `185.199.110.153` |
| A | `@` (empty) | `185.199.111.153` |
| CNAME | `www` | `joilson-julkoski.github.io` |

If you ever need to recreate them, delete any parking records (`15.197.148.33`
and `3.33.130.190`) and the `www` CNAME pointing at the apex first. Leave
unrelated records (email, verification TXT, DMARC) alone. The certificate is
issued by GitHub; once it is approved, enable **Enforce HTTPS**.

Optional IPv6 records for the apex, if your DNS provider supports them:

| Type | Name | Value |
|---|---|---|
| AAAA | `@` (empty) | `2606:50c0:8000::153` |
| AAAA | `@` (empty) | `2606:50c0:8001::153` |
| AAAA | `@` (empty) | `2606:50c0:8002::153` |
| AAAA | `@` (empty) | `2606:50c0:8003::153` |

`test/clone-poc.mjs` is the exploratory script that led to clone mode; it
generates the three-way comparison in `/poc/`. Superseded by `src/clone.ts`.
