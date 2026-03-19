type ParentLinkedNode = {
  parent?: ParentLinkedNode | null;
};

export function collapseNestedDomRoots<T extends ParentLinkedNode>(
  roots: T[],
): T[] {
  const collapsed: T[] = [];

  for (const root of roots) {
    // Favor the outermost matched roots so extraction and assembly see one stable tree.
    if (
      collapsed.some(
        (existing) => existing === root || isAncestorNode(existing, root),
      )
    ) {
      continue;
    }

    const nextRoots = collapsed.filter(
      (existing) => !isAncestorNode(root, existing),
    );
    nextRoots.push(root);
    collapsed.length = 0;
    collapsed.push(...nextRoots);
  }

  return collapsed;
}

function isAncestorNode(
  candidateAncestor: ParentLinkedNode,
  node: ParentLinkedNode,
): boolean {
  let current = node.parent;

  while (current) {
    if (current === candidateAncestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
}
