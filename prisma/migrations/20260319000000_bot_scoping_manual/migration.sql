-- Manual migration to add bot_instance_id scoping fields.

-- Users: drop global uniqueness to allow multi-bot user rows.
DROP INDEX IF EXISTS public.users_telegram_user_id_key;
DROP INDEX IF EXISTS public.users_username_key;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

-- Backoffice/Telegram scoping: unique per (telegram_user_id, bot_instance_id)
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_user_id_bot_instance_id_key
  ON public.users (telegram_user_id, bot_instance_id);

CREATE INDEX IF NOT EXISTS users_bot_instance_id_idx
  ON public.users (bot_instance_id);

-- Foreign keys
ALTER TABLE public.users
  ADD CONSTRAINT users_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Drip campaigns
ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

CREATE INDEX IF NOT EXISTS drip_campaigns_bot_instance_id_idx
  ON public.drip_campaigns (bot_instance_id);

ALTER TABLE public.drip_campaigns
  ADD CONSTRAINT drip_campaigns_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- User drip progress
ALTER TABLE public.user_drip_progress
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

CREATE INDEX IF NOT EXISTS user_drip_progress_bot_instance_id_idx
  ON public.user_drip_progress (bot_instance_id);

ALTER TABLE public.user_drip_progress
  ADD CONSTRAINT user_drip_progress_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Broadcasts
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

CREATE INDEX IF NOT EXISTS broadcasts_bot_instance_id_idx
  ON public.broadcasts (bot_instance_id);

ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

CREATE INDEX IF NOT EXISTS payments_bot_instance_id_idx
  ON public.payments (bot_instance_id);

ALTER TABLE public.payments
  ADD CONSTRAINT payments_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Content progress
ALTER TABLE public.content_progress
  ADD COLUMN IF NOT EXISTS bot_instance_id TEXT;

CREATE INDEX IF NOT EXISTS content_progress_bot_instance_id_idx
  ON public.content_progress (bot_instance_id);

ALTER TABLE public.content_progress
  ADD CONSTRAINT content_progress_bot_instance_id_fkey
  FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE;
