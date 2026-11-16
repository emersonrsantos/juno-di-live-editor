// Panel tree construction. <panelType> definitions are templates; each <panel> instance
// passes its leaf children as $variables, which also flow down to nested panels.

import { XNode, child, childText, childrenOf, parsePoint, subst, substNode, Vars, varsOf } from '../script/xnode';
import { compileExpr, ExprFn } from '../model/expr';
import type { Control } from './controls';

export interface PanelNode {
  kind: 'panel';
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bitmap?: string;
  cond?: ExprFn;
  condSrc?: string;
  items: (PanelNode | Control)[];
  modal: boolean;
  windowPosition?: [number, number];
}

const NOT_INHERITED = new Set(['type', 'position', 'size', 'windowPosition', 'openCondition', 'bitmapRef', 'modal']);

export type ControlFactory = (def: XNode, panel: PanelNode) => Control | undefined;

export class PanelBuilder {
  private types = new Map<string, XNode>();
  missing = new Set<string>();

  constructor(
    script: XNode,
    private makeControl: ControlFactory,
  ) {
    for (const p of childrenOf(script, 'panelType')) this.types.set(childText(p, 'type')!, p);
  }

  build(inst: XNode, parentVars: Vars = {}): PanelNode | undefined {
    const inherited: Vars = {};
    for (const k in parentVars) if (!NOT_INHERITED.has(k)) inherited[k] = parentVars[k];
    const vars = varsOf(inst, inherited);
    const typeName = vars.type;
    const tpl = this.types.get(typeName);
    if (!tpl) {
      this.missing.add(typeName);
      return undefined;
    }
    const pt = substNode(tpl, vars);
    const pos = parsePoint(vars.position) ?? parsePoint(childText(pt, 'position')) ?? [0, 0];
    const size = parsePoint(childText(pt, 'size')) ?? parsePoint(vars.size) ?? [0, 0];
    const conds = [childText(pt, 'openCondition'), vars.openCondition].filter(
      (c): c is string => !!c && !c.includes('$'),
    );
    const uniq = [...new Set(conds.map((c) => c.replace(/\s+/g, '')))];
    const condSrc = uniq.length === 0 ? undefined : uniq.length === 1 ? uniq[0] : `${uniq[0]},${uniq[1]},&&`;
    const bitmap = vars.bitmapRef ?? childText(pt, 'bitmapRef');
    const node: PanelNode = {
      kind: 'panel',
      type: typeName,
      name: vars.name ?? childText(pt, 'name') ?? typeName,
      x: pos[0],
      y: pos[1],
      w: size[0],
      h: size[1],
      bitmap: bitmap && !bitmap.includes('$') ? bitmap : undefined,
      cond: condSrc ? compileExpr(condSrc) : undefined,
      condSrc,
      items: [],
      modal: childText(pt, 'modal') === '1',
      windowPosition: parsePoint(vars.windowPosition ?? childText(pt, 'windowPosition')),
    };
    for (const c of pt.children) {
      if (c.tag === 'panel') {
        const p = this.build(c, vars);
        if (p) node.items.push(p);
      } else if (c.tag === 'control') {
        const ctl = this.makeControl(c, node);
        if (ctl) node.items.push(ctl);
      }
    }
    return node;
  }
}

export { child, subst };
