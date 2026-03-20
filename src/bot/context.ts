import type { User } from "@prisma/client";
import { Scenes } from "telegraf";

import type { AppServices } from "../app/services";

export interface CreateMenuItemDraft {
  languageCode?: string;
  parentId?: string | null;
  title?: string;
  type?: "TEXT" | "PHOTO" | "VIDEO" | "DOCUMENT" | "LINK" | "SUBMENU";
  contentText?: string;
  mediaType?: import("@prisma/client").MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
}

export interface CreateBroadcastDraft {
  mode?: "instant" | "scheduled";
  audienceType?: "ALL_USERS" | "OWN_FIRST_LINE" | "OWN_STRUCTURE" | "SPECIFIC_LEVEL" | "LANGUAGE" | "ROLE" | "TAGS" | "PAYMENT_STATUS" | "ACTIVITY" | "CUSTOM";
  segmentQuery?: Record<string, unknown>;
  sendAt?: string;
  // Local-time delivery for scheduled broadcasts.
  deliveryDateMode?: "TODAY" | "TOMORROW" | "PLUS2" | "CUSTOM";
  deliveryDate?: string; // YYYY-MM-DD
  deliveryTime?: string; // HH:MM
  languageCode?: string;
}

export interface CreateDripDraft {
  title?: string;
  triggerType?: "ON_REGISTRATION" | "ON_PAYMENT" | "ON_TAG_ASSIGNED" | "ON_EVENT";
  languageCode?: string;
}

// Telegraf's WizardContext type is not generic over our custom props in a way that satisfies
// WizardScene's constraints. Use the generic WizardContext<any> and extend it with our fields.
export type BotContext = Scenes.WizardContext<any> & {
  services: AppServices;
  currentUser?: User;
};
