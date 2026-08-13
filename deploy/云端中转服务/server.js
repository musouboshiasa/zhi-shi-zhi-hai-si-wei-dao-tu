// ============================================
// 知识之海 - 云端中转服务（部署在 musouboshiasa.com 服务器 3456 端口）
// 响应主应用请求：/transfer/api/upload、/transfer/api/list、/transfer/api/download/*
// 同时提供首页展示备份文件列表
// 启动: node server.js （或用 systemd 管理）
// ============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// 确保目录存在
[UPLOAD_DIR, DATA_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// 初始化用户数据（默认账号，部署后可修改）
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({
    users: [
      { username: 'musouboshiasa', password: '【已移除】', dir: 'musouboshiasa_知识库' }
    ]
  }, null, 2));
}

// 验证用户（Basic Auth）
function authUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  const base64 = authHeader.substring(6);
  const [username, password] = Buffer.from(base64, 'base64').toString().split(':');
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    const user = data.users.find(u => u.username === username && u.password === password);
    return user || null;
  } catch (_) { return null; }
}

// ICP 备案号
const ICP = '辽ICP备2026015611号-1';

// 首页 HTML（展示备份文件列表）
function getHomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知识之海 · 云端</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background: #f0f4f8; min-height: 100vh; display: flex; flex-direction: column; }
.container { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; }
.card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); padding: 48px 40px; max-width: 520px; width: 100%; text-align: center; }
.icon { font-size: 64px; margin-bottom: 16px; }
h1 { font-size: 28px; color: #1a2332; margin-bottom: 8px; }
.sub { color: #8a9bb0; font-size: 14px; margin-bottom: 32px; }
.files { text-align: left; border-top: 1px solid #e8ecf0; padding-top: 20px; margin-top: 20px; }
.files a { display: block; padding: 10px 12px; color: #3b82f6; text-decoration: none; border-radius: 8px; font-size: 14px; }
.files a:hover { background: #eff6ff; }
.footer { text-align: center; padding: 20px; color: #8a9bb0; font-size: 12px; border-top: 1px solid #e8ecf0; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <div class="icon">🌊</div>
    <h1>知识之海 · 云端</h1>
    <p class="sub">知识之海 云端存储节点</p>
    <div class="files" id="fileList">加载中...</div>
  </div>
</div>
<div class="footer">${ICP}</div>
<script>
fetch('/transfer/api/list', { headers: { 'Authorization': 'Basic ' + btoa('musouboshiasa:【已移除】') } })
  .then(r => r.json())
  .then(d => {
    const el = document.getElementById('fileList');
    const files = d.files || [];
    if (files.length === 0) { el.innerHTML = '暂无备份文件'; return; }
    el.innerHTML = files.map(f => '<a href="/transfer/api/download/' + encodeURIComponent(f) + '" target="_blank">📦 ' + f + '</a>').join('');
  })
  .catch(() => { document.getElementById('fileList').innerHTML = '加载失败'; });
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 首页
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHomePage());
    return;
  }

  // 认证检查（ping 除外）
  if (pathname !== '/transfer/api/ping') {
    const user = authUser(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '认证失败' }));
      return;
    }
    req.user = user;
  }

  try {
    // 上传
    if (pathname === '/transfer/api/upload' && req.method === 'POST') {
      let filename = `backup_${Date.now()}.zip`;
      if (parsedUrl.query.name) {
        filename = Buffer.from(decodeURIComponent(parsedUrl.query.name), 'base64').toString('utf-8');
      }
      const userDir = path.join(UPLOAD_DIR, req.user.dir);
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
      const destPath = path.join(userDir, filename);

      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(destPath, buffer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename }));
      });
      return;
    }

    // 文件列表
    if (pathname === '/transfer/api/list' && req.method === 'GET') {
      const userDir = path.join(UPLOAD_DIR, req.user.dir);
      if (!fs.existsSync(userDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      const files = fs.readdirSync(userDir).sort((a, b) => b.localeCompare(a));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
      return;
    }

    // 下载
    if (pathname.startsWith('/transfer/api/download/') && req.method === 'GET') {
      const filename = decodeURIComponent(pathname.replace('/transfer/api/download/', ''));
      const userDir = path.join(UPLOAD_DIR, req.user.dir);
      const filePath = path.join(userDir, filename);

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }

      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 健康检查
    if (pathname === '/transfer/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log('知识之海 云端服务已启动，端口：' + PORT);
  console.log('上传目录：' + UPLOAD_DIR);
  console.log('用户配置：' + USERS_FILE);
});
