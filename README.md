# skeleton

Turn a web page into an **anonymized, responsive layout skeleton**.

The tool renders a page in headless Chromium, reads the computed layout, throws
away every piece of content and branding, and emits a single self-contained HTML
file: semantic tags, generated class names, lorem text, neutral media blocks, and
flow-based CSS that still reflows.

No original text, images, fonts, scripts, links, or class names survive.

## Quick start (Docker)

```bash
docker build -t skeleton .

docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/out:/out" \
  skeleton https://example.com -o /out/page.html
```

Open `out/page.html` in a browser.

No network is needed at runtime except to reach the target URL. For a local
file, mount it and pass a `file://` URL:

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
      --title <text>      Output page title (default: "Anonymized layout")
  -h, --help              Show help
```

Reruns with the same seed produce identical lorem, which makes diffs useful.

## How it works

```
capture  ->  extract  ->  emit
```

1. **capture** — loads the page, waits for fonts, scrolls to trigger lazy
   content, then walks the rendered DOM inside the browser. For each visible
   element it records geometry plus a curated subset of computed styles.
2. **extract** — classifies every node (`container`, `text`, `media`, `control`,
   `decoration`), generates deterministic lorem sized to the original word
   count, and drops empty decoration.
3. **emit** — writes semantic HTML and flow CSS. Flex/grid containers keep their
   layout; resolved pixel widths become percentages or `max-width`; tables keep
   their measured proportion; fixed heights are dropped (except for small icon
   boxes and media aspect ratios). A conservative `max-width: 900px` fallback
   stacks columns and wraps flex rows so the result stays usable on phones.

## What is removed

- text (replaced with lorem)
- the original page title (replaced with a generic one)
- images, videos, canvases, iframes, inline SVG, `url()` backgrounds
- webfonts (font family names are kept, files are never fetched)
- scripts, stylesheets, meta tags, favicons, tracking pixels
- links (`href`), form values, `alt`, `title`, `aria-*`
- original class names and IDs (regenerated as `n-<id>`)

Brand colors, typography metrics, spacing, borders, radii, shadows, and
gradients are kept.

## Known limitations (v1)

- Single viewport; the flow output reflows and has a generic mobile fallback,
  but real structural breakpoints are not inferred yet.
- Complex, JS-hydrated sites (heavy flex/grid nesting, mega-menus, hero
  illustrations) reconstruct roughly. Classic/server-rendered layouts do best.
- Positioned/sticky/fixed layouts are flattened to flow.
- Text reflow changes heights, so the result is a wireframe, not a pixel match.
- Cookie banners and other fixed overlays are captured as part of the page.
- Grid columns are approximated as equal `fr` tracks.

See `TODO.md` for the roadmap.

## Test suite

`test/suite.mjs` captures a matrix of representative pages (classic documents,
modern CSS, component-heavy), emits skeletons, and writes a side-by-side
comparison page.

```bash
docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/test:/app/test:ro" \
  -v "$PWD/out:/out" \
  --entrypoint node skeleton /app/test/suite.mjs
```

Then serve `out/` and open `/suite/`:

```bash
python3 -m http.server 8000 --directory out
```

