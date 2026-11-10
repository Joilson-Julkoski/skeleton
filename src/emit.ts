import type { LayoutNode, StyleSubset } from './types.js';
import { clamp, escapeHtml, isNonZero } from './util.js';

export interface EmitOptions {
  title: string;
  background: string;
}

const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'li', 'dt', 'dd',
  'blockquote', 'figcaption', 'code', 'pre', 'td', 'th',
]);

const CONTAINER_TAGS = new Set([
  'header', 'nav', 'main', 'footer', 'aside', 'section', 'article', 'div',
  'ul', 'ol', 'li', 'form', 'figure', 'table', 'thead', 'tbody', 'tr', 'td',
  'th', 'dl', 'dt', 'dd', 'blockquote', 'pre',
]);

// Text inside these is content-sized even when it is blockified by flex layout.
const INLINE_TEXT_TAGS = new Set([
  'A', 'BUTTON', 'SPAN', 'LABEL', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'CODE',
  'TIME', 'ABBR',
]);

// Table cells and rows are sized by the table algorithm, not by our heuristics.
const TABLE_PARTS = new Set([
  'td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col',
]);

const TABLE_FULL = new Set([...TABLE_PARTS, 'table']);

/**
 * Emits a single self-contained HTML file: no external CSS, no scripts, no
 * assets. The result is a responsive, flow-based layout skeleton.
 */
