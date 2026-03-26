import { describe, expect, it, vi } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService root system buttons locale config", () => {
  it("keeps root system slot visibility isolated per locale", async () => {
    const store = new Map<string, string[]>();
    const prisma: any = {
      pageNavConfig: {
        findUnique: vi.fn(async ({ where }: any) => {
          const key = where.menuItemId;
          const slotOrder = store.get(key);
          return slotOrder ? { menuItemId: key, slotOrder } : null;
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const key = where.menuItemId;
          const existing = store.get(key);
          store.set(key, existing ? update.slotOrder : create.slotOrder);
          return { menuItemId: key, slotOrder: store.get(key) };
        })
      }
    };

    const svc = new MenuService(
      prisma,
      {
        normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase()
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { log: vi.fn() } as any
    );

    // EN branch: hide "my cabinet".
    const enSlots = [
      "__sys_partner_register",
      "__sys_mentor_contact",
      "__sys_lang",
      "__sys_admin_panel",
      "__sys_configure_page",
      "__sys_configured_marker"
    ];
    await svc.setPageNavConfig("root", enSlots, "u1", "en");

    // RU branch: keep default "my cabinet" visible.
    const ruSlots = [
      "__sys_partner_register",
      "__sys_my_cabinet",
      "__sys_mentor_contact",
      "__sys_lang",
      "__sys_admin_panel",
      "__sys_configure_page",
      "__sys_configured_marker"
    ];
    await svc.setPageNavConfig("root", ruSlots, "u1", "ru");

    const effectiveEn = await svc.getEffectiveSlotOrder("root", [], "en");
    const effectiveRu = await svc.getEffectiveSlotOrder("root", [], "ru");

    expect(effectiveEn).not.toContain("__sys_my_cabinet");
    expect(effectiveRu).toContain("__sys_my_cabinet");
  });
});
