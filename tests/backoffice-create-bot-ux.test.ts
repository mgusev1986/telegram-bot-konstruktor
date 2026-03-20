import { describe, expect, it } from "vitest";
import {
  buildCreateBotForm,
  renderDashboardBody,
  type CreateFormValues,
  type DashboardParams
} from "../src/http/backoffice/register-backoffice";
import { hashTelegramBotToken } from "../src/common/telegram-token-encryption";

describe("hashTelegramBotToken", () => {
  it("returns same hash for same token (idempotent)", () => {
    const token = "123456:ABC-DEF";
    expect(hashTelegramBotToken(token)).toBe(hashTelegramBotToken(token));
  });

  it("returns different hashes for different tokens", () => {
    expect(hashTelegramBotToken("token-a")).not.toBe(hashTelegramBotToken("token-b"));
  });

  it("returns 64-char hex string", () => {
    const h = hashTelegramBotToken("any");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Back-office create-bot UX", () => {
  const baseDashboardParams: DashboardParams = {
    bots: [],
    role: "ADMIN",
    email: "admin@test.com",
    lang: "ru",
    canViewAudience: false
  };

  describe("buildCreateBotForm", () => {
    it("renders form without error when no createError", () => {
      const html = buildCreateBotForm({});
      expect(html).toContain('action="/backoffice/api/bots/create"');
      expect(html).toContain('name="name"');
      expect(html).toContain('name="telegramBotToken"');
      expect(html).not.toContain('class="error"');
      expect(html).toContain("Создать");
    });

    it("includes duplicate submit protection (in-flight lock, preventDefault, fetch)", () => {
      const html = buildCreateBotForm({});
      expect(html).toContain('id="create-bot-form"');
      expect(html).toContain("addEventListener");
      expect(html).toContain("preventDefault");
      expect(html).toContain("submitting");
      expect(html).toContain("disabled=true");
      expect(html).toContain("Создание");
      expect(html).toContain("fetch(");
    });

    it("shows error block when createError is provided", () => {
      const html = buildCreateBotForm({ createError: "Токен невалиден" });
      expect(html).toContain('class="error"');
      expect(html).toContain("Токен невалиден");
    });

    it("pre-fills form values for retry after error", () => {
      const formValues: CreateFormValues = {
        name: "My Bot",
        telegramBotUsername: "my_bot",
        baseLanguageCode: "en"
      };
      const html = buildCreateBotForm({ formValues });
      expect(html).toContain('value="My Bot"');
      expect(html).toContain('value="my_bot"');
      expect(html).toContain('value="en" selected');
    });

    it("does not echo token (security)", () => {
      const html = buildCreateBotForm({});
      expect(html).toContain('name="telegramBotToken"');
      expect(html).not.toMatch(/value="[^"]*token[^"]*"/i);
    });
  });

  describe("renderDashboardBody", () => {
    it("shows success banner when createdBotId matches a bot in list", () => {
      const bot = {
        id: "bot-123",
        name: "Test Bot",
        telegramBotUsername: "test_bot",
        status: "ACTIVE",
        createdAt: new Date("2025-01-15")
      };
      const html = renderDashboardBody({
        ...baseDashboardParams,
        bots: [bot],
        createdBotId: "bot-123"
      });
      expect(html).toContain("Бот успешно создан");
      expect(html).toContain("Test Bot");
      expect(html).toContain("test_bot");
      expect(html).toContain(`id="bot-bot-123"`);
      expect(html).toContain('class="bot-card created"');
    });

    it("adds scroll-into-view script for newly created bot", () => {
      const bot = {
        id: "bot-456",
        name: "New Bot",
        telegramBotUsername: null,
        status: "ACTIVE",
        createdAt: new Date()
      };
      const html = renderDashboardBody({
        ...baseDashboardParams,
        bots: [bot],
        createdBotId: "bot-456"
      });
      expect(html).toContain("scrollIntoView");
      expect(html).toContain('bot-bot-456');
    });

    it("does not show success banner when createdBotId does not match any bot", () => {
      const html = renderDashboardBody({
        ...baseDashboardParams,
        bots: [],
        createdBotId: "non-existent"
      });
      expect(html).not.toContain("Бот успешно создан");
    });

    it("passes createError and formValues to create form", () => {
      const html = renderDashboardBody({
        ...baseDashboardParams,
        createError: "Заполните поля",
        formValues: { name: "Partial" }
      });
      expect(html).toContain("Заполните поля");
      expect(html).toContain('value="Partial"');
    });

    it("shows duplicate token error message in createError", () => {
      const html = renderDashboardBody({
        ...baseDashboardParams,
        createError: "Бот с таким токеном уже существует."
      });
      expect(html).toContain("Бот с таким токеном уже существует");
    });

    it("renders bot list with settings and open links", () => {
      const bot = {
        id: "b1",
        name: "Bot One",
        telegramBotUsername: "botone",
        status: "ACTIVE",
        createdAt: new Date()
      };
      const html = renderDashboardBody({
        ...baseDashboardParams,
        bots: [bot]
      });
      expect(html).toContain("Bot One");
      expect(html).toContain("botone");
      expect(html).toContain("/backoffice/bots/b1/settings");
      expect(html).toContain("https://t.me/botone");
    });
  });
});
