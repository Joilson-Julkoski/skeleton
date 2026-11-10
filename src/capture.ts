import { chromium, type Page } from 'playwright';
import type { RawNode, RawPage } from './types.js';

export interface CaptureOptions {
  url: string;
  viewport: { width: number; height: number };
  timeoutMs?: number;
}

/**
 * Loads the page in headless Chromium and returns a serializable snapshot of
 * the rendered DOM: geometry plus a curated subset of computed styles.
 *
 * We deliberately read *computed* styles instead of the raw stylesheets: the
 * browser has already resolved inheritance, cascade and layout for us.
 */
export async function capture(options: CaptureOptions): Promise<RawPage> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage({ viewport: options.viewport });
    const timeout = options.timeoutMs ?? 60_000;
    page.setDefaultTimeout(timeout);

    await page.goto(options.url, { waitUntil: 'load', timeout });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });

    await autoScroll(page);
    await page.waitForTimeout(500);

    return await page.evaluate(extractInPage);
  } finally {
    await browser.close();
  }
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

/**
 * Runs inside the browser. Must stay self-contained: Playwright serializes this
 * function's source, so it cannot reference anything from the Node module scope.
 */
function extractInPage(): RawPage {
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD',
    'TITLE', 'BASE', 'BR', 'SOURCE', 'TRACK',
  ]);

  // Elements that never break the text flow, so a block full of them can
  // collapse into a single text node instead of becoming dozens of boxes.
  const INLINE = new Set([
    'SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SMALL', 'CODE', 'MARK',
    'SUB', 'SUP', 'DEL', 'INS', 'ABBR', 'TIME', 'LABEL', 'KBD', 'Q', 'CITE',
    'VAR', 'WBR',
  ]);

  const MEDIA = new Set([
    'IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'SVG', 'OBJECT', 'EMBED',
  ]);

  function styleOf(el: Element) {
    const cs = window.getComputedStyle(el);
    return {
      display: cs.display,
      position: cs.position,
      flexDirection: cs.flexDirection,
      flexWrap: cs.flexWrap,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      gap: cs.gap,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      maxWidth: cs.maxWidth,
      marginTop: cs.marginTop,
      marginRight: cs.marginRight,
      marginBottom: cs.marginBottom,
      marginLeft: cs.marginLeft,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      borderTopWidth: cs.borderTopWidth,
      borderRightWidth: cs.borderRightWidth,
      borderBottomWidth: cs.borderBottomWidth,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopStyle: cs.borderTopStyle,
      borderRightStyle: cs.borderRightStyle,
      borderBottomStyle: cs.borderBottomStyle,
      borderLeftStyle: cs.borderLeftStyle,
      borderTopColor: cs.borderTopColor,
      borderRightColor: cs.borderRightColor,
      borderBottomColor: cs.borderBottomColor,
      borderLeftColor: cs.borderLeftColor,
      borderRadius: cs.borderRadius,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      textTransform: cs.textTransform,
      boxShadow: cs.boxShadow,
      opacity: cs.opacity,
    };
  }

  function rectOf(el: Element) {
    const box = el.getBoundingClientRect();
    return {
      x: box.left + window.scrollX,
      y: box.top + window.scrollY,
      width: box.width,
      height: box.height,
    };
  }

  function mapMedia(tag: string): RawNode['media'] {
    switch (tag) {
      case 'IMG':
      case 'PICTURE':
        return 'img';
      case 'SVG':
        return 'svg';
      case 'VIDEO':
        return 'video';
      case 'CANVAS':
        return 'canvas';
      default:
        return 'iframe';
    }
  }

  function directText(el: Element): string {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) out += node.textContent ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function isTextFirst(el: Element): boolean {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && (node.textContent ?? '').trim()) return true;
      if (
        node.nodeType === 1 &&
        !SKIP.has((node as Element).tagName.toUpperCase())
      ) {
        return false;
      }
    }
    return false;
  }

  /**
   * When we collapse a block of inline content into one text node, the
   * container's color is often not the color of the text. HN's header, for
   * example, is black links inside a gray cell. Pick the color that covers the
   * most characters so the collapsed text keeps the dominant visual color.
   */
  function dominantTextColor(el: Element, fallback: string): string {
    const counts = new Map<string, number>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (text && parent) {
        const color = window.getComputedStyle(parent).color;
        counts.set(color, (counts.get(color) ?? 0) + text.length);
      }
      node = walker.nextNode();
    }

    let best = fallback;
    let bestCount = 0;
    for (const [color, count] of counts) {
      if (count > bestCount) {
        best = color;
        bestCount = count;
      }
    }
    return best;
  }

  function walk(el: Element): RawNode | null {
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return null;

    const colspan = el.getAttribute('colspan') ?? undefined;
    const rowspan = el.getAttribute('rowspan') ?? undefined;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
      return null;
    }

    const rect = rectOf(el);
    if (rect.width < 1 || rect.height < 1) return null;

    // Media never needs its internals; treat the whole thing as one opaque box.
    if (MEDIA.has(tag)) {
      return {
        tag, rect, style: styleOf(el), text: '', textFirst: false,
        colspan, rowspan, media: mapMedia(tag), children: [],
      };
    }

    const backgroundImage = cs.backgroundImage || 'none';
    const hasUrlBackground = /url\(/i.test(backgroundImage);

    const childEls = Array.from(el.children).filter(
      (child) => !SKIP.has(child.tagName.toUpperCase()),
    );
    const hasBlockChild = childEls.some(
      (child) => !INLINE.has(child.tagName.toUpperCase()),
    );
    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const isFlexOrGrid =
      cs.display === 'flex' || cs.display === 'inline-flex' ||
      cs.display === 'grid' || cs.display === 'inline-grid';

    // Collapse a block of inline content into a single text node. Flex/grid
    // containers are kept intact because their child layout is meaningful.
    if (!hasBlockChild && !isFlexOrGrid && textContent.length > 0) {
      const inner = ((el as HTMLElement).innerText ?? el.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const style = styleOf(el);
      style.color = dominantTextColor(el, style.color);
      return {
        tag, rect, style, text: inner, textFirst: false,
        colspan, rowspan, media: null, children: [],
      };
    }

    const children: RawNode[] = [];
    for (const child of childEls) {
      const node = walk(child);
      if (node) children.push(node);
    }

    let media: RawNode['media'] = null;
    if (hasUrlBackground && children.length === 0) media = 'bg';

    return {
      tag, rect, style: styleOf(el), text: directText(el), textFirst: isTextFirst(el),
      colspan, rowspan, media, children,
    };
  }

  const root = walk(document.body);
  const htmlStyle = window.getComputedStyle(document.documentElement);
  const isTransparent = (value: string | undefined) =>
    !value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)';

  const bodyBackground = root?.style.backgroundColor;
  const pageBackground =
    bodyBackground && !isTransparent(bodyBackground)
      ? bodyBackground
      : htmlStyle.backgroundColor;
  const resolvedBackground = isTransparent(pageBackground)
    ? 'rgb(255, 255, 255)'
    : pageBackground;

  return {
    root: root as RawNode,
    pageBackground: resolvedBackground,
    title: document.title || 'Anonymized layout',
  };
}
