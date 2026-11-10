export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StyleSubset {
  display: string;
  position: string;
  flexDirection: string;
  flexWrap: string;
  justifyContent: string;
  alignItems: string;
  gap: string;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  maxWidth: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  borderTopStyle: string;
  borderRightStyle: string;
  borderBottomStyle: string;
  borderLeftStyle: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderRadius: string;
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textTransform: string;
  boxShadow: string;
  opacity: string;
}

export type MediaKind = 'img' | 'svg' | 'video' | 'canvas' | 'iframe' | 'bg';

/** A serializable snapshot of one element, captured inside the browser. */
export interface RawNode {
  tag: string;
  rect: Rect;
  style: StyleSubset;
  /** Text owned directly by this element (not descendants). */
  text: string;
  /** True when the first meaningful child node is a text node. */
  textFirst: boolean;
  /** Table cell span attributes, when present. */
  colspan?: string;
  rowspan?: string;
  media: MediaKind | null;
  children: RawNode[];
}

export interface RawPage {
  root: RawNode;
  pageBackground: string;
  title: string;
}

export type Role = 'container' | 'text' | 'media' | 'control' | 'decoration';

/** The anonymized tree that gets emitted as HTML + CSS. */
export interface LayoutNode {
  id: number;
  tag: string;
  role: Role;
  rect: Rect;
  style: StyleSubset;
  text: string;
  /** Table cell span attributes, when present. */
  colspan?: string;
  rowspan?: string;
  media: MediaKind | null;
  children: LayoutNode[];
}
