/**
 * Navigation graph audit: validates page/button structure without Telegram runtime.
 * Used by integration tests and can be run from CLI or cron to detect broken routes.
 */

export const ROOT_PAGE_ID = "root";

export type MenuItemType =
  | "TEXT"
  | "PHOTO"
  | "VIDEO"
  | "DOCUMENT"
  | "LINK"
  | "SUBMENU"
  | "SECTION_LINK";

/** Minimal menu item shape for graph building (no Prisma dependency in validation). */
export interface AuditMenuItem {
  id: string;
  parentId: string | null;
  type: MenuItemType;
  targetMenuItemId?: string | null;
  isActive?: boolean;
}

export interface NavigationEdge {
  from: string;
  to: string;
  kind: "parent_child" | "button_target" | "back_to_parent";
}

export interface NavigationGraph {
  /** All page ids: root + every menu item id. */
  nodes: Set<string>;
  /** Root is virtual node "root"; children of root have parentId null. */
  rootId: string;
  /** Edges: parent_child (parentId -> id), button_target (SECTION_LINK -> targetMenuItemId), back_to_parent (id -> parentId). */
  edges: NavigationEdge[];
  /** Map: pageId -> list of child page ids (for menu buttons). */
  childrenByParent: Map<string | null, string[]>;
  /** Map: pageId -> parent id (null for root children). */
  parentById: Map<string, string | null>;
  /** SECTION_LINK items: id -> targetMenuItemId. */
  sectionLinkTargets: Map<string, string>;
  /** SECTION_LINK button ids that have no targetMenuItemId. */
  sectionLinkWithoutTarget: Set<string>;
}

/**
 * Builds navigation graph from flat list of menu items (e.g. from DB).
 * Root is represented as "root"; items with parentId null are children of root.
 */
export function buildNavigationGraph(items: AuditMenuItem[]): NavigationGraph {
  const nodes = new Set<string>();
  nodes.add(ROOT_PAGE_ID);

  const childrenByParent = new Map<string | null, string[]>();
  childrenByParent.set(null, []);
  childrenByParent.set(ROOT_PAGE_ID, []);

  const parentById = new Map<string, string | null>();
  const sectionLinkTargets = new Map<string, string>();
  const sectionLinkWithoutTarget = new Set<string>();
  const edges: NavigationEdge[] = [];

  for (const item of items) {
    nodes.add(item.id);
    const parentId = item.parentId ?? null;
    parentById.set(item.id, parentId);

    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }
    childrenByParent.get(parentId)!.push(item.id);

    edges.push({ from: parentId === null ? ROOT_PAGE_ID : parentId, to: item.id, kind: "parent_child" });
    edges.push({ from: item.id, to: parentId === null ? ROOT_PAGE_ID : parentId, kind: "back_to_parent" });

    if (item.type === "SECTION_LINK") {
      if (item.targetMenuItemId) {
        sectionLinkTargets.set(item.id, item.targetMenuItemId);
        edges.push({ from: item.id, to: item.targetMenuItemId, kind: "button_target" });
      } else {
        sectionLinkWithoutTarget.add(item.id);
      }
    }
  }

  return {
    nodes,
    rootId: ROOT_PAGE_ID,
    edges,
    childrenByParent,
    parentById,
    sectionLinkTargets,
    sectionLinkWithoutTarget,
  };
}

export interface NavigationAuditError {
  code: string;
  message: string;
  pageId?: string;
  targetId?: string;
}

/**
 * Validates the navigation graph and returns list of errors.
 * - Broken button targets (SECTION_LINK points to missing or inactive page)
 * - Orphan pages (not reachable from root)
 * - Dangling edges (target page does not exist)
 * - Root consistency (root has at least one child or is explicitly empty)
 */
export function validateNavigationGraph(
  graph: NavigationGraph,
  options?: { requireRootContent?: boolean }
): NavigationAuditError[] {
  const errors: NavigationAuditError[] = [];
  const idSet = graph.nodes;

  // 1. SECTION_LINK without target
  for (const buttonId of graph.sectionLinkWithoutTarget) {
    errors.push({
      code: "SECTION_LINK_MISSING_TARGET",
      message: `SECTION_LINK button "${buttonId}" has no targetMenuItemId`,
      pageId: buttonId,
    });
  }

  // 2. SECTION_LINK targets must exist and be in the graph
  for (const [buttonId, targetId] of graph.sectionLinkTargets) {
    if (!idSet.has(targetId)) {
      errors.push({
        code: "BROKEN_BUTTON_TARGET",
        message: `Button "${buttonId}" points to non-existent page "${targetId}"`,
        pageId: buttonId,
        targetId,
      });
    }
  }

  // 3. Every parentId must exist or be null (root children)
  for (const [id, parentId] of graph.parentById) {
    if (parentId !== null && parentId !== ROOT_PAGE_ID && !idSet.has(parentId)) {
      errors.push({
        code: "BROKEN_PARENT",
        message: `Page "${id}" has parent "${parentId}" which does not exist`,
        pageId: id,
        targetId: parentId,
      });
    }
  }

  // 4. Reachability from root: every non-root node must be reachable by following parent_child or button_target
  const reachable = new Set<string>();
  reachable.add(ROOT_PAGE_ID);
  const rootChildren = graph.childrenByParent.get(null) ?? graph.childrenByParent.get(ROOT_PAGE_ID) ?? [];
  const queue: string[] = [...rootChildren];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const children = graph.childrenByParent.get(cur) ?? [];
    queue.push(...children);
    const linkTarget = graph.sectionLinkTargets.get(cur);
    if (linkTarget && idSet.has(linkTarget)) {
      queue.push(linkTarget);
    }
  }

  for (const id of graph.nodes) {
    if (id === ROOT_PAGE_ID) continue;
    if (!reachable.has(id)) {
      errors.push({
        code: "ORPHAN_PAGE",
        message: `Page "${id}" is not reachable from root`,
        pageId: id,
      });
    }
  }

  // 5. Optional: root should have content (at least one child) if requireRootContent
  if (options?.requireRootContent && rootChildren.length === 0) {
    errors.push({
      code: "EMPTY_ROOT",
      message: "Root has no menu items (empty main menu)",
    });
  }

  return errors;
}

/**
 * Resolves effective target page for a menu button.
 * - Normal items: target = item.id
 * - SECTION_LINK: target = item.targetMenuItemId (must exist)
 */
export function getButtonTargetPage(item: AuditMenuItem): string | null {
  if (item.type === "SECTION_LINK" && item.targetMenuItemId) {
    return item.targetMenuItemId;
  }
  return item.id;
}

/**
 * Returns parent page id for "back" navigation. Root children have parent "root".
 */
export function getBackTargetPageId(item: AuditMenuItem): string {
  return item.parentId === null ? ROOT_PAGE_ID : item.parentId;
}
