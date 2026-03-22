#!/usr/bin/env bash
# Установка cloudflared и создание systemd service для Cloudflare Tunnel
# Запуск на сервере: sudo bash scripts/cloudflared-install.sh YOUR_TUNNEL_TOKEN
# Token берётся из Cloudflare Dashboard: Zero Trust → Tunnels → Create → скопировать token

set -e

TUNNEL_TOKEN="${1:-}"

if [ -z "$TUNNEL_TOKEN" ]; then
  echo "Использование: sudo bash scripts/cloudflared-install.sh YOUR_TUNNEL_TOKEN"
  echo ""
  echo "Token получается в Cloudflare Dashboard:"
  echo "  Zero Trust → Tunnels → Create a tunnel → Cloudflared → скопировать token"
  echo ""
  exit 1
fi

# Установка cloudflared
echo "Установка cloudflared..."
curl -sL --output /usr/local/bin/cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
chmod +x /usr/local/bin/cloudflared
cloudflared --version
echo "✓ cloudflared установлен"

# Создание systemd service (token в отдельном файле — проще ротировать)
echo "Создание systemd service..."
mkdir -p /etc/cloudflared
echo "TUNNEL_TOKEN=$TUNNEL_TOKEN" > /etc/cloudflared/tunnel-token.env
chmod 600 /etc/cloudflared/tunnel-token.env

# Имя cloudflared для удобства (часто ищут именно его)
cat > /etc/systemd/system/cloudflared.service << 'SERVICE'
[Unit]
Description=Cloudflare Tunnel for Telegram Bot Konstruktor
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cloudflared/tunnel-token.env
ExecStart=/usr/local/bin/cloudflared tunnel run --token ${TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared

echo ""
echo "✓ Cloudflare Tunnel service создан и запущен"
echo "  Статус: systemctl status cloudflared"
echo "  Логи:   journalctl -u cloudflared -f"
echo ""
