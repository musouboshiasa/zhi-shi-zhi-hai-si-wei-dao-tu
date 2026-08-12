#!/bin/bash
# ============================================
# 知识之海 - 子路径部署脚本（在服务器上执行）
# 适用：musouboshiasa.com/ruanjian 子路径部署，与现有网站/网盘共存
# 使用方法: bash deploy.sh
# ============================================
set -e

echo "========================================="
echo "  知识之海 子路径部署脚本 (/ruanjian)"
echo "========================================="

. /etc/os-release 2>/dev/null || true
echo "✅ 系统: ${PRETTY_NAME:-未知}"

# 1. 安装 Node.js（如已装跳过）
echo ""
echo "📦 检查 Node.js..."
if command -v node >/dev/null 2>&1; then
  echo "✅ Node.js 已安装: $(node -v)"
else
  echo "安装 Node.js 20..."
  curl -fsSL https://mirrors.aliyun.com/nodesource/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. 复制项目到 /opt/knowledge-sea
echo ""
echo "📂 检查项目目录..."
PROJECT_DIR="/opt/knowledge-sea"
if [ -f "$PROJECT_DIR/package.json" ]; then
  echo "✅ 项目已存在: $PROJECT_DIR"
  if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    cd $PROJECT_DIR && npm install --production
    echo "✅ 依赖安装完成"
  fi
else
  echo "⚠️ 项目未部署，请先将项目文件上传到 $PROJECT_DIR"
  echo "   上传方法见《服务器部署指南.md》"
  exit 1
fi

# 3. 启动 Node 服务（systemd）
echo ""
echo "⚙️ 配置系统服务..."
cp deploy/knowledge-sea.service /etc/systemd/system/ 2>/dev/null || cp "$PROJECT_DIR/deploy/knowledge-sea.service" /etc/systemd/system/
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" /etc/systemd/system/knowledge-sea.service
sed -i "s|ExecStart=.*|ExecStart=/usr/bin/node $PROJECT_DIR/server.js|" /etc/systemd/system/knowledge-sea.service
systemctl daemon-reload
systemctl enable knowledge-sea
systemctl restart knowledge-sea
echo "✅ Node 服务已启动 (端口 3000)"

# 4. 配置 Nginx 子路径
echo ""
echo "⚙️ 配置 Nginx 子路径 (/ruanjian)..."

# 找到正在使用的 Nginx 配置文件
NGINX_CONF=""
if command -v nginx >/dev/null 2>&1; then
  # 尝试常见位置
  for f in /www/server/panel/vhost/nginx/*.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -f "$f" ] && grep -q "musouboshiasa\|server_name" "$f" 2>/dev/null && NGINX_CONF="$f" && break
  done
fi

if [ -n "$NGINX_CONF" ]; then
  echo "✅ 找到 Nginx 配置: $NGINX_CONF"
  echo ""
  echo "请手动在 $NGINX_CONF 的对应 server 块内追加以下内容（参考 deploy/nginx-子路径.conf）："
  echo ""
  echo "    location = /ruanjian { return 301 /ruanjian/; }"
  echo "    location /ruanjian/ {"
  echo "        proxy_pass http://127.0.0.1:3000/;"
  echo "        proxy_set_header Host \$host;"
  echo "        proxy_set_header X-Real-IP \$remote_addr;"
  echo "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
  echo "        proxy_set_header X-Forwarded-Proto \$scheme;"
  echo "        client_max_body_size 50M;"
  echo "    }"
  echo ""
  echo "⚠️ 为避免覆盖现有网站配置，脚本不做自动修改，请手动操作"
  echo "   修改后执行: nginx -t && systemctl reload nginx"
else
  echo "⚠️ 未找到现有 Nginx 站点配置，请手动按《服务器部署指南.md》操作"
fi

# 5. HTTPS 证书（如果已有站点证书则共用，无需重复申请）
echo ""
echo "🔒 HTTPS：如果 musouboshiasa.com 已有证书，子路径自动继承，无需操作"
echo "   如果还没有证书，请执行: certbot --nginx -d musouboshiasa.com -d www.musouboshiasa.com"

echo ""
echo "========================================="
echo "🎉 部署完成！"
echo "   访问: https://musouboshiasa.com/ruanjian/"
echo "========================================="
