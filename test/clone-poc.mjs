/**
 * Exploratory POC: "copy the page, swap the content".
 *
 * Historical POC: "copy the page, swap the content". The real implementation is
 * src/clone.ts; it now replaces every image with a placehold.co placeholder.
 * This script is kept only because it renders a three-way comparison
 * (original / gray placeholders / images kept) in out/poc/, which is useful for
 * discussing the fidelity trade-off.
 *
 * Run inside the project image:
 *   docker run --rm --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp \
 *     -v "$PWD/test:/app/test:ro" -v "$PWD/out:/out" \
 *     --entrypoint node skeleton /app/test/clone-poc.mjs https://www.apple.com/ apple
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = '/out/poc';
const VIEWPORT = { width: 1440, height: 900 };
const SEED = 42;

const [, , targetUrl, slugArg] = process.argv;
if (!targetUrl) {
  console.error('usage: node clone-poc.mjs <url> [slug]');
  process.exit(1);
}
const slug = (slugArg || 'page').replace(/[^a-z0-9-]/gi, '-').toLowerCase();

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});

try {
  await mkdir(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  console.log(`[${slug}] loading ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'load', timeout: 90_000 });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await autoScroll(page);
  await page.waitForTimeout(800);
  // ResourceLoader (and friends) inject <link> tags late; wait until the
  // stylesheet list stops growing before we snapshot it.
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    /* networkidle is best-effort */
  }
  await page.waitForFunction(
    () => {
      const count = document.styleSheets.length;
      const global = window;
      const key = '__sheetCount';
      const stable = global[key] === count;
      global[key] = count;
      return stable;
    },
    undefined,
    { polling: 500, timeout: 10_000 },
  ).catch(() => {});

  const originalPng = `${OUT}/${slug}-original.png`;
  await page.screenshot({ path: originalPng, clip: { x: 0, y: 0, ...VIEWPORT } });

  const baseCss = await collectCss(page, context);

  const variants = [
    { id: 'placeholder', keepImages: false, label: 'lorem text + gray media placeholders' },
    { id: 'images', keepImages: true, label: 'lorem text, original images kept' },
  ];

  const results = [];
  for (const variant of variants) {
    const css = variant.keepImages ? baseCss : neutraliseBackgrounds(baseCss);
    const body = await page.evaluate(cloneAndAnonymize, {
      seed: SEED,
      keepImages: variant.keepImages,
    });

    const doc = `<!doctype html>
<html lang="${escapeAttr(body.lang)}"${body.htmlClass ? ` class="${escapeAttr(body.htmlClass)}"` : ''}${body.dir ? ` dir="${escapeAttr(body.dir)}"` : ''}${body.htmlStyle ? ` style="${escapeAttr(body.htmlStyle)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Placeholder clone</title>
<style>
${css}
</style>
</head>
<body${body.idAttr ? ` id="${escapeAttr(body.idAttr)}"` : ''}${body.classAttr ? ` class="${escapeAttr(body.classAttr)}"` : ''}${body.styleAttr ? ` style="${escapeAttr(body.styleAttr)}"` : ''}>
${body.html}
</body>
</html>
`;

    const outPath = `${OUT}/${slug}-${variant.id}.html`;
    await writeFile(outPath, doc, 'utf8');

    const outputPng = `${OUT}/${slug}-${variant.id}.png`;
    await shoot(context, outPath, outputPng);
    const score = await pixelDiff(browser, originalPng, outputPng);

    results.push({ ...variant, bytes: doc.length, score });
    console.log(
      `[${slug}:${variant.id}] ${(doc.length / 1024).toFixed(0)} KB · ` +
      `${score.pct.toFixed(1)}% pixels differ`,
    );
  }

  await writeFile(
    `${OUT}/${slug}-compare.html`,
    comparePage(slug, targetUrl, results),
    'utf8',
  );
  console.log(`[${slug}] open ${OUT}/${slug}-compare.html`);
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------

/** Runs inside the browser. Builds the sanitized clone of document.body. */
function cloneAndAnonymize({ seed, keepImages }) {
  const WORDS = [
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
    'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
    'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
    'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
    'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
    'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
    'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
    'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
  ];
  let state = seed >>> 0;
  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const lorem = (wordCount) => {
    const count = Math.max(1, Math.min(wordCount, 80));
    const words = [];
    for (let i = 0; i < count; i += 1) {
      words.push(WORDS[Math.floor(rng() * WORDS.length)]);
    }
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    return `${words.join(' ')}.`;
  };

  const absolute = (url) => {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  };
  const absoluteCss = (css) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) =>
      /^(data:|blob:|#|about:)/i.test(url) ? match : `url("${absolute(url)}")`,
    );

  const clone = document.body.cloneNode(true);
  const originals = Array.from(document.body.querySelectorAll('*'));
  const copies = Array.from(clone.querySelectorAll('*'));

  const MEDIA = new Set([
    'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'SVG', 'OBJECT',
    'EMBED', 'MAP',
  ]);
  const DROP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'STYLE', 'TITLE', 'BASE']);
  const STRIP_ATTRS = new Set([
    'href', 'src', 'srcset', 'alt', 'title', 'value', 'placeholder', 'poster',
    'content', 'formaction', 'download', 'target', 'rel', 'ping', 'sizes',
  ]);

  // Walk backwards so a media node is handled before its own descendants.
  // `clone` is detached, so containment (not isConnected) is the right check.
  for (let i = originals.length - 1; i >= 0; i -= 1) {
    const original = originals[i];
    const copy = copies[i];
    if (!copy || !clone.contains(copy)) continue;
    const tag = original.tagName.toUpperCase();

    if (DROP.has(tag)) {
      copy.remove();
      continue;
    }

    if (!keepImages && MEDIA.has(tag)) {
      const cs = getComputedStyle(original);
      const rect = original.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) {
        copy.remove();
        continue;
      }
      const holder = document.createElement('span');
      holder.setAttribute('data-placeholder', tag.toLowerCase());
      const decls = [
        'display:inline-block',
        `width:${rect.width.toFixed(1)}px`,
        `height:${rect.height.toFixed(1)}px`,
        'background:#d8d8d8',
        'vertical-align:middle',
        'overflow:hidden',
      ];
      if (cs.borderRadius && cs.borderRadius !== '0px') decls.push(`border-radius:${cs.borderRadius}`);
      if (cs.opacity && cs.opacity !== '1') decls.push(`opacity:${cs.opacity}`);
      holder.style.cssText = decls.join(';');
      copy.replaceWith(holder);
      continue;
    }

    for (const attr of Array.from(copy.attributes)) {
      const name = attr.name.toLowerCase();
      if (keepImages) {
        // The output lives at file://, so every asset URL must become absolute.
        if (name === 'src' || name === 'poster') {
          copy.setAttribute(attr.name, absolute(attr.value));
          continue;
        }
        if (name === 'srcset') {
          copy.setAttribute(
            'srcset',
            attr.value
              .split(',')
              .map((entry) => {
                const parts = entry.trim().split(/\s+/);
                parts[0] = absolute(parts[0]);
                return parts.join(' ');
              })
              .join(', '),
          );
          continue;
        }
        if (name === 'style') {
          copy.setAttribute('style', absoluteCss(attr.value));
          continue;
        }
      }
      const isSrc = name === 'src' || name === 'srcset' || name === 'poster' || name === 'sizes';
      if (keepImages && isSrc) continue;
      if (STRIP_ATTRS.has(name) || name.startsWith('on') || name.startsWith('data-') || name.startsWith('aria-')) {
        copy.removeAttribute(attr.name);
      }
    }
    if (tag === 'A') copy.setAttribute('href', '#');
  }

  // Text -> lorem, preserving leading/trailing whitespace.
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE']);
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const textJobs = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    const parent = node.parentElement;
    if (text.trim() && parent && !SKIP_TEXT.has(parent.tagName.toUpperCase())) {
      if (!parent.closest('[data-placeholder]')) textJobs.push(node);
    }
    node = walker.nextNode();
  }
  for (const textNode of textJobs) {
    const value = textNode.nodeValue;
    const lead = (value.match(/^\s*/) || [''])[0];
    const trail = (value.match(/\s*$/) || [''])[0];
    const words = value.trim().split(/\s+/).filter(Boolean).length;
    textNode.nodeValue = `${lead}${lorem(words)}${trail}`;
  }

  return {
    html: clone.innerHTML,
    classAttr: document.body.getAttribute('class') ?? '',
    styleAttr: document.body.getAttribute('style') ?? '',
    idAttr: document.body.getAttribute('id') ?? '',
    htmlClass: document.documentElement.getAttribute('class') ?? '',
    htmlStyle: document.documentElement.getAttribute('style') ?? '',
    lang: document.documentElement.getAttribute('lang') ?? 'en',
    dir: document.documentElement.getAttribute('dir') ?? '',
  };
}

async function collectCss(page, context) {
  const sheets = await page.evaluate(() =>
    Array.from(document.styleSheets).map((sheet) => {
      let text = '';
      try {
        text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
      } catch {
        text = '';
      }
      return { href: sheet.href, text, media: sheet.media?.mediaText ?? '' };
    }),
  );

  const chunks = [];
  for (const sheet of sheets) {
    let text = sheet.text;
    let base = page.url();
    let source = 'cssRules';
    if (sheet.href) {
      base = sheet.href;
      try {
        const response = await context.request.get(sheet.href, { failOnStatusCode: false });
        if (response.ok()) {
          text = await response.text();
          source = 'fetch';
        }
      } catch {
        /* fall back to the cssRules text */
      }
    }
    if (process.env.CLONE_DEBUG) {
      console.log(
        `  sheet ${sheet.href ? sheet.href.slice(-70) : '(inline)'} ` +
        `src=${source} rules=${sheet.text.length}b text=${text.length}b media="${sheet.media}"`,
      );
    }
    if (!text.trim()) continue;
    const prepared = stripImports(absolutizeUrls(text, base));
    chunks.push(sheet.media ? `@media ${sheet.media}{\n${prepared}\n}` : prepared);
  }
  return chunks.join('\n');
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo(0, 0);
  });
}

async function shoot(context, htmlPath, pngPath) {
  const page = await context.newPage();
  try {
    await page.setViewportSize(VIEWPORT);
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, ...VIEWPORT } });
  } finally {
    await page.close();
  }
}

function absolutizeUrls(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    if (/^(data:|blob:|#|about:)/i.test(url)) return match;
    try {
      return `url("${new URL(url, base).href}")`;
    } catch {
      return match;
    }
  });
}

/** Turn every url() inside a background declaration into `none`. */
function neutraliseBackgrounds(css) {
  return css.replace(
    /(background(?:-image)?\s*:[^;{}]*?)(url\(\s*(['"]?)[^'")]+\3\s*\))/gi,
    (match, prefix) => `${prefix}none`,
  );
}

function stripImports(css) {
  return css.replace(/@import[^;]+;/gi, '');
}

function escapeAttr(value) {
  return String(value).replace(
    /[&<>"]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]),
  );
}

async function pixelDiff(browser, aPath, bPath) {
  const [a, b] = await Promise.all([
    readFile(aPath).then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`),
    readFile(bPath).then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`),
  ]);
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([srcA, srcB]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('image load failed'));
          image.src = src;
        });
      const [imgA, imgB] = await Promise.all([load(srcA), load(srcB)]);
      const w = Math.min(imgA.width, imgB.width);
      const h = Math.min(imgA.height, imgB.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgA, 0, 0);
      const dataA = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(imgB, 0, 0);
      const dataB = ctx.getImageData(0, 0, w, h).data;

      let differing = 0;
      for (let i = 0; i < dataA.length; i += 4) {
        const delta =
          Math.abs(dataA[i] - dataB[i]) +
          Math.abs(dataA[i + 1] - dataB[i + 1]) +
          Math.abs(dataA[i + 2] - dataB[i + 2]);
        if (delta > 36) differing += 1;
      }
      return { pct: (differing / (w * h)) * 100, w, h };
    }, [a, b]);
  } finally {
    await page.close();
  }
}

function comparePage(slug, url, results) {
  const figures = [
    `<figure><img src="${slug}-original.png" alt="original"><figcaption>Original</figcaption></figure>`,
    ...results.map(
      (result) =>
        `<figure><img src="${slug}-${result.id}.png" alt="${result.id}">` +
        `<figcaption>${result.label} — <b>${result.score.pct.toFixed(1)}%</b> px differ</figcaption></figure>`,
    ),
  ].join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${slug} — copy/swap POC</title>
<style>
body{margin:0;background:#0f1115;color:#e8e8ea;font-family:system-ui,sans-serif}
header{padding:20px 24px;border-bottom:1px solid #262a33}
h1{margin:0 0 4px;font-size:18px}
p{margin:0;color:#9aa0aa;font-size:13px}
.shots{display:flex;gap:12px;padding:16px 24px}
figure{margin:0;flex:1;min-width:0}
img{display:block;width:100%;border:1px solid #262a33;border-radius:8px}
figcaption{margin-top:6px;font-size:12px;color:#9aa0aa}
b{color:#f3c969}
</style></head><body>
<header>
<h1>copy + swap content — ${slug}</h1>
<p>${escapeAttr(url)} · ${results.map((r) => `${r.label}: ${(r.bytes / 1024).toFixed(0)} KB`).join(' · ')}</p>
</header>
<div class="shots">
${figures}
</div>
</body></html>`;
}
