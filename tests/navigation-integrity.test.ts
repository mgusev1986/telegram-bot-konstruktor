import { describe, it, expect } from "vitest";
import {
  buildNavigationGraph,
  validateNavigationGraph,
  ROOT_PAGE_ID,
  type AuditMenuItem,
} from "../src/modules/menu/navigation-audit";

/** Fixture: root + 2 sections + 1 child under first section. */
function fixtureMinimalTree(): AuditMenuItem[] {
  return [
    { id: "sec1", parentId: null, type: "SUBMENU" },
    { id: "sec2", parentId: null, type: "TEXT" },
    { id: "child1", parentId: "sec1", type: "TEXT" },
  ];
}

/** Fixture: section with SECTION_LINK pointing to existing page. */
function fixtureWithSectionLink(): AuditMenuItem[] {
  return [
    { id: "sec", parentId: null, type: "SUBMENU" },
    { id: "page-a", parentId: "sec", type: "TEXT" },
    { id: "btn-to-a", parentId: "sec", type: "SECTION_LINK", targetMenuItemId: "page-a" },
  ];
}

describe("Route integrity: root and main menu", () => {
  it("root page exists and has correct id", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    expect(graph.rootId).toBe(ROOT_PAGE_ID);
    expect(graph.nodes.has(ROOT_PAGE_ID)).toBe(true);
  });

  it("root has children (sections) as first-level menu", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    const rootChildren = graph.childrenByParent.get(null) ?? [];
    expect(rootChildren).toContain("sec1");
    expect(rootChildren).toContain("sec2");
    expect(rootChildren.length).toBe(2);
  });

  it("every root child has back_to_parent edge to root", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    const backEdges = graph.edges.filter((e) => e.kind === "back_to_parent");
    expect(backEdges.some((e) => e.from === "sec1" && e.to === ROOT_PAGE_ID)).toBe(true);
    expect(backEdges.some((e) => e.from === "sec2" && e.to === ROOT_PAGE_ID)).toBe(true);
  });
});

describe("Route integrity: section and child pages", () => {
  it("each section has correct parent", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    expect(graph.parentById.get("sec1")).toBe(null);
    expect(graph.parentById.get("child1")).toBe("sec1");
  });

  it("back from child page returns to parent section", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    const backFromChild = graph.edges.find(
      (e) => e.kind === "back_to_parent" && e.from === "child1"
    );
    expect(backFromChild?.to).toBe("sec1");
  });

  it("all pages are reachable from root (no orphans)", () => {
    const graph = buildNavigationGraph(fixtureMinimalTree());
    const errors = validateNavigationGraph(graph);
    expect(errors.filter((e) => e.code === "ORPHAN_PAGE")).toHaveLength(0);
  });
});

describe("Route integrity: button targets", () => {
  it("every menu button target exists (no broken links)", () => {
    const items = fixtureWithSectionLink();
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.filter((e) => e.code === "BROKEN_BUTTON_TARGET")).toHaveLength(0);
  });

  it("detects broken SECTION_LINK target", () => {
    const items: AuditMenuItem[] = [
      { id: "sec", parentId: null, type: "SUBMENU" },
      { id: "btn", parentId: "sec", type: "SECTION_LINK", targetMenuItemId: "nonexistent" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.some((e) => e.code === "BROKEN_BUTTON_TARGET" && e.targetId === "nonexistent")).toBe(true);
  });
});

describe("Route integrity: full graph audit", () => {
  it("full tree passes validation when structure is correct", () => {
    const items: AuditMenuItem[] = [
      { id: "r1", parentId: null, type: "SUBMENU" },
      { id: "r2", parentId: null, type: "TEXT" },
      { id: "c1", parentId: "r1", type: "TEXT" },
      { id: "c2", parentId: "r1", type: "SUBMENU" },
      { id: "d1", parentId: "c2", type: "TEXT" },
      { id: "link1", parentId: "r1", type: "SECTION_LINK", targetMenuItemId: "c1" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors).toHaveLength(0);
  });

  it("detects multiple issues in one run", () => {
    const items: AuditMenuItem[] = [
      { id: "ok", parentId: null, type: "TEXT" },
      { id: "broken-link", parentId: null, type: "SECTION_LINK", targetMenuItemId: "missing" },
      { id: "orphan", parentId: "also-missing", type: "TEXT" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.some((e) => e.code === "BROKEN_BUTTON_TARGET")).toBe(true);
    expect(errors.some((e) => e.code === "BROKEN_PARENT")).toBe(true);
    expect(errors.some((e) => e.code === "ORPHAN_PAGE")).toBe(true);
  });
});
