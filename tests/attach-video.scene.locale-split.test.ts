import { describe, expect, it, vi } from "vitest";

import { attachVideoFromLibraryScene } from "../src/bot/scenes/attach-video-from-library.scene";

describe("attach-video-from-library.scene locale split", () => {
  it.each(["en", "de"])("uses RU UI and updates only %s content layer", async (editingLang) => {
    const updateMenuItemContent = vi.fn().mockResolvedValue(undefined);
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);

    const ctx = {
      currentUser: { id: "u1", selectedLanguage: "ru" },
      scene: {
        state: {
          pageId: "page1",
          languageCode: editingLang,
          uiLanguageCode: "ru"
        },
        leave: vi.fn().mockResolvedValue(undefined)
      },
      wizard: { state: {}, next: vi.fn() },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          t: i18nT
        },
        mediaLibrary: {
          findByChannelMessage: vi.fn().mockResolvedValue({ fileId: "vid-file-id" })
        },
        menu: { updateMenuItemContent }
      },
      callbackQuery: { data: "medialib:pick:123:99" },
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined)
    } as any;

    const step0 = (attachVideoFromLibraryScene as any).steps[0];
    await step0(ctx);
    expect(i18nT).toHaveBeenCalledWith("ru", "attach_video_choose_mode");

    const step1 = (attachVideoFromLibraryScene as any).steps[1];
    await step1(ctx);

    expect(updateMenuItemContent).toHaveBeenCalledTimes(1);
    expect(updateMenuItemContent).toHaveBeenCalledWith(
      "page1",
      "u1",
      editingLang,
      expect.objectContaining({ mediaType: "VIDEO", mediaFileId: "vid-file-id" })
    );
  });
});

