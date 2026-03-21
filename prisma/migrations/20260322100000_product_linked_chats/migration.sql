-- Replace linked_chat_id with linked_chats (JSON array of { link?, label?, identifier? })
-- Migration: copy existing linked_chat_id to linked_chats as identifier-only entry

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "linked_chats" JSONB;

-- Migrate: convert linked_chat_id to linked_chats format
UPDATE "products"
SET "linked_chats" = jsonb_build_array(jsonb_build_object('identifier', "linked_chat_id"::text))
WHERE "linked_chat_id" IS NOT NULL AND ("linked_chats" IS NULL OR "linked_chats" = '[]'::jsonb);

ALTER TABLE "products" DROP COLUMN IF EXISTS "linked_chat_id";
