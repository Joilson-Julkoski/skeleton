import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { clonePage } from '../dist/clone.js';

const OUT = '/out/sites';
const VIEWPORT = { width: 1440, height: 900 };
const SEED = 42;

const PAGES = [
  { slug: 'wikipedia', name: 'Wikipedia — Web browser', tier: 1, url: 'https://en.wikipedia.org/wiki/Web_browser' },
  { slug: 'hackernews', name: 'Hacker News', tier: 1, url: 'https://news.ycombinator.com' },
  { slug: 'bbc', name: 'BBC News', tier: 2, url: 'https://www.bbc.com/news' },
  { slug: 'github', name: 'GitHub — VS Code repo', tier: 3, url: 'https://github.com/microsoft/vscode' },
  { slug: 'apple', name: 'Apple', tier: 3, url: 'https://www.apple.com/' },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  const results = [];

  try {
    for (const entry of PAGES) {
      const started = Date.now();
      const result = {
        ...entry,
        ok: false,
        ms: 0,
        bytes: 0,
        elements: 0,
        error: '',
      };

      try {
        process.stdout.write(`[${entry.slug}] capturing ${entry.url}\n`);
        const clone = await clonePage({
          url: entry.url,
          viewport: VIEWPORT,
          seed: SEED,
          title: 'Placeholder clone',
          screenshot: true,
          timeoutMs: 90_000,
        });

        await writeFile(`${OUT}/${entry.slug}.html`, clone.html, 'utf8');
        await writeFile(`${OUT}/${entry.slug}-original-top.png`, clone.originalScreenshot);

        const output = `${OUT}/${entry.slug}-output-top.png`;
        await screenshot(browser, pathToFileURL(`${OUT}/${entry.slug}.html`).href, output, false);
        await screenshot(
          browser,
          pathToFileURL(`${OUT}/${entry.slug}.html`).href,
          `${OUT}/${entry.slug}-output-full.png`,
          true,
        );

        result.bytes = Buffer.byteLength(clone.html);
        result.elements = clone.elementCount;
        result.ok = true;

        process.stdout.write(
          `[${entry.slug}] ok — ${(result.bytes / 1024).toFixed(1)} KB, ` +
          `${result.elements} elements\n`,
        );
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        process.stdout.write(`[${entry.slug}] FAILED — ${result.error}\n`);
      }

      result.ms = Date.now() - started;
      results.push(result);
    }

    await writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 2), 'utf8');
    await writeFile(`${OUT}/index.html`, renderIndex(results), 'utf8');
    process.stdout.write('\nDone. Open /out/sites/index.html\n');
  } finally {
    await browser.close();
  }
}

async function screenshot(browser, url, path, fullPage) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path, fullPage });
  } finally {
    await page.close();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderIndex(results) {
  const rows = results
    .map(
      (result) => `<tr>
        <td><a href="#${result.slug}">${escapeHtml(result.name)}</a></td>
        <td>${result.tier}</td>
        <td class="${result.ok ? 'ok' : 'fail'}">${result.ok ? 'captured' : 'failed'}</td>
        <td class="num">${result.ok ? `${(result.bytes / 1024).toFixed(1)} KB` : '—'}</td>
        <td class="num">${result.ok ? result.elements : '—'}</td>
        <td class="num">${(result.ms / 1000).toFixed(1)}s</td>
      </tr>`,
    )
    .join('\n');

  const sections = results
    .map((result) => {
      const body = result.ok
        ? `<div class="shots">
            <figure>
              <a href="${result.slug}-original-top.png" target="_blank" rel="noreferrer">
                <img src="${result.slug}-original-top.png" alt="Original ${escapeHtml(result.name)}" loading="lazy">
              </a>
              <figcaption>Original — top</figcaption>
            </figure>
            <figure>
              <a href="${result.slug}-output-top.png" target="_blank" rel="noreferrer">
                <img src="${result.slug}-output-top.png" alt="Generated ${escapeHtml(result.name)}" loading="lazy">
              </a>
              <figcaption>Generated — top</figcaption>
            </figure>
          </div>
          <p class="meta">
            ${(result.bytes / 1024).toFixed(1)} KB · ${result.elements} elements ·
            ${(result.ms / 1000).toFixed(1)}s ·
            <a href="${result.slug}.html" target="_blank" rel="noreferrer">open live output</a> ·
            <a href="${result.slug}-output-full.png" target="_blank" rel="noreferrer">full-page screenshot</a>
          </p>`
        : `<p class="error">${escapeHtml(result.error)}</p>`;

      return `<section class="case" id="${result.slug}">
        <div class="case-head">
          <h2>${escapeHtml(result.name)}</h2>
          <span class="badge tier-${result.tier}">Tier ${result.tier}</span>
          <a class="source" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">source →</a>
        </div>
        ${body}
      </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skeleton — 5 real sites</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0f1115;
    color: #e8e8ea;
  }
  header { padding: 28px 32px 20px; border-bottom: 1px solid #262a33; }
  h1 { margin: 0 0 6px; font-size: 21px; letter-spacing: -0.02em; }
  header p { margin: 0; color: #9aa0aa; font-size: 14px; }
  .wrap { padding: 20px 32px 48px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 28px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #222733; }
  th { color: #9aa0aa; font-weight: 600; }
  td.num { font-variant-numeric: tabular-nums; }
  a { color: #7cc4ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .ok { color: #6ee7a0; }
  .fail { color: #ff8a8a; }
  .case { margin: 0 0 40px; }
  .case-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .case-head h2 { margin: 0; font-size: 17px; }
  .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: #222733; color: #9aa0aa; }
  .tier-1 { background: #123524; color: #6ee7a0; }
  .tier-2 { background: #33280f; color: #f3c969; }
  .tier-3 { background: #341a1a; color: #ff8a8a; }
  .source { margin-left: auto; font-size: 13px; }
  .shots { display: flex; gap: 16px; align-items: flex-start; }
  @media (max-width: 820px) { .shots { flex-direction: column; } }
  figure { margin: 0; flex: 1 1 0; min-width: 0; }
  figure a { display: block; }
  figure img {
    display: block;
    width: 100%;
    border: 1px solid #262a33;
    border-radius: 10px;
    background: #fff;
  }
  figcaption { margin-top: 6px; font-size: 12px; color: #9aa0aa; }
  .meta { margin: 10px 0 0; font-size: 12px; color: #6f7683; }
  .error { padding: 12px 14px; border: 1px solid #5a2626; border-radius: 10px; color: #ff8a8a; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>skeleton — 5 real sites</h1>
  <p>Clone mode, 1440×900, seed 42. Left: original top. Right: generated top. Text is lorem and every image is a placehold.co placeholder.</p>
</header>
<div class="wrap">
  <table>
    <thead>
      <tr><th>Page</th><th>Tier</th><th>Status</th><th>Output</th><th>Elements</th><th>Time</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
${sections}
</div>
</body>
</html>
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