export function emitHtml(root: LayoutNode, options: EmitOptions): string {
  const rules: string[] = [];
  rules.push(cssFor(root, 'body', undefined));

  const bodyContent = root.children
    .map((child) => renderNode(child, rules, root))
    .join('\n');

  const mobile = mobileRules(root);
  if (mobile) rules.push(mobile);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{background:${options.background};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111}
ul,ol{list-style:none}
a{color:inherit;text-decoration:none}
${rules.join('\n')}
</style>
</head>
<body>
${bodyContent}
</body>
</html>
`;
}

function renderNode(node: LayoutNode, rules: string[], parent: LayoutNode): string {
  const tag = outputTag(node);
  const className = `n-${node.id}`;
  const tagName = node.tag.toLowerCase();
  const attrs = [`class="${className}"`];

  if (tagName === 'td' || tagName === 'th') {
    if (node.colspan) attrs.push(`colspan="${escapeHtml(node.colspan)}"`);
    if (node.rowspan) attrs.push(`rowspan="${escapeHtml(node.rowspan)}"`);
  }

  const attrString = attrs.join(' ');
  rules.push(cssFor(node, `.${className}`, parent));

  if (node.role === 'text') {
    return `<${tag} ${attrString}>${escapeHtml(node.text)}</${tag}>`;
  }

  if (node.role === 'media' || node.role === 'control' || node.role === 'decoration') {
    return `<${tag} ${attrString}></${tag}>`;
  }

  const children = node.children
    .map((child) => renderNode(child, rules, node))
    .join('\n');
  return `<${tag} ${attrString}>\n${children}\n</${tag}>`;
}

function outputTag(node: LayoutNode): string {
  if (node.role === 'media' || node.role === 'control') return 'div';

  const tag = node.tag.toLowerCase();

  if (node.role === 'decoration') {
    if (TABLE_FULL.has(tag)) return tag;
    return 'div';
  }

  if (node.role === 'text') {
    // A dead anchor is worse than a span for a mock.
    if (tag === 'a') return 'span';
    if (TEXT_TAGS.has(tag)) return tag;
    return 'p';
  }

  if (CONTAINER_TAGS.has(tag)) return tag;
  return 'div';
}

interface ResponsivePlan {
  flex: string[];
  grid: string[];
  flexChildren: string[];
}

/**
 * A conservative mobile fallback. Real breakpoints should eventually be
 * inferred from the source (see TODO), but this keeps the output usable on
 * narrow screens: columns stack, flex rows wrap, and grid tracks collapse.
 */
function mobileRules(root: LayoutNode): string {
  const plan: ResponsivePlan = { flex: [], grid: [], flexChildren: [] };
  collectResponsive(root, 'body', undefined, plan);

  const blocks: string[] = [];
  if (plan.flex.length > 0) {
    blocks.push(`${plan.flex.join(',')}{flex-wrap:wrap}`);
  }
  if (plan.grid.length > 0) {
    blocks.push(`${plan.grid.join(',')}{grid-template-columns:1fr}`);
  }
  if (plan.flexChildren.length > 0) {
    blocks.push(`${plan.flexChildren.join(',')}{flex:0 0 auto;width:100%}`);
  }

  if (blocks.length === 0) return '';
  return `@media (max-width:900px){${blocks.join('')}}`;
}

function collectResponsive(
  node: LayoutNode,
  selector: string,
  parent: LayoutNode | undefined,
  plan: ResponsivePlan,
): void {
  if (node.role === 'container') {
    if (isFlexContainer(node.style)) plan.flex.push(selector);
    if (isGridContainer(node.style)) plan.grid.push(selector);
  }

  if (parent && isFlexContainer(parent.style)) {
    const smallBox = node.rect.width <= 64 && node.rect.height <= 64;
    if (!smallBox) plan.flexChildren.push(selector);
  }

  for (const child of node.children) {
    collectResponsive(child, `.n-${child.id}`, node, plan);
  }
}

function cssFor(node: LayoutNode, selector: string, parent: LayoutNode | undefined): string {
  const style = node.style;
  const decls: string[] = [];

  const flexParent = parent ? isFlexContainer(parent.style) : false;
  const gridParent = parent ? isGridContainer(parent.style) : false;
  const blockParent = parent ? !flexParent && !gridParent : false;
  const smallBox = node.rect.width <= 64 && node.rect.height <= 64;
  const tagName = node.tag.toLowerCase();
  const tablePart = TABLE_PARTS.has(tagName);
  const tableElement = tagName === 'table';

  if (node.role === 'container') {
    const display = resolvedDisplay(style.display);
    decls.push(`display:${display}`);

    if (display === 'flex') {
      if (style.flexDirection && style.flexDirection !== 'row') {
        decls.push(`flex-direction:${style.flexDirection}`);
      }
      if (style.flexWrap && style.flexWrap !== 'nowrap') {
        decls.push(`flex-wrap:${style.flexWrap}`);
      }
      if (style.justifyContent && style.justifyContent !== 'normal') {
        decls.push(`justify-content:${style.justifyContent}`);
      }
      if (style.alignItems && style.alignItems !== 'normal') {
        decls.push(`align-items:${style.alignItems}`);
      }
      if (isNonZero(style.gap)) decls.push(`gap:${style.gap}`);
    } else if (display === 'grid') {
      decls.push(`grid-template-columns:${inferGridColumns(node)}`);
      if (isNonZero(style.gap)) decls.push(`gap:${style.gap}`);
      if (style.alignItems && style.alignItems !== 'normal') {
        decls.push(`align-items:${style.alignItems}`);
      }
    }

    // Tables shrink-to-fit instead of filling like a block, so they need an
    // explicit width. Preserve the measured proportion of the parent.
    if (display === 'table' && parent) {
      const parentContent = parent.rect.width - horizontalPadding(parent.style);
      const ratio = parentContent > 0 ? (node.rect.width / parentContent) * 100 : 100;
      decls.push(`width:${clamp(ratio, 1, 100).toFixed(2)}%`);
    }

    // Keep inherited alignment (also preserves the legacy <center> behaviour).
    if (style.textAlign && style.textAlign !== 'start' && style.textAlign !== 'left') {
      decls.push(`text-align:${style.textAlign}`);
    }

    addSpacing(decls, style);
    addPaint(decls, style);

    // Icon wrappers and similar small boxes need an explicit size, otherwise
    // they collapse once their fixed height is dropped.
    if (
      smallBox &&
      !tablePart &&
      !tableElement &&
      !node.children.some((child) => child.role === 'text')
    ) {
      decls.push(`width:${Math.round(node.rect.width)}px`);
      decls.push(`height:${Math.round(node.rect.height)}px`);
    }
  } else if (node.role === 'text') {
    const display = resolvedDisplay(style.display);
    decls.push(`display:${display}`);
    if (display === 'flex') {
      if (style.justifyContent && style.justifyContent !== 'normal') {
        decls.push(`justify-content:${style.justifyContent}`);
      }
      if (style.alignItems && style.alignItems !== 'normal') {
        decls.push(`align-items:${style.alignItems}`);
      }
    }
    addTypography(decls, style);
    addSpacing(decls, style);
    addPaint(decls, style);
  } else if (node.role === 'media') {
    addMediaBox(decls, node);
    addSpacing(decls, style);
  } else if (node.role === 'control') {
    decls.push('border:1px solid #c4c4c4');
    decls.push('background:#f2f2f2');
    decls.push(`min-height:${Math.max(16, Math.round(node.rect.height))}px`);
    if (style.borderRadius && style.borderRadius !== '0px') {
      decls.push(`border-radius:${style.borderRadius}`);
    }
    addSpacing(decls, style);
  } else {
    addSpacing(decls, style);
    addPaint(decls, style);

    if (!tablePart && !tableElement) {
      if (smallBox) {
        decls.push(`width:${Math.max(4, Math.round(node.rect.width))}px`);
        decls.push(`height:${Math.max(4, Math.round(node.rect.height))}px`);
      } else if (node.rect.width >= 24 && node.rect.height >= 24) {
        decls.push(
          `aspect-ratio:${Math.round(node.rect.width)} / ${Math.round(node.rect.height)}`,
        );
      } else if (node.rect.height > 0) {
        decls.push(`min-height:${Math.round(node.rect.height)}px`);
      }
    }
  }

  // Honor an explicit max-width from the source; it is the correct signal for
  // constrained/centered content and survives reflow.
  if (!tablePart && style.maxWidth && style.maxWidth !== 'none') {
    decls.push(`max-width:${style.maxWidth}`);
  }

  // Flow sizing for flex children: keep the measured proportion, but as a
  // percentage basis so the result reflows instead of freezing at capture size.
  // Inline-ish text (links, buttons, labels) should size to its content instead.
  const inlineText = node.role === 'text' && INLINE_TEXT_TAGS.has(node.tag.toUpperCase());
  if (flexParent && parent && !smallBox && !inlineText && !tablePart) {
    const direction = parent.style.flexDirection || 'row';

    if (direction.startsWith('column')) {
      decls.push('width:100%');
    } else {
      const contentWidth = parent.rect.width - horizontalPadding(parent.style);
      const ratio = contentWidth > 0 ? (node.rect.width / contentWidth) * 100 : 100;
      decls.push(`flex:0 1 ${clamp(ratio, 2, 100).toFixed(2)}%`);
      decls.push('min-width:0');
    }
  }

  // A block child that was narrower than its parent was probably a constrained
  // (often centered) container. Preserve that with max-width instead of a
  // fixed width, so it can still shrink on small screens.
  if (
    blockParent &&
    parent &&
    node.role === 'container' &&
    !tablePart &&
    !tableElement
  ) {
    const contentWidth = parent.rect.width - horizontalPadding(parent.style);
    if (contentWidth > 0 && node.rect.width < contentWidth * 0.95) {
      if (!style.maxWidth || style.maxWidth === 'none') {
        decls.push(`max-width:${Math.round(node.rect.width)}px`);
      }

      const marginLeft = Number.parseFloat(style.marginLeft);
      const marginRight = Number.parseFloat(style.marginRight);
      const parentPaddingLeft = Number.parseFloat(parent.style.paddingLeft) || 0;
      const offset = node.rect.x - parent.rect.x - parentPaddingLeft;
      if (
        Number.isFinite(marginLeft) &&
        Number.isFinite(marginRight) &&
        marginLeft > 0 &&
        Math.abs(marginLeft - marginRight) <= 2 &&
        Math.abs(offset - marginLeft) <= 4
      ) {
        decls.push('margin-left:auto');
        decls.push('margin-right:auto');
      }
    }
  }

  return `${selector}{${decls.join(';')}}`;
}

function addMediaBox(decls: string[], node: LayoutNode): void {
  decls.push('background:#d9d9d9');

  const { width, height } = node.rect;
  if (width <= 64 && height <= 64) {
    decls.push(`width:${Math.max(4, Math.round(width))}px`);
    decls.push(`height:${Math.max(4, Math.round(height))}px`);
  } else {
    decls.push('width:100%');
    decls.push(`aspect-ratio:${Math.max(1, Math.round(width))} / ${Math.max(1, Math.round(height))}`);
  }

  if (node.style.borderRadius && node.style.borderRadius !== '0px') {
    decls.push(`border-radius:${node.style.borderRadius}`);
  }
}

function addSpacing(decls: string[], style: StyleSubset): void {
  const padding = [
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft,
  ];
  if (padding.some(isNonZero)) decls.push(`padding:${padding.join(' ')}`);

  const margin = [
    style.marginTop,
    style.marginRight,
    style.marginBottom,
    style.marginLeft,
  ];
  if (margin.some(isNonZero)) decls.push(`margin:${margin.join(' ')}`);
}

function addPaint(decls: string[], style: StyleSubset): void {
  if (
    style.backgroundColor &&
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
    style.backgroundColor !== 'transparent'
  ) {
    decls.push(`background-color:${style.backgroundColor}`);
  }

  if (
    style.backgroundImage &&
    /gradient\(/i.test(style.backgroundImage) &&
    !/url\(/i.test(style.backgroundImage)
  ) {
    decls.push(`background-image:${style.backgroundImage}`);
  }

  const borders: Array<[string, string, string, string]> = [
    ['top', style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
    ['right', style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
    ['bottom', style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
    ['left', style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
  ];
  for (const [side, width, borderStyle, color] of borders) {
    if (isNonZero(width)) {
      decls.push(`border-${side}:${width} ${borderStyle} ${color}`);
    }
  }

  if (style.borderRadius && style.borderRadius !== '0px') {
    decls.push(`border-radius:${style.borderRadius}`);
  }
  if (style.boxShadow && style.boxShadow !== 'none') {
    decls.push(`box-shadow:${style.boxShadow}`);
  }
  if (style.opacity && style.opacity !== '1') {
    decls.push(`opacity:${style.opacity}`);
  }
}

function addTypography(decls: string[], style: StyleSubset): void {
  if (style.fontFamily) decls.push(`font-family:${style.fontFamily}`);
  if (style.fontSize) decls.push(`font-size:${style.fontSize}`);
  if (style.fontWeight && style.fontWeight !== '400' && style.fontWeight !== 'normal') {
    decls.push(`font-weight:${style.fontWeight}`);
  }
  if (style.fontStyle && style.fontStyle !== 'normal') {
    decls.push(`font-style:${style.fontStyle}`);
  }
  if (style.lineHeight && style.lineHeight !== 'normal') {
    decls.push(`line-height:${style.lineHeight}`);
  }
  if (
    style.letterSpacing &&
    style.letterSpacing !== 'normal' &&
    style.letterSpacing !== '0px'
  ) {
    decls.push(`letter-spacing:${style.letterSpacing}`);
  }
  if (style.textAlign && style.textAlign !== 'start' && style.textAlign !== 'left') {
    decls.push(`text-align:${style.textAlign}`);
  }
  if (style.textTransform && style.textTransform !== 'none') {
    decls.push(`text-transform:${style.textTransform}`);
  }
  decls.push(`color:${style.color || '#111111'}`);
}

function inferGridColumns(node: LayoutNode): string {
  const children = node.children;
  if (children.length === 0) return '1fr';

  const columns: number[] = [];
  for (const child of children) {
    if (!columns.some((x) => Math.abs(x - child.rect.x) < 8)) {
      columns.push(child.rect.x);
    }
  }

  const count = clamp(columns.length, 1, 12);
  return `repeat(${count}, minmax(0, 1fr))`;
}

function horizontalPadding(style: StyleSubset): number {
  return (Number.parseFloat(style.paddingLeft) || 0) +
    (Number.parseFloat(style.paddingRight) || 0);
}

function isFlexContainer(style: StyleSubset): boolean {
  return style.display === 'flex' || style.display === 'inline-flex';
}

function isGridContainer(style: StyleSubset): boolean {
  return style.display === 'grid' || style.display === 'inline-grid';
}

function resolvedDisplay(display: string): string {
  if (display === 'flex' || display === 'inline-flex') return 'flex';
  if (display === 'grid' || display === 'inline-grid') return 'grid';
  if (display === 'inline-block') return 'inline-block';
  if (display.startsWith('table')) return display;
  return 'block';
}
