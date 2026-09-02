export type TreeNode = { nodeId?: unknown; level?: unknown; childNodes?: unknown; [key: string]: unknown };

const label = (node: TreeNode, language: string) => String(node[`label${language.toUpperCase()}`] ?? node.labelEN ?? node.nodeId ?? "");

export function buildTreeIndex(nodes: TreeNode[], language = "EN"): Map<string, TreeNode> {
  return new Map(nodes.filter((node) => node.nodeId != null).map((node) => [String(node.nodeId), node]));
}

export function navigationPath(nodeIds: string[], index: Map<string, TreeNode>, language = "EN"): string {
  return nodeIds.filter((id) => id !== "N-21347").map((id, position) => ({ id, position, node: index.get(id) }))
    .sort((a, b) => Number(a.node?.level ?? a.position) - Number(b.node?.level ?? b.position))
    .map(({ id, node }) => label(node ?? { nodeId: id }, language)).filter(Boolean).join("\r\n>> ");
}
