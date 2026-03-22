import { describe, expect, it, vi } from "vitest";

import { createButtonLinkScene } from "../src/bot/scenes/create-button-link.scene";

function createCtx() {
  const replyWithHTML = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const answerCbQuery = vi.fn().mockResolvedValue(undefined);
  const sceneLeave = vi.fn().mockResolvedValue(undefined);
  const createMenuItem = vi.fn().mockResolvedValue(undefined);
  const findMenuItemByIdOrShort = vi.fn().mockResolvedValue({
    id: "section-full-id-1234567890",
    localizations: []
  });
  const getContentSectionsForPicker = vi.fn().mockResolvedValue([
    { id: "section-full-id-1234567890", title: "Section 1" }
  ]);

  const ctx = {
    currentUser: { id: "u1", selectedLanguage: "ru" },
    scene: {
      state: {
        parentId: "root",
        fromPageId: "root",
        languageCode: "ru",
        uiLanguageCode: "ru"
      },
      leave: sceneLeave
    },
    wizard: {
      state: {},
      next: vi.fn(),
      selectStep: vi.fn()
    },
    services: {
      i18n: {
        resolveLanguage: (l: string) => String(l).toLowerCase(),
        normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
        t: (_lang: string, key: string) => key
      },
      menu: {
        getBaseLanguage: vi.fn().mockResolvedValue("ru"),
        getContentSectionsForPicker,
        findMenuItemByIdOrShort,
        ensureSystemTargetMenuItem: vi.fn().mockResolvedValue("__sys_target"),
        createMenuItem
      },
      users: {
        setOnboardingStep: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(null)
      }
    },
    replyWithHTML,
    reply,
    answerCbQuery
  } as any;

  return {
    ctx,
    replyWithHTML,
    reply,
    answerCbQuery,
    sceneLeave,
    createMenuItem,
    findMenuItemByIdOrShort,
    getContentSectionsForPicker
  };
}

async function runUntilTargetTypeChoice(ctx: any) {
  const steps = (createButtonLinkScene as any).steps;
  await steps[0](ctx, vi.fn());
  ctx.message = { text: "My button" };
  await steps[1](ctx);
  return steps;
}

describe("create-button-link.scene", () => {
  it("shows action type choice after button title", async () => {
    const { ctx, replyWithHTML } = createCtx();
    await runUntilTargetTypeChoice(ctx);

    const keyboard = replyWithHTML.mock.calls.at(-1)?.[1];
    const rows = keyboard.reply_markup.inline_keyboard;

    expect(rows[0][0].callback_data).toBe("create_btn:mode:section");
    expect(rows[1][0].callback_data).toBe("create_btn:mode:external");
    expect(rows[2][0].callback_data).toBe("scene:cancel");
    rows.forEach((row: any[]) => expect(row.length).toBe(1));
  });

  it("keeps internal section flow working after choosing existing section", async () => {
    const { ctx, createMenuItem, getContentSectionsForPicker, findMenuItemByIdOrShort, replyWithHTML } = createCtx();
    const steps = await runUntilTargetTypeChoice(ctx);

    ctx.callbackQuery = { data: "create_btn:mode:section" };
    await steps[2](ctx);

    expect(getContentSectionsForPicker).toHaveBeenCalledWith("ru");
    const pickerRows = replyWithHTML.mock.calls.at(-1)?.[1].reply_markup.inline_keyboard;
    const sectionCallback = pickerRows[0][0].callback_data;
    expect(sectionCallback.length).toBeLessThanOrEqual(64);

    ctx.callbackQuery = { data: sectionCallback };
    await steps[3](ctx);

    expect(findMenuItemByIdOrShort).toHaveBeenCalledWith("section-full");
    expect(createMenuItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SECTION_LINK",
        targetMenuItemId: "section-full-id-1234567890",
        title: "My button"
      })
    );
  });

  it("creates external link button for https URL", async () => {
    const { ctx, createMenuItem } = createCtx();
    const steps = await runUntilTargetTypeChoice(ctx);

    ctx.callbackQuery = { data: "create_btn:mode:external" };
    await steps[2](ctx);

    delete ctx.callbackQuery;
    ctx.message = { text: "https://t.me/my_channel" };
    await steps[4](ctx);

    expect(createMenuItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EXTERNAL_LINK",
        externalUrl: "https://t.me/my_channel",
        title: "My button"
      })
    );
  });

  it("accepts tg deep links for external buttons", async () => {
    const { ctx, createMenuItem } = createCtx();
    const steps = await runUntilTargetTypeChoice(ctx);

    ctx.callbackQuery = { data: "create_btn:mode:external" };
    await steps[2](ctx);

    delete ctx.callbackQuery;
    ctx.message = { text: "tg://resolve?domain=my_channel" };
    await steps[4](ctx);

    expect(createMenuItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EXTERNAL_LINK",
        externalUrl: "tg://resolve?domain=my_channel"
      })
    );
  });

  it("rejects invalid external URL and asks to retry", async () => {
    const { ctx, createMenuItem, reply } = createCtx();
    const steps = await runUntilTargetTypeChoice(ctx);

    ctx.callbackQuery = { data: "create_btn:mode:external" };
    await steps[2](ctx);

    delete ctx.callbackQuery;
    ctx.message = { text: "ftp://example.com" };
    await steps[4](ctx);

    expect(createMenuItem).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      "error_invalid_url",
      expect.objectContaining({
        reply_markup: expect.any(Object)
      })
    );
  });
});
