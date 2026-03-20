import { beforeEach, describe, expect, it, vi } from "vitest";
import { canPerform, canViewGlobalUserDirectory, getBackofficeCapabilities } from "../src/http/backoffice/backoffice-permissions";

describe("Back-office forbidden visibility", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  it("ADMIN does not have bot_roles:manage — roles button must be hidden", () => {
    expect(canPerform("ADMIN", "bot_roles:manage")).toBe(false);
  });

  it("OWNER has bot_roles:manage — roles button must be shown", () => {
    expect(canPerform("OWNER", "bot_roles:manage")).toBe(true);
  });

  it("ADMIN has bot_settings:write — settings button must be shown", () => {
    expect(canPerform("ADMIN", "bot_settings:write")).toBe(true);
  });

  it("ADMIN does not have bot_clone:create — clone button must be hidden", () => {
    expect(canPerform("ADMIN", "bot_clone:create")).toBe(false);
  });

  it("ADMIN does not have bot_lifecycle:archive_delete — archive/delete actions must be hidden", () => {
    expect(canPerform("ADMIN", "bot_lifecycle:archive_delete")).toBe(false);
  });

  it("ADMIN does not have payments:confirm_manual — manual payment confirm must be hidden", () => {
    expect(canPerform("ADMIN", "payments:confirm_manual")).toBe(false);
  });

  it("OWNER has all capabilities including bot_roles:manage and bot_clone:create", () => {
    const caps = getBackofficeCapabilities("OWNER");
    expect(caps.has("bot_roles:manage")).toBe(true);
    expect(caps.has("bot_clone:create")).toBe(true);
    expect(caps.has("bot_lifecycle:archive_delete")).toBe(true);
    expect(caps.has("payments:confirm_manual")).toBe(true);
  });

  it("ADMIN capabilities are restricted — no roles, clone, archive/delete, payments", () => {
    const caps = getBackofficeCapabilities("ADMIN");
    expect(caps.has("bot_roles:manage")).toBe(false);
    expect(caps.has("bot_clone:create")).toBe(false);
    expect(caps.has("bot_lifecycle:archive_delete")).toBe(false);
    expect(caps.has("payments:confirm_manual")).toBe(false);
  });

  it("ALPHA_OWNER has global_user_directory:view", () => {
    const caps = getBackofficeCapabilities("ALPHA_OWNER");
    expect(caps.has("global_user_directory:view")).toBe(true);
  });

  it("OWNER and ADMIN do not have global_user_directory:view by default", () => {
    expect(getBackofficeCapabilities("OWNER").has("global_user_directory:view")).toBe(false);
    expect(getBackofficeCapabilities("ADMIN").has("global_user_directory:view")).toBe(false);
  });

  it("canViewGlobalUserDirectory returns true for ALPHA_OWNER role", () => {
    expect(canViewGlobalUserDirectory("ALPHA_OWNER", "any@example.com")).toBe(true);
  });

  it("canViewGlobalUserDirectory returns false for OWNER/ADMIN without BACKOFFICE_ALPHA_EMAIL", () => {
    expect(canViewGlobalUserDirectory("OWNER", "owner@example.com")).toBe(false);
    expect(canViewGlobalUserDirectory("ADMIN", "admin@example.com")).toBe(false);
  });
});
