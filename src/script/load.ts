import { XNode, fromDom } from './xnode';

/** Script.xml is Shift_JIS encoded; decode before handing it to an XML parser. */
export function decodeScript(buf: ArrayBuffer): string {
  const text = new TextDecoder('shift_jis').decode(buf);
  return text.replace(/encoding="Shift_JIS"/i, 'encoding="UTF-8"');
}

export function parseScript(text: string, parser: { parseFromString(s: string, t: string): Document }): XNode {
  const doc = parser.parseFromString(text, 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'script') throw new Error('Not a JUXE script file');
  return fromDom(root);
}

export async function fetchScript(url: string): Promise<XNode> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return parseScript(decodeScript(await res.arrayBuffer()), new DOMParser());
}

/**
 * Append the definitions of an extra script (same <script> format as Script.xml, e.g. the
 * bundled JUNO-Di wave name table) to the main script, so they are found like built-ins.
 */
export function mergeScripts(base: XNode, ...extras: XNode[]): XNode {
  return { ...base, children: [...base.children, ...extras.flatMap((e) => e.children)] };
}
