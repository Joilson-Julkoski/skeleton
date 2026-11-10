import type { LayoutNode, RawNode, Role, StyleSubset } from './types.js';
import { loremFor, type Rng } from './lorem.js';
import { isNonZero } from './util.js';

const CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);

// These are structural even when empty: a bare <td> can be a spacer that keeps
// the following cell in the right table column.
const TABLE_STRUCT = new Set([
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
]);

/**
 * Turns the raw browser snapshot into the anonymized layout tree:
 * classifies nodes, generates lorem, and drops invisible noise.
 */
export function buildLayout(raw: RawNode, rng: Rng): LayoutNode {
  const root = build(raw, rng);
  if (!root) throw new Error('The page produced an empty layout.');

  let nextId = 0;
  const assignIds = (node: LayoutNode): void => {
    node.id = nextId;
    nextId += 1;
    for (const child of node.children) assignIds(child);
  };
  assignIds(root);

  return root;
}

function build(raw: RawNode, rng: Rng): LayoutNode | null {
  const role = classify(raw);

  if (
    role === 'decoration' &&
    !hasPaint(raw.style) &&
    !TABLE_STRUCT.has(raw.tag)
  ) {
    return null;
  }

  const children: LayoutNode[] = [];
  for (const child of raw.children) {
    const built = build(child, rng);
    if (built) children.push(built);
  }

  // Mixed nodes (text + element children) need a synthetic text child so the
  // direct text is not silently dropped. Respect document order.
  if (role === 'container' && raw.text) {
    const fontSize = Number.parseFloat(raw.style.fontSize) || 16;
    const textNode: LayoutNode = {
      id: 0,
      tag: 'SPAN',
      role: 'text',
      rect: {
        x: raw.rect.x,
        y: raw.rect.y,
        width: raw.rect.width,
        height: fontSize * 1.5,
      },
      style: { ...raw.style, display: 'block' },
      text: loremFor(raw.text, rng),
      media: null,
      children: [],
    };
    if (raw.textFirst) children.unshift(textNode);
    else children.push(textNode);
  }

  return {
    id: 0,
    tag: raw.tag,
    role,
    rect: raw.rect,
    style: raw.style,
    text: role === 'text' ? loremFor(raw.text, rng) : '',
    colspan: raw.colspan,
    rowspan: raw.rowspan,
    media: raw.media,
    children,
  };
}

function classify(raw: RawNode): Role {
  if (raw.media) return 'media';
  if (CONTROLS.has(raw.tag)) return 'control';
  if (raw.children.length > 0) return 'container';
  if (raw.text) return 'text';
  return 'decoration';
}

function hasPaint(style: StyleSubset): boolean {
  const background = style.backgroundColor;
  const hasBackground =
    Boolean(background) &&
    background !== 'rgba(0, 0, 0, 0)' &&
    background !== 'transparent';
  const hasGradient = /gradient\(/i.test(style.backgroundImage || '');
  const hasBorder = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ].some(isNonZero);
  const hasShadow = Boolean(style.boxShadow) && style.boxShadow !== 'none';

  return hasBackground || hasGradient || hasBorder || hasShadow;
}
