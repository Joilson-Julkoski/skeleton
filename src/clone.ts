import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

export interface CloneOptions {
  url: string;
  viewport: { width: number; height: number };
  /** Lorem seed. Same seed + same page = same output. */
  seed: number;
  /** Output page title. */
  title: string;
  /** Also return a PNG of the original page at the captured viewport. */
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface CloneResult {
  html: string;
  elementCount: number;
  pageTitle: string;
  originalScreenshot?: Buffer;
}

const FALLBACK_BACKGROUND = 'd8d8d8';

/**
 * Loads the page in headless Chromium and returns a self-contained HTML file
 * built from the *live rendered DOM* plus the page's own CSS.
 *
 * Content is replaced (text -> lorem, attributes stripped); structure and
 * styling are kept as-is. That is deliberate: this mode trades anonymization
 * and portability for fidelity.
 */
export async function clonePage(options: CloneOptions): Promise<CloneResult> {
  const timeout = options.timeoutMs ?? 60_000;
  const browser = await chromium.launch({
    headless: true,
    // Use the full Chromium build rather than the headless shell: the shell
    // segfaults on some newer distros (e.g. Debian trixie).
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  try {
    // Chromium's default UA advertises "HeadlessChrome", which some sites use
    // to block or stall the page. Present a normal Chrome UA instead.
    const userAgent =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      `(KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
    const context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: 1,
      userAgent,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // `domcontentloaded` is deliberate: some sites keep a long-lived request
    // open and never fire `load`. The settle pass below waits for fonts, lazy
    // content, network idle and late stylesheets.
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout });
    await settle(page);

    const originalScreenshot = options.screenshot
      ? await page.screenshot({
          clip: { x: 0, y: 0, ...options.viewport },
          type: 'png',
        })
      : undefined;

    const stylesheets = await readStylesheets(page, context, options.url);
    const colours = await detectImageColours(page, context, stylesheets, timeout);
    const keepAttrs = cssAttributeNames(stylesheets);

    const css = renderCss(stylesheets, colours);

    const body = await page.evaluate(cloneDocument, {
      seed: options.seed,
      colours: Object.fromEntries(colours),
      keepAttrs,
    });

    return {
      html: assemble(css, body, options.title),
      elementCount: body.elementCount,
      pageTitle: body.pageTitle,
      originalScreenshot,
    };
  } finally {
    await browser.close();
  }
}

/** Waits for fonts, lazy content, and late-injected stylesheets. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await autoScroll(page);

  // ResourceLoader-style loaders (Wikipedia, many CMSs) add <link> tags after
  // the load event. Snapshotting the CSS too early silently loses base styles.
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    /* best effort */
  }
  await page
    .waitForFunction(
      () => {
        const state = window as unknown as { __sheetCount?: number };
        const count = document.styleSheets.length;
        const stable = state.__sheetCount === count;
        state.__sheetCount = count;
        return stable;
      },
      undefined,
      { polling: 500, timeout: 10_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Scrolls to the bottom and back so lazy content has a chance to render. */
async function autoScroll(page: Page): Promise<void> {
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

interface StyleSheetSource {
  href: string | null;
  text: string;
  media: string;
  base: string;
}

async function readStylesheets(
  page: Page,
  context: BrowserContext,
  pageUrl: string,
): Promise<StyleSheetSource[]> {
  const raw = await page.evaluate(() =>
    Array.from(document.styleSheets).map((sheet) => {
      let text = '';
      try {
        text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
      } catch {
        // Cross-origin sheets hide their rules; the Node side re-fetches them.
        text = '';
      }
      return { href: sheet.href, text, media: sheet.media?.mediaText ?? '' };
    }),
  );

  const sources: StyleSheetSource[] = [];
  for (const sheet of raw) {
    let text = sheet.text;
    if (sheet.href) {
      const fetched = await fetchSheet(sheet.href, context);
      if (fetched !== null) text = fetched;
    }
    sources.push({
      href: sheet.href,
      text,
      media: sheet.media,
      base: sheet.href ?? pageUrl,
    });
  }
  return sources;
}

/** Fetches a stylesheet with the page's cookies; falls back to disk for file URLs. */
async function fetchSheet(href: string, context: BrowserContext): Promise<string | null> {
  try {
    if (href.startsWith('file:')) {
      return await readFile(fileURLToPath(href), 'utf8');
    }
    const response = await context.request.get(href, { failOnStatusCode: false });
    if (response.ok()) return await response.text();
  } catch {
    /* fall back to the cssRules text captured in the page */
  }
  return null;
}

const MAX_COLOUR_IMAGES = 1000;
const MAX_COLOUR_BYTES = 8 * 1024 * 1024;
const MAX_COLOUR_TOTAL = 64 * 1024 * 1024;
const COLOUR_CONCURRENCY = 8;

/**
 * Samples every image the page references (DOM attributes, inline styles and
 * stylesheet `url()`s) and returns a URL-keyed map of dominant colours. Best
 * effort: images that cannot be fetched or decoded keep the fallback colour.
 */
async function detectImageColours(
  page: Page,
  context: BrowserContext,
  stylesheets: StyleSheetSource[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const urls = new Set<string>(await page.evaluate(collectMediaUrls));
  for (const sheet of stylesheets) {
    if (!sheet.text.trim()) continue;
    for (const url of cssImageUrls(sheet.text, sheet.base)) urls.add(url);
  }

  const candidates = Array.from(urls).filter(isSampleable).slice(0, MAX_COLOUR_IMAGES);
  if (candidates.length === 0) return new Map();

  const samples: Array<{ key: string; dataUrl: string }> = [];
  let totalBytes = 0;
  await mapLimit(candidates, COLOUR_CONCURRENCY, async (url) => {
    if (totalBytes >= MAX_COLOUR_TOTAL) return;
    const dataUrl = await readImageData(url, context, timeoutMs);
    if (!dataUrl) return;
    totalBytes += dataUrl.length;
    if (totalBytes > MAX_COLOUR_TOTAL) return;
    samples.push({ key: urlKey(url), dataUrl });
  });
  if (samples.length === 0) return new Map();

  try {
    const found = await page.evaluate(dominantColours, samples);
    return new Map(Object.entries(found));
  } catch {
    return new Map();
  }
}

function isSampleable(url: string): boolean {
  if (/^(https?|file):/i.test(url)) return true;
  return /^data:image\//i.test(url) && url.length <= MAX_COLOUR_BYTES * 1.4;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

async function readImageData(
  url: string,
  context: BrowserContext,
  timeoutMs: number,
): Promise<string | null> {
  if (url.startsWith('data:')) return url;
  try {
    if (url.startsWith('file:')) {
      const body = await readFile(fileURLToPath(url));
      if (body.length === 0 || body.length > MAX_COLOUR_BYTES) return null;
      const extension = url.split('.').pop()?.split(/[?#]/)[0]?.toLowerCase() ?? '';
      const mime = IMAGE_MIME[extension];
      if (!mime) return null;
      return `data:${mime};base64,${body.toString('base64')}`;
    }

    const response = await context.request.get(url, {
      failOnStatusCode: false,
      timeout: Math.min(timeoutMs, 8_000),
    });
    if (!response.ok()) return null;

    const contentType = (response.headers()['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) return null;

    const body = await response.body();
    if (body.length === 0 || body.length > MAX_COLOUR_BYTES) return null;
    return `data:${contentType};base64,${body.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Runs `task` over `items` with a fixed number of workers. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

/** Reads image URLs from a stylesheet, skipping `@font-face` blocks. */
function cssImageUrls(css: string, base: string): string[] {
  const urls: string[] = [];
  const withoutFonts = css.replace(/@font-face\s*\{[^}]*\}/gi, '');
  const pattern =
    /url\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([^'")]*))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutFonts)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || /^(#|about:)/i.test(raw)) continue;
    urls.push(canonicalUrl(raw, base));
  }
  return urls;
}

function canonicalUrl(url: string, base?: string): string {
  if (/^(data:|blob:)/i.test(url)) return url;
  try {
    return new URL(url, base ?? undefined).href;
  } catch {
    return url;
  }
}

/**
 * Collects attribute names referenced by CSS selectors. Framework-scoped styles
 * (for example Astro's `data-astro-cid-*`) only match when those attributes
 * survive cloning, so the attribute stripper keeps anything CSS asks for.
 */
function cssAttributeNames(sheets: StyleSheetSource[]): string[] {
  const names = new Set<string>();
  for (const sheet of sheets) {
    const pattern = /\[\s*([a-zA-Z_][\w-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sheet.text)) !== null) {
      names.add(match[1]!.toLowerCase());
    }
  }
  return Array.from(names);
}

function urlKey(url: string): string {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}-${url.length.toString(36)}`;
}

/** In-page helper: gathers image URLs from the live DOM and inline styles. */
function collectMediaUrls(): string[] {
  const found = new Set<string>();
  const canonical = (value: string | null | undefined): void => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed || /^(#|about:)/i.test(trimmed)) return;
    if (/^(data:|blob:)/i.test(trimmed)) {
      found.add(trimmed);
      return;
    }
    try {
      found.add(new URL(trimmed, document.baseURI).href);
    } catch {
      found.add(trimmed);
    }
  };
  const addSrcset = (value: string | null): void => {
    if (!value) return;
    for (const entry of value.split(',')) {
      const candidate = entry.trim().split(/\s+/)[0];
      if (candidate) canonical(candidate);
    }
  };

  for (const image of Array.from(document.images)) {
    canonical(image.currentSrc || image.src);
    canonical(image.getAttribute('src'));
    addSrcset(image.getAttribute('srcset'));
  }
  for (const source of Array.from(document.querySelectorAll('source'))) {
    addSrcset(source.getAttribute('srcset'));
  }
  for (const video of Array.from(document.querySelectorAll('video'))) {
    canonical(video.getAttribute('poster'));
  }
  for (const input of Array.from(document.querySelectorAll('input[type="image"]'))) {
    canonical(input.getAttribute('src'));
  }
  for (const object of Array.from(document.querySelectorAll('object'))) {
    canonical(object.getAttribute('data'));
  }
  for (const embed of Array.from(document.querySelectorAll('embed'))) {
    canonical(embed.getAttribute('src'));
  }

  const pattern =
    /url\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([^'")]*))\s*\)/gi;
  for (const element of Array.from(document.querySelectorAll('[style]'))) {
    const style = element.getAttribute('style') ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(style)) !== null) {
      canonical(match[1] ?? match[2] ?? match[3]);
    }
  }

  return Array.from(found);
}

/**
 * In-page helper: decodes each image into a small canvas and returns the most
 * frequent colour bucket. Named separately so Playwright can serialize it.
 */
async function dominantColours(
  items: Array<{ key: string; dataUrl: string }>,
): Promise<Record<string, string>> {
  const load = (src: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    });
  const hex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  const out: Record<string, string> = {};

  const sampleOne = async ({ key, dataUrl }: { key: string; dataUrl: string }): Promise<void> => {
    const image = await load(dataUrl);
    if (!image) return;
    try {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, size, size);
      const pixels = ctx.getImageData(0, 0, size, size).data;

      const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3]! < 128) continue;
        const r = pixels[i]!;
        const g = pixels[i + 1]!;
        const b = pixels[i + 2]!;
        const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const entry = buckets.get(bucket);
        if (entry) {
          entry.count += 1;
          entry.r += r;
          entry.g += g;
          entry.b += b;
        } else {
          buckets.set(bucket, { count: 1, r, g, b });
        }
      }

      let best: { count: number; r: number; g: number; b: number } | null = null;
      for (const entry of buckets.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      if (!best) return;
      out[key] =
        `${hex(best.r / best.count)}${hex(best.g / best.count)}${hex(best.b / best.count)}`;
    } catch {
      /* undecodable or tainted */
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(6, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await sampleOne(items[index]!);
    }
  });
  await Promise.all(workers);

  return out;
}

/**
 * Inlines every stylesheet in cascade order, so the output never issues a CSS
 * request. Image URLs in backgrounds, masks and similar properties become
 * placehold.co placeholders; fonts still point at their original URLs.
 */
function renderCss(sheets: StyleSheetSource[], colours: Map<string, string>): string {
  const chunks: string[] = [];
  for (const sheet of sheets) {
    if (!sheet.text.trim()) continue;
    chunks.push(finishSheet(sheet.text, sheet.media, sheet.base, colours));
  }
  return chunks.join('\n');
}

function finishSheet(
  text: string,
  media: string,
  base: string,
  colours: Map<string, string>,
): string {
  let css = stripAtImports(text).replace(/@charset[^;]+;/gi, '');
  css = placeholderImages(absolutizeUrls(css, base), colours);
  return media ? `@media ${media}{\n${css}\n}` : css;
}

/**
 * The in-page half. Must stay self-contained: Playwright serializes this
 * function's source, so it cannot reference anything from the module scope.
 */
function cloneDocument({
  seed,
  colours,
  keepAttrs,
}: {
  seed: number;
  colours: Record<string, string>;
  keepAttrs: string[];
}) {
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
  const rng = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const lorem = (wordCount: number): string => {
    const count = Math.max(1, Math.min(wordCount, 80));
    const words: string[] = [];
    for (let i = 0; i < count; i += 1) {
      words.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    }
    words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
    return `${words.join(' ')}.`;
  };

  const absolute = (url: string): string => {
    if (/^(data:|blob:)/i.test(url)) return url;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  };

  const urlKey = (url: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < url.length; i += 1) {
      hash ^= url.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}-${url.length.toString(36)}`;
  };

  const colourFor = (url: string): string | undefined =>
    colours[urlKey(absolute(url))] ?? colours[urlKey(url)];

  const placeholderUrl = (
    width: number,
    height: number,
    detected?: string,
  ): string => {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const background = detected ?? 'd8d8d8';
    // Same foreground and background keeps placehold.co's default label
    // invisible without relying on an undocumented text override.
    return `https://placehold.co/${w}x${h}/${background}/${background}`;
  };

  const placeholderImages = (css: string): string =>
    css.replace(
      /url\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([^'")]*))\s*\)/gi,
      (
        match,
        single: string | undefined,
        double: string | undefined,
        bare: string | undefined,
      ) => {
        const url = (single ?? double ?? bare ?? '').trim();
        if (/^(#|about:)/i.test(url)) return match;
        return `url("${placeholderUrl(1200, 800, colourFor(url))}")`;
      },
    );

  const placeholderNode = (
    tag: string,
    width: number,
    height: number,
    detected?: string,
  ): HTMLImageElement => {
    const holder = document.createElement('img');
    holder.setAttribute('data-placeholder', tag.toLowerCase());
    holder.setAttribute('src', placeholderUrl(width, height, detected));
    holder.setAttribute('alt', '');
    holder.setAttribute('width', String(Math.max(1, Math.round(width))));
    holder.setAttribute('height', String(Math.max(1, Math.round(height))));
    return holder;
  };

  const clone = document.body.cloneNode(true) as HTMLElement;
  const originals = Array.from(document.body.querySelectorAll('*'));
  const copies = Array.from(clone.querySelectorAll('*'));

  const MEDIA = new Set([
    'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'SVG', 'OBJECT',
    'EMBED',
  ]);
  const DROP = new Set([
    'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'STYLE', 'TITLE', 'BASE',
  ]);
  const STRIP_ATTRS = new Set([
    'href', 'src', 'srcset', 'alt', 'title', 'value', 'placeholder', 'poster',
    'content', 'formaction', 'download', 'target', 'rel', 'ping', 'sizes',
  ]);
  const KEEP_ATTRS = new Set(keepAttrs);

  // Walk backwards so a media node is handled before its own descendants.
  // The clone is detached, so containment (not isConnected) is the right check.
  for (let i = originals.length - 1; i >= 0; i -= 1) {
    const original = originals[i]!;
    const copy = copies[i];
    if (!copy || !clone.contains(copy)) continue;
    const tag = original.tagName.toUpperCase();

    if (DROP.has(tag)) {
      copy.remove();
      continue;
    }

    let placeholderSize: { width: number; height: number } | null = null;
    let placeholderColour: string | undefined;

    if (MEDIA.has(tag)) {
      const style = getComputedStyle(original);
      const rect = original.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) {
        copy.remove();
        continue;
      }
      const width = rect.width || 1;
      const height = rect.height || 1;

      if (tag === 'IMG') {
        // Keep the element so the page's own `img` rules still apply. A broken
        // or still-lazy image has no usable intrinsic size, so fall back to its
        // width/height attributes instead of the collapsed rendered box.
        const image = original as HTMLImageElement;
        const attrWidth = Number.parseFloat(image.getAttribute('width') ?? '');
        const attrHeight = Number.parseFloat(image.getAttribute('height') ?? '');
        const broken = image.complete && image.naturalWidth === 0;
        placeholderSize =
          broken && attrWidth > 0 && attrHeight > 0
            ? { width: attrWidth, height: attrHeight }
            : { width, height };
        const source = image.currentSrc || image.src || image.getAttribute('src') || '';
        placeholderColour = source ? colourFor(source) : undefined;
      } else {
        // Video, iframe, canvas, svg and friends cannot load a placehold.co
        // image as-is, so swap them for an <img> of the same rendered size.
        const source =
          tag === 'VIDEO'
            ? original.getAttribute('poster')
            : tag === 'OBJECT'
              ? original.getAttribute('data')
              : tag === 'EMBED'
                ? original.getAttribute('src')
                : null;
        placeholderColour = source ? colourFor(source) : undefined;
        const holder = placeholderNode(tag, width, height, placeholderColour);
        const declarations = [
          'display:inline-block',
          `width:${width.toFixed(1)}px`,
          `height:${height.toFixed(1)}px`,
          'object-fit:cover',
          'vertical-align:middle',
          'overflow:hidden',
        ];
        if (style.borderRadius && style.borderRadius !== '0px') {
          declarations.push(`border-radius:${style.borderRadius}`);
        }
        if (style.opacity && style.opacity !== '1') {
          declarations.push(`opacity:${style.opacity}`);
        }
        holder.style.cssText = declarations.join(';');
        copy.replaceWith(holder);
        continue;
      }
    }

    for (const attribute of Array.from(copy.attributes)) {
      const name = attribute.name.toLowerCase();

      if (name === 'style') {
        copy.setAttribute('style', placeholderImages(attribute.value));
        continue;
      }

      const stripScoped =
        (name.startsWith('data-') || name.startsWith('aria-')) && !KEEP_ATTRS.has(name);
      if (STRIP_ATTRS.has(name) || name.startsWith('on') || stripScoped) {
        copy.removeAttribute(attribute.name);
      }
    }

    if (placeholderSize) {
      copy.setAttribute(
        'src',
        placeholderUrl(placeholderSize.width, placeholderSize.height, placeholderColour),
      );
      copy.setAttribute('width', String(Math.max(1, Math.round(placeholderSize.width))));
      copy.setAttribute('height', String(Math.max(1, Math.round(placeholderSize.height))));
      copy.setAttribute('alt', '');
      copy.removeAttribute('srcset');
      copy.removeAttribute('sizes');
      copy.removeAttribute('loading');
      copy.removeAttribute('decoding');
    }

    if (tag === 'A') copy.setAttribute('href', '#');
  }

  // Text -> lorem, preserving leading/trailing whitespace for inline layout.
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE']);
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    const parent = node.parentElement;
    if (text.trim() && parent && !SKIP_TEXT.has(parent.tagName.toUpperCase())) {
      if (!parent.closest('[data-placeholder]')) textNodes.push(node as Text);
    }
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? '';
    const lead = (value.match(/^\s*/) ?? [''])[0];
    const trail = (value.match(/\s*$/) ?? [''])[0];
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
    elementCount: clone.querySelectorAll('*').length,
    pageTitle: document.title,
  };
}

type ClonedBody = Awaited<ReturnType<typeof cloneDocument>>;

function assemble(css: string, body: ClonedBody, title: string): string {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  const htmlAttrs = [
    `lang="${escapeAttr(body.lang || 'en')}"`,
    body.htmlClass ? `class="${escapeAttr(body.htmlClass)}"` : '',
    body.dir ? `dir="${escapeAttr(body.dir)}"` : '',
    body.htmlStyle ? `style="${escapeAttr(body.htmlStyle)}"` : '',
  ].filter(Boolean);

  const bodyAttrs = [
    body.idAttr ? `id="${escapeAttr(body.idAttr)}"` : '',
    body.classAttr ? `class="${escapeAttr(body.classAttr)}"` : '',
    body.styleAttr ? `style="${escapeAttr(body.styleAttr)}"` : '',
  ].filter(Boolean);

  return `<!doctype html>
<html ${htmlAttrs.join(' ')}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<style>
${safeCss}
</style>
</head>
<body${bodyAttrs.length ? ` ${bodyAttrs.join(' ')}` : ''}>
${body.html}
</body>
</html>
`;
}

function absolutizeUrls(css: string, base: string | null): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, url: string) => {
    if (/^(data:|blob:|#|about:)/i.test(url)) return match;
    try {
      return `url("${new URL(url, base ?? undefined).href}")`;
    } catch {
      return match;
    }
  });
}

/**
 * Rewrites every image `url()` reference (backgrounds, masks, border images,
 * data URIs, etc.) to a placehold.co image. `@font-face` blocks are shielded so
 * webfonts keep loading from their original host.
 */
function placeholderImages(
  css: string,
  colours: Map<string, string>,
): string {
  const fontFaces: string[] = [];
  const shielded = css.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    fontFaces.push(block);
    return `/*__font-face:${fontFaces.length - 1}__*/`;
  });

  const replaced = shielded.replace(
    /url\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([^'")]*))\s*\)/gi,
    (
      match,
      single: string | undefined,
      double: string | undefined,
      bare: string | undefined,
    ) => {
      const url = (single ?? double ?? bare ?? '').trim();
      if (/^(#|about:)/i.test(url)) return match;
      const detected = colours.get(urlKey(url)) ?? colours.get(urlKey(canonicalUrl(url)));
      return `url("${placeholderUrl(1200, 800, detected)}")`;
    },
  );

  return replaced.replace(
    /\/\*__font-face:(\d+)__\*\//g,
    (_match, index: string) => fontFaces[Number(index)]!,
  );
}

function placeholderUrl(
  width: number,
  height: number,
  detected?: string,
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const background = detected ?? FALLBACK_BACKGROUND;
  return `https://placehold.co/${w}x${h}/${background}/${background}`;
}

function stripAtImports(css: string): string {
  return css.replace(/@import[^;]+;/gi, '');
}

function escapeAttr(value: string): string {
  return String(value).replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] as string,
  );
}
