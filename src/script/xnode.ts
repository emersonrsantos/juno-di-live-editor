// Lightweight immutable XML tree used for all script definitions.
// Script.xml is a template language: `$var` placeholders inside any element text are
// replaced by values supplied by the instantiating element (struct / panel instance).

export interface XNode {
  tag: string;
  text: string; // trimmed text for leaf elements, '' otherwise
  children: XNode[];
}

export function fromDom(el: Element): XNode {
  const children: XNode[] = [];
  let text = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) children.push(fromDom(n as Element));
    else if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue ?? '';
  }
  return { tag: el.tagName, text: children.length ? '' : text.trim(), children };
}

export function child(n: XNode, tag: string): XNode | undefined {
  return n.children.find((c) => c.tag === tag);
}

export function childText(n: XNode, tag: string): string | undefined {
  return child(n, tag)?.text;
}

export function childrenOf(n: XNode, tag: string): XNode[] {
  return n.children.filter((c) => c.tag === tag);
}

export type Vars = Record<string, string>;

const VAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function subst(s: string, vars: Vars): string {
  if (s.indexOf('$') < 0) return s;
  return s.replace(VAR_RE, (m, name: string) => (name in vars ? vars[name] : m));
}

/** Deep copy with variable substitution applied to every text node. */
export function substNode(n: XNode, vars: Vars): XNode {
  return {
    tag: n.tag,
    text: subst(n.text, vars),
    children: n.children.map((c) => substNode(c, vars)),
  };
}

/** Leaf children of an instance element become template variables. */
export function varsOf(n: XNode, base: Vars = {}): Vars {
  const v: Vars = { ...base };
  for (const c of n.children) if (!c.children.length) v[c.tag] = subst(c.text, base);
  return v;
}

export function parsePoint(s: string | undefined): [number, number] | undefined {
  if (!s) return undefined;
  const p = s.split(',').map((x) => parseInt(x.trim(), 10));
  if (p.length < 2 || p.some((x) => isNaN(x))) return undefined;
  return [p[0], p[1]];
}
