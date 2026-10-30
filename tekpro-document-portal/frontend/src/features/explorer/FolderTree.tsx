import { useMemo, useState } from "react";
import type { Folder } from "../../types/api";

export interface TreeNode extends Folder {
  children: TreeNode[];
}

export function buildTree(folders: Folder[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(folders.map((f) => [f.id, { ...f, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentFolderId ? nodes.get(node.parentFolderId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Ancestors (root first) of a folder within the visible tree. */
export function pathTo(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && out.length < 50) {
    out.unshift(cur);
    cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
  }
  return out;
}

export function FolderTree({
  folders,
  selectedId,
  onSelect,
  showHidden,
}: {
  folders: Folder[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showHidden: boolean;
}) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const selectedPath = useMemo(() => new Set(pathTo(folders, selectedId).map((f) => f.id)), [folders, selectedId]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number) => (
    <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Folders" : undefined} className="tree-list">
      {nodes.map((node) => {
        const expanded = !collapsed.has(node.id) || selectedPath.has(node.id);
        const hasChildren = node.children.length > 0;
        return (
          <li key={node.id} role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={node.id === selectedId}>
            <div className={`tree-row ${node.id === selectedId ? "tree-row-active" : ""}`} style={{ paddingLeft: `${depth * 14 + 4}px` }}>
              {hasChildren ? (
                <button type="button" className="tree-toggle" onClick={() => toggle(node.id)} aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}>
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="tree-toggle-spacer" />
              )}
              <button type="button" className="tree-label" onClick={() => onSelect(node.id)}>
                <span className="tree-icon" aria-hidden="true">
                  📁
                </span>
                <span className="tree-name">{node.name}</span>
                {showHidden && node.hiddenFromCustomer && <span className="badge badge-warning">Hidden</span>}
                {typeof node.documentCount === "number" && node.documentCount > 0 && <span className="tree-count">{node.documentCount}</span>}
              </button>
            </div>
            {hasChildren && expanded && render(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="tree">
      <button type="button" className={`tree-all ${selectedId === null ? "tree-row-active" : ""}`} onClick={() => onSelect(null)}>
        All documents
      </button>
      {tree.length ? render(tree, 0) : <p className="muted small">No folders available.</p>}
    </div>
  );
}
