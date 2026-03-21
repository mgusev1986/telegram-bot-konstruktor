-- Add wallet_bep20 to products: owner/customer wallet for USDT BEP20 payments
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "wallet_bep20" TEXT;
