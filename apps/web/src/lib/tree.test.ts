import { describe, expect, it } from 'vitest';
import { ancestors, buildTree, childrenOf, descendants, moveTargets } from './tree';

const n = (id: string, parent_id: string | null, name: string, sort = 0) => ({ id, parent_id, name, sort });
const rows = [
  n('k', null, 'Kitchen'),
  n('s', null, 'Store room'),
  n('p', 'k', 'Pantry'),
  n('b10', 'p', 'Box 10'),
  n('b2', 'p', 'Box 2'),
  n('r', 's', 'Rack', -1),
  n('orphan', 'gone', 'Lost box'),
];

describe('place tree', () => {
  const tree = buildTree(rows);

  it('orders children by sort, then natural name', () => {
    expect(childrenOf(tree, 'p').map((c) => c.name)).toEqual(['Box 2', 'Box 10']);
    expect(childrenOf(tree, null).map((c) => c.id)).toEqual(['k', 'orphan', 's']);
  });

  it('walks ancestors root-first', () => {
    expect(ancestors(tree, 'b2').map((a) => a.id)).toEqual(['k', 'p']);
    expect(ancestors(tree, 'k')).toEqual([]);
  });

  it('lists descendants depth-first', () => {
    expect(descendants(tree, 'k').map((d) => d.id)).toEqual(['p', 'b2', 'b10']);
  });

  it('never offers a move into itself or its own subtree', () => {
    const targets = moveTargets(tree, 'k').map((t) => t.id);
    expect(targets).not.toContain('k');
    expect(targets).not.toContain('b2');
    expect(targets).toContain('s');
  });
});
