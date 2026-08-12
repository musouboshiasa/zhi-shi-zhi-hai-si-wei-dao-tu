#!/bin/bash
# ============================================
# 知识之海 - 一键部署脚本（在服务器上执行）
# 使用方法: bash deploy.sh
# ============================================
set -e

echo "========================================="
echo "  知识之海 服务器部署脚本"
echo "========================================="

# 1. 检查系统
if [ ! -f /etc/os-release ]; then
  echo "❌ 无法识别系统，请手动安装"
  exit 1
fi
. /etc/os-release
echo "✅ 系统: $PRETTY_NAME"

# 2. 安装 Node.js（阿里云镜像）
echo ""
echo "📦 检查 Node.js..."
if command -v node >/dev/null 2>&1; then
  echo "✅ Node.js 已安装: $(node -v)"
else
  echo "安装 Node.js 20..."
  curl -fsSL https://mirrors.aliyun.com/nodesource/setup_20.x | bash -
  apt-get install -y nodejs
  echo "✅ Node.js $(node -v) 安装完成"
fi

# 3. 安装 Nginx
echo ""
echo "📦 检查 Nginx..."
if command -v nginx >/dev/null 2>&1; then
  echo "✅ Nginx 已安装"
else
  echo "安装 Nginx..."
  apt-get update
  apt-get install -y nginx
  systemctl enable nginx
  systemctl start nginx
  echo "✅ Nginx 安装完成"
fi

# 4. 安装 certbot（HTTPS 证书）
echo ""
echo "📦 检查 certbot..."
if command -v certbot >/dev/null 2>&1; then
  echo "✅ certbot 已安装"
else
  echo "安装 certbot..."
  apt-get install -y certbot python3-certbot-nginx
  echo "✅ certbot 安装完成"
fi

# 5. 复制项目到 /opt/knowledge-sea
echo ""
echo "📂 部署项目文件..."
PROJECT_DIR="/opt/knowledge-sea"
mkdir -p $PROJECT_DIR
if [ -f "$PROJECT_DIR/package.json" ] && [ -d "$PROJECT_DIR/node_modules" ]; then
  echo "✅ 项目已存在，跳过复制（如需更新请手动覆盖）"
else
  echo "⚠️ 请先将项目文件上传到服务器 /opt/knowledge-sea 目录"
  echo "   上传方法见《服务器部署指南.md》"
fi

# 6. 安装依赖
if [ -f "$PROJECT_DIR/package.json" ]; then
  echo ""
  echo "📦 安装依赖..."
  cd $PROJECT_DIR
  npm install --production
  echo "✅ 依赖安装完成"
fi

# 7. 配置 systemd 服务
echo ""
echo "⚙️ 配置系统服务..."
cp deploy/knowledge-sea.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable knowledge-sea
systemctl restart knowledge-sea
echo "✅ 服务已启动"

# 8. 配置 Nginx
echo ""
echo "⚙️ 配置 Nginx..."
cp deploy/nginx.conf /etc/nginx/sites-available/knowledge-sea
ln -sf /etc/nginx/sites-available/knowledge-sea /etc/nginx/sites-enabled/knowledge-sea
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "✅ Nginx 配置完成"

# 9. 申请 HTTPS 证书
echo ""
echo "🔒 申请 HTTPS 证书（需要域名已解析到本服务器）..."
certbot --nginx -d musouboshiasa.com -d www.musouboshiasa.com --non-interactive --agree-tos -m admin@musouboshiasa.com --redirect

echo ""
echo "========================================="
echo "🎉 部署完成！"
echo "   访问: https://musouboshiasa.com"
echo "========================================="
