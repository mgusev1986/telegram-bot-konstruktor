import { describe, it, expect } from "vitest";
import {
  buildNavigationGraph,
  validateNavigationGraph,
  getButtonTargetPage,
  getBackTargetPageId,
  ROOT_PAGE_ID,
  type AuditMenuItem,
} from "../src/modules/menu/navigation-audit";

describe("Navigation audit: graph building", () => {
  it("builds graph with root and root-level sections", () => {
    const items: AuditMenuItem[] = [
      { id: "s1", parentId: null, type: "SUBMENU" },
      { id: "s2", parentId: null, type: "TEXT" },
    ];
    const graph = buildNavigationGraph(items);
    expect(graph.nodes.has(ROOT_PAGE_ID)).toBe(true);
    expect(graph.nodes.has("s1")).toBe(true);
    expect(graph.nodes.has("s2")).toBe(true);
    expect(graph.childrenByParent.get(null)).toEqual(["s1", "s2"]);
    expect(graph.parentById.get("s1")).toBe(null);
    expect(graph.parentById.get("s2")).toBe(null);
    expect(graph.edges.some((e) => e.kind === "parent_child" && e.from === ROOT_PAGE_ID && e.to === "s1")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "back_to_parent" && e.from === "s1" && e.to === ROOT_PAGE_ID)).toBe(true);
  });

  it("builds parent-child and back edges for nested pages", () => {
    const items: AuditMenuItem[] = [
      { id: "root-sec", parentId: null, type: "SUBMENU" },
      { id: "child-a", parentId: "root-sec", type: "TEXT" },
    ];
    const graph = buildNavigationGraph(items);
    expect(graph.childrenByParent.get("root-sec")).toEqual(["child-a"]);
    expect(graph.parentById.get("child-a")).toBe("root-sec");
    expect(graph.edges.some((e) => e.kind === "back_to_parent" && e.from === "child-a" && e.to === "root-sec")).toBe(
      true
    );
  });

  it("registers SECTION_LINK button targets as edges", () => {
    const items: AuditMenuItem[] = [
      { id: "sec", parentId: null, type: "SUBMENU" },
      { id: "btn", parentId: "sec", type: "SECTION_LINK", targetMenuItemId: "target-page" },
      { id: "target-page", parentId: "sec", type: "TEXT" },
    ];
    const graph = buildNavigationGraph(items);
    expect(graph.sectionLinkTargets.get("btn")).toBe("target-page");
    expect(graph.edges.some((e) => e.kind === "button_target" && e.from === "btn" && e.to === "target-page")).toBe(
      true
    );
  });
});

describe("Navigation audit: validation", () => {
  it("reports BROKEN_BUTTON_TARGET when SECTION_LINK points to missing page", () => {
    const items: AuditMenuItem[] = [
      { id: "btn", parentId: null, type: "SECTION_LINK", targetMenuItemId: "missing-id" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.some((e) => e.code === "BROKEN_BUTTON_TARGET" && e.pageId === "btn" && e.targetId === "missing-id")).toBe(
      true
    );
  });

  it("reports SECTION_LINK_MISSING_TARGET when targetMenuItemId is empty", () => {
    const items: AuditMenuItem[] = [
      { id: "btn", parentId: null, type: "SECTION_LINK", targetMenuItemId: null },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.some((e) => e.code === "SECTION_LINK_MISSING_TARGET")).toBe(true);
  });

  it("reports ORPHAN_PAGE when page is not reachable from root", () => {
    const items: AuditMenuItem[] = [
      { id: "s1", parentId: null, type: "SUBMENU" },
      { id: "orphan", parentId: "nonexistent", type: "TEXT" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.some((e) => e.code === "ORPHAN_PAGE" && e.pageId === "orphan")).toBe(true);
    expect(errors.some((e) => e.code === "BROKEN_PARENT")).toBe(true);
  });

  it("passes when all SECTION_LINK targets exist and all pages reachable", () => {
    const items: AuditMenuItem[] = [
      { id: "s1", parentId: null, type: "SUBMENU" },
      { id: "s2", parentId: "s1", type: "TEXT" },
      { id: "link", parentId: "s1", type: "SECTION_LINK", targetMenuItemId: "s2" },
    ];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph);
    expect(errors.length).toBe(0);
  });

  it("reports EMPTY_ROOT when requireRootContent and root has no children", () => {
    const items: AuditMenuItem[] = [];
    const graph = buildNavigationGraph(items);
    const errors = validateNavigationGraph(graph, { requireRootContent: true });
    expect(errors.some((e) => e.code === "EMPTY_ROOT")).toBe(true);
  });
});

describe("Navigation audit: helpers", () => {
  it("getButtonTargetPage returns id for non-SECTION_LINK", () => {
    expect(getButtonTargetPage({ id: "p1", parentId: null, type: "TEXT" })).toBe("p1");
    expect(getButtonTargetPage({ id: "p2", parentId: null, type: "SUBMENU" })).toBe("p2");
  });

  it("getButtonTargetPage returns targetMenuItemId for SECTION_LINK", () => {
    expect(
      getButtonTargetPage({
        id: "btn",
        parentId: "sec",
        type: "SECTION_LINK",
        targetMenuItemId: "target-id",
      })
    ).toBe("target-id");
  });

  it("getBackTargetPageId returns root for root-level item", () => {
    expect(getBackTargetPageId({ id: "s1", parentId: null, type: "TEXT" })).toBe(ROOT_PAGE_ID);
  });

  it("getBackTargetPageId returns parentId for nested item", () => {
    expect(getBackTargetPageId({ id: "child", parentId: "parent", type: "TEXT" })).toBe("parent");
  });
});
