// Client-side place tree. A household has at most a few hundred places, so we load them all in one
// query and derive children, ancestors and counts here instead of a round trip per level.

export interface TreeNode {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
}

export interface Tree<T extends TreeNode> {
  byId: Map<string, T>;
  /** key '' = top level */
  children: Map<string, T[]>;
}

const byOrder = (a: TreeNode, b: TreeNode) =>
  a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export function buildTree<T extends TreeNode>(rows: T[]): Tree<T> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, T[]>();
  for (const r of rows) {
    // A parent we can't see (shouldn't happen under RLS) → show it at the top rather than lose it.
    const key = r.parent_id && byId.has(r.parent_id) ? r.parent_id : '';
    const list = children.get(key);
    if (list) list.push(r);
    else children.set(key, [r]);
  }
  for (const list of children.values()) list.sort(byOrder);
  return { byId, children };
}

export function childrenOf<T extends TreeNode>(tree: Tree<T>, id: string | null): T[] {
  return tree.children.get(id ?? '') ?? [];
}

/** Root → … → parent (excludes the node itself). */
export function ancestors<T extends TreeNode>(tree: Tree<T>, id: string): T[] {
  const out: T[] = [];
  const seen = new Set<string>([id]);
  let cur = tree.byId.get(id)?.parent_id ?? null;
  while (cur && !seen.has(cur)) {
    const node = tree.byId.get(cur);
    if (!node) break;
    out.unshift(node);
    seen.add(cur);
    cur = node.parent_id;
  }
  return out;
}

/** Every place inside `id`, depth-first in display order (excludes `id`). */
export function descendants<T extends TreeNode>(tree: Tree<T>, id: string): T[] {
  const out: T[] = [];
  const stack = [...childrenOf(tree, id)].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    stack.push(...[...childrenOf(tree, n.id)].reverse());
  }
  return out;
}

/** Places a node may move into: anything except itself and its own descendants. */
export function moveTargets<T extends TreeNode>(tree: Tree<T>, id: string): T[] {
  const blocked = new Set([id, ...descendants(tree, id).map((d) => d.id)]);
  return [...tree.byId.values()].filter((n) => !blocked.has(n.id));
}
