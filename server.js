const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const archiver = require('archiver');
const http = require('http');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ Paths ============
const ROOT = __dirname;
const LEGACY_KB_DIR = path.join(ROOT, '知识点库');          // 旧版单用户数据根目录
const USERS_ROOT = path.join(ROOT, '知识点库', '用户');      // 多用户数据根目录
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const LEGACY_SETTINGS_FILE = path.join(ROOT, 'settings.json');
const LEGACY_CLOUD_CONFIG_FILE = path.join(ROOT, '云端', 'cloud-config.json');
const CLOUD_TRANSFER_DIR = path.join(ROOT, '云端', '中转');

const SESSION_COOKIE = 'ksea_token';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

// ============ Per-user context (AsyncLocalStorage) ============
const als = new AsyncLocalStorage();

function userPaths(username) {
  const userDir = path.join(USERS_ROOT, username);
  return {
    username,
    userDir,
    kbDir: userDir,
    storageDir: path.join(userDir, '储存文件'),
    imageDir: path.join(userDir, '图片'),
    fileIndex: path.join(userDir, '文件索引.json'),
    imageIndex: path.join(userDir, '图片索引.json'),
    settingsFile: path.join(userDir, 'settings.json'),
    cloudConfigFile: path.join(userDir, 'cloud-config.json')
  };
}

function getCtx() {
  const ctx = als.getStore();
  if (!ctx) throw new Error('无用户上下文');
  return ctx;
}

// ============ Middleware ============
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ Utility Functions ============

// HTTP(S) request that follows redirects (handles 301/302)
function cloudRequest(urlStr, { method, headers, body, binary } = {}) {
  return new Promise((resolve, reject) => {
    let remaining = 5;

    function doRequest(targetUrl) {
      const proto = targetUrl.protocol === 'https:' ? https : http;
      const opts = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: method || 'GET',
        headers: { ...(headers || {}) },
        rejectUnauthorized: false  // tolerate self-signed certs
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

      const req = proto.request(opts, (response) => {
        if (response.statusCode >= 301 && response.statusCode <= 302 && response.headers.location) {
          if (--remaining <= 0) return reject(new Error('Too many redirects'));
          return doRequest(new URL(response.headers.location, targetUrl));
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const data = binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf-8');
          resolve({ status: response.statusCode, body: data });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    }

    doRequest(new URL(urlStr));
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(filePath, defaultVal = []) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) { console.error('Load JSON error:', e.message); }
  return defaultVal;
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// Resolve a path strictly inside an image directory, rejecting path traversal.
function getImagePath(filename, p = getCtx()) {
  const base = path.resolve(p.imageDir);
  const target = path.resolve(p.imageDir, filename);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; } }
  });
  return out;
}

// ============ Users & Authentication ============

function loadUsers() {
  const data = loadJSON(USERS_FILE, { users: [] });
  return Array.isArray(data.users) ? data.users : [];
}

function saveUsers(users) {
  ensureDir(DATA_DIR);
  saveJSON(USERS_FILE, { users });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

function getSecret() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
  }
  return fs.readFileSync(SECRET_FILE, 'utf-8').trim();
}

function signToken(username) {
  const exp = Date.now() + SESSION_TTL;
  const payload = `${username}.${exp}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  try {
    const [payloadB64, sig] = String(token).split('.');
    if (!payloadB64 || !sig) return null;
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const idx = payload.lastIndexOf('.');
    if (idx < 0) return null;
    const username = payload.slice(0, idx);
    const exp = parseInt(payload.slice(idx + 1), 10);
    if (!username || !exp || Date.now() > exp) return null;
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    if (sig !== expected) return null;
    return username;
  } catch (_) { return null; }
}

function setSessionCookie(res, token, remember) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (remember) parts.push(`Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

const USERNAME_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,32}$/;

// Auth middleware: guard all /api/* except open auth endpoints.
const AUTH_OPEN_PATHS = ['/api/auth/status', '/api/auth/login', '/api/auth/setup'];
app.use('/api', (req, res, next) => {
  const pathname = req.originalUrl.split('?')[0];
  if (AUTH_OPEN_PATHS.includes(pathname)) return next();

  const token = parseCookies(req)[SESSION_COOKIE];
  const username = token ? verifyToken(token) : null;
  if (!username) return res.status(401).json({ error: '未登录' });

  const user = loadUsers().find(u => u.username === username);
  if (!user) return res.status(401).json({ error: '账号不存在' });

  const p = userPaths(username);
  ensureDir(p.storageDir);
  ensureDir(p.imageDir);
  als.run({ username, isAdmin: !!user.isAdmin, ...p }, () => next());
});

// ============ Knowledge Point File Format Parser ============

function parseKnowledgeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let section = null;
  let result = {
    number: '',
    name: '',
    content: [],
    prevRelated: [],
    nextRelated: []
  };

  for (const line of lines) {
    if (line.startsWith('（（结束））')) break;

    if (line.startsWith('（（编号区））')) { section = 'number'; continue; }
    if (line.startsWith('（（名称区））')) { section = 'name'; continue; }
    if (line.startsWith('（（正文区））')) { section = 'content'; continue; }
    if (line.startsWith('（（前相关区））')) { section = 'prev'; continue; }
    if (line.startsWith('（（后相关区））')) { section = 'next'; continue; }

    switch (section) {
      case 'number':
        result.number = line.trim();
        break;
      case 'name':
        result.name = line.trim();
        break;
      case 'content':
        result.content.push(line);
        break;
      case 'prev':
        if (line.trim()) {
          const match = line.match(/^-\s*(.+?)\s*：(.+?)\s*：\s*(.+)$/);
          if (match) result.prevRelated.push({ number: match[1], relation: match[2], name: match[3] });
        }
        break;
      case 'next':
        if (line.trim()) {
          const match = line.match(/^-\s*(.+?)\s*：(.+?)\s*：\s*(.+)$/);
          if (match) result.nextRelated.push({ number: match[1], relation: match[2], name: match[3] });
        }
        break;
    }
  }

  result.contentStr = result.content.join('\n').trim();
  return result;
}

function generateKnowledgeFile(data) {
  let file = '';
  file += '（（编号区））\n';
  file += (data.number || '') + '\n';
  file += '（（名称区））\n';
  file += (data.name || '') + '\n';
  file += '（（正文区））\n';
  file += (data.content || '') + '\n';
  file += '（（前相关区））\n';
  if (data.prevRelated) {
    for (const rel of data.prevRelated) {
      file += `- ${rel.number || ''}：${rel.relation || '无'}：${rel.name || ''}\n`;
    }
  }
  file += '（（后相关区））\n';
  if (data.nextRelated) {
    for (const rel of data.nextRelated) {
      file += `- ${rel.number || ''}：${rel.relation || '无'}：${rel.name || ''}\n`;
    }
  }
  file += '（（结束））\n';
  return file;
}

// ---- Reciprocal (bidirectional) relation helpers ----
function updateKpFile(number, updateFn, p = getCtx()) {
  const index = loadJSON(p.fileIndex);
  const entry = index.find(e => e.number === number);
  if (!entry) return;
  const fp = path.join(p.storageDir, entry.filename);
  if (!fs.existsSync(fp)) return;
  const data = parseKnowledgeFile(fp);
  updateFn(data);
  const fileData = {
    number: data.number,
    name: data.name,
    content: data.contentStr,
    prevRelated: data.prevRelated,
    nextRelated: data.nextRelated
  };
  fs.writeFileSync(fp, generateKnowledgeFile(fileData), 'utf-8');
}

function syncReciprocal(selfNumber, selfName, relatedNumber, relation, dir, p = getCtx()) {
  updateKpFile(relatedNumber, data => {
    const list = dir === 'next' ? data.nextRelated : data.prevRelated;
    const existing = list.find(r => r.number === selfNumber);
    if (existing) {
      existing.relation = relation || '无';
      existing.name = selfName;
    } else {
      list.push({ number: selfNumber, relation: relation || '无', name: selfName });
    }
  }, p);
}

function unsyncReciprocal(selfNumber, relatedNumber, dir, p = getCtx()) {
  updateKpFile(relatedNumber, data => {
    const list = dir === 'next' ? data.nextRelated : data.prevRelated;
    const idx = list.findIndex(r => r.number === selfNumber);
    if (idx >= 0) list.splice(idx, 1);
  }, p);
}

function syncAllReciprocal(selfNumber, selfName, prevRelated, nextRelated, oldPrev, oldNext, p = getCtx()) {
  (prevRelated || []).forEach(r => syncReciprocal(selfNumber, selfName, r.number, r.relation, 'next', p));
  (nextRelated || []).forEach(r => syncReciprocal(selfNumber, selfName, r.number, r.relation, 'prev', p));
  (oldPrev || []).forEach(r => {
    if (!(prevRelated || []).find(nr => nr.number === r.number))
      unsyncReciprocal(selfNumber, r.number, 'next', p);
  });
  (oldNext || []).forEach(r => {
    if (!(nextRelated || []).find(nr => nr.number === r.number))
      unsyncReciprocal(selfNumber, r.number, 'prev', p);
  });
}

function buildFilename(id, title) {
  return sanitizeFilename(`${id}：${title}.md`);
}

function getKpByNumber(number, p = getCtx()) {
  const index = loadJSON(p.fileIndex);
  const entry = index.find(e => e.number === number);
  if (!entry) return null;
  const filePath = path.join(p.storageDir, entry.filename);
  if (!fs.existsSync(filePath)) return null;
  const parsed = parseKnowledgeFile(filePath);
  return { ...parsed, filename: entry.filename };
}

// ============ Mind Map Data Generation ============

function getMindMapData(centerNumber, mode, forwardDepth = 1, backwardDepth = 1, p = getCtx()) {
  const index = loadJSON(p.fileIndex);
  const visited = new Set();
  const nodes = [];
  const edges = [];

  function getNode(number) {
    const entry = index.find(e => e.number === number);
    if (!entry) return null;
    const filePath = path.join(p.storageDir, entry.filename);
    if (!fs.existsSync(filePath)) return null;
    return parseKnowledgeFile(filePath);
  }

  function addNodeAndEdges(number, parentNum = null, relation = null, depth = 0, bwMax = 1, fwMax = 1, direction = 'forward') {
    if (depth > (direction === 'backward' ? bwMax : fwMax)) return;

    if (parentNum) {
      const edge = direction === 'backward'
        ? { from: number, to: parentNum, relation: relation || '无' }
        : { from: parentNum, to: number, relation: relation || '无' };
      edges.push(edge);
    }

    if (visited.has(number)) return;
    visited.add(number);

    const entry = index.find(e => e.number === number);
    const kp = getNode(number);
    if (!kp) return;

    const raw = kp.contentStr || '';
    const clean = raw
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/\n+/g, ' ')
      .trim();
    const contentPreview = clean.length > 60 ? clean.substring(0, 60) + '...' : (clean || '(无正文)');

    nodes.push({
      number: kp.number,
      name: entry.name,
      contentPreview: contentPreview,
      depth: depth
    });

    if (mode === 'surrounding' || mode === 'backward' || mode === 'free') {
      for (const rel of (kp.prevRelated || [])) {
        addNodeAndEdges(rel.number, number, rel.relation, depth + 1, bwMax, fwMax, 'backward');
      }
    }

    if (mode === 'surrounding' || mode === 'forward' || mode === 'free') {
      for (const rel of (kp.nextRelated || [])) {
        addNodeAndEdges(rel.number, number, rel.relation, depth + 1, bwMax, fwMax, 'forward');
      }
    }
  }

  if (mode === 'free' || mode === 'surrounding') {
    addNodeAndEdges(centerNumber, null, null, 0, backwardDepth, forwardDepth);
  } else {
    addNodeAndEdges(centerNumber, null, null, 0, forwardDepth, forwardDepth);
  }

  const edgeSet = new Set();
  const deduped = [];
  for (const e of edges) {
    const key = [e.from, e.to].sort().join('::');
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      deduped.push(e);
    }
  }

  return { nodes, edges: deduped, centerNumber };
}

// Update the file index (list all .md files)
function updateFileIndex(p = getCtx()) {
  const files = fs.readdirSync(p.storageDir).filter(f => f.endsWith('.md'));
  const index = [];
  for (const f of files) {
    const match = f.match(/^(.+?)：(.+)\.md$/);
    if (match) {
      const fp = path.join(p.storageDir, f);
      let realName = match[2];
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        const nameMatch = content.match(/（（名称区））\n(.+)\n/);
        if (nameMatch) realName = nameMatch[1].trim();
      } catch (_) {}
      index.push({ number: match[1], name: realName, filename: f });
    }
  }
  index.sort((a, b) => {
    const aParts = (a.number || '').split('-').map(s => parseInt(s) || 0);
    const bParts = (b.number || '').split('-').map(s => parseInt(s) || 0);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
      const va = aParts[i] || 0;
      const vb = bParts[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  });
  saveJSON(p.fileIndex, index);
  return index;
}

function updateImageIndex(p = getCtx()) {
  ensureDir(p.imageDir);
  const files = fs.readdirSync(p.imageDir);
  const validExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
  const index = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!validExts.includes(ext)) continue;
    const nameNoExt = path.basename(f, ext);
    const match = nameNoExt.match(/^(.+?)：(.+)$/);
    if (match) {
      index.push({ number: match[1], name: match[2], filename: f });
    } else {
      index.push({ number: '', name: nameNoExt, filename: f });
    }
  }
  saveJSON(p.imageIndex, index);
  return index;
}

// ============ Migration & Initialization ============

// Move legacy single-user data (知识点库/储存文件, 图片, ...) into a user's space.
function migrateLegacyData(username) {
  const p = userPaths(username);
  ensureDir(p.userDir);

  const moves = [
    { src: path.join(LEGACY_KB_DIR, '储存文件'), dst: p.storageDir },
    { src: path.join(LEGACY_KB_DIR, '图片'), dst: p.imageDir },
    { src: path.join(LEGACY_KB_DIR, '文件索引.json'), dst: p.fileIndex },
    { src: path.join(LEGACY_KB_DIR, '图片索引.json'), dst: p.imageIndex },
    { src: LEGACY_SETTINGS_FILE, dst: p.settingsFile }
  ];
  for (const m of moves) {
    if (!fs.existsSync(m.src)) continue;
    if (fs.existsSync(m.dst)) continue;
    try {
      fs.renameSync(m.src, m.dst);
      console.log(`迁移: ${m.src} -> ${m.dst}`);
    } catch (e) {
      console.error(`迁移失败: ${m.src} -> ${m.dst}: ${e.message}`);
    }
  }

  // cloud-config: only migrate domain/username (never the password)
  if (fs.existsSync(LEGACY_CLOUD_CONFIG_FILE)) {
    try {
      const legacy = loadJSON(LEGACY_CLOUD_CONFIG_FILE, {});
      const cfg = {
        domain: legacy.domain || '',
        username: legacy.username || '',
        password: '',
        saveCredentials: false
      };
      if (!fs.existsSync(p.cloudConfigFile)) saveJSON(p.cloudConfigFile, cfg);
    } catch (_) {}
  }
}

function initUserStorage(p) {
  ensureDir(p.storageDir);
  ensureDir(p.imageDir);
  updateFileIndex(p);
  updateImageIndex(p);
}

function initAll() {
  ensureDir(DATA_DIR);
  ensureDir(USERS_ROOT);
  ensureDir(CLOUD_TRANSFER_DIR);
  ensureDir(path.join(CLOUD_TRANSFER_DIR, '上传'));
  ensureDir(path.join(CLOUD_TRANSFER_DIR, '下载'));
  ensureDir(path.join(CLOUD_TRANSFER_DIR, '_temp_extract'));

  // If legacy data is still present, migrate it into the admin account.
  if (fs.existsSync(path.join(LEGACY_KB_DIR, '储存文件'))) {
    const admin = loadUsers().find(u => u.isAdmin);
    if (admin) migrateLegacyData(admin.username);
  }

  for (const u of loadUsers()) {
    try { initUserStorage(userPaths(u.username)); }
    catch (e) { console.error(`初始化用户 ${u.username} 失败:`, e.message); }
  }
}

// ============ Auth Routes ============

// Is the system initialized (has at least one account)?
app.get('/api/auth/status', (req, res) => {
  res.json({ initialized: loadUsers().length > 0 });
});

// First-run setup: create the admin account.
app.post('/api/auth/setup', (req, res) => {
  if (loadUsers().length > 0) return res.status(403).json({ error: '系统已初始化' });
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  if (!USERNAME_RE.test(String(username))) return res.status(400).json({ error: '账号只能包含中文、字母、数字、下划线或短横线（1-32位）' });
  if (String(password).length < 4) return res.status(400).json({ error: '密码至少 4 位' });

  const user = { username: String(username), passwordHash: hashPassword(password), isAdmin: true };
  saveUsers([user]);
  migrateLegacyData(String(username));
  initUserStorage(userPaths(String(username)));

  const token = signToken(String(username));
  setSessionCookie(res, token, remember !== false);
  res.json({ success: true, username: String(username), isAdmin: true });
});

// Login.
app.post('/api/auth/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  const user = loadUsers().find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = signToken(user.username);
  setSessionCookie(res, token, remember !== false);
  res.json({ success: true, username: user.username, isAdmin: !!user.isAdmin });
});

// Logout.
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// Current user info.
app.get('/api/auth/me', (req, res) => {
  const ctx = getCtx();
  res.json({ username: ctx.username, isAdmin: ctx.isAdmin });
});

// List users (admin only).
app.get('/api/auth/users', (req, res) => {
  const ctx = getCtx();
  if (!ctx.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
  res.json({ users: loadUsers().map(u => ({ username: u.username, isAdmin: !!u.isAdmin })) });
});

// Create a user (admin only).
app.post('/api/auth/users', (req, res) => {
  const ctx = getCtx();
  if (!ctx.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  if (!USERNAME_RE.test(String(username))) return res.status(400).json({ error: '账号只能包含中文、字母、数字、下划线或短横线（1-32位）' });
  if (String(password).length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '账号已存在' });
  users.push({ username: String(username), passwordHash: hashPassword(password), isAdmin: false });
  saveUsers(users);
  initUserStorage(userPaths(String(username)));
  res.json({ success: true });
});

// Change own password.
app.put('/api/auth/password', (req, res) => {
  const ctx = getCtx();
  const { oldPassword, newPassword } = req.body || {};
  const users = loadUsers();
  const user = users.find(u => u.username === ctx.username);
  if (!user || !verifyPassword(oldPassword, user.passwordHash)) return res.status(400).json({ error: '原密码错误' });
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  res.json({ success: true });
});

// ============ Knowledge Point Routes ============

app.get('/api/knowledge', (req, res) => {
  const p = getCtx();
  res.json(updateFileIndex(p));
});

app.get('/api/knowledge/search', (req, res) => {
  const p = getCtx();
  const q = (req.query.q || '').toLowerCase();
  const index = loadJSON(p.fileIndex);
  if (!q) return res.json(index);
  const results = index.filter(e =>
    e.number.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
  );
  res.json(results);
});

app.get('/api/knowledge/:number', (req, res) => {
  const p = getCtx();
  const number = decodeURIComponent(req.params.number);
  const kp = getKpByNumber(number, p);
  if (!kp) return res.status(404).json({ error: '知识点未找到' });
  const index = loadJSON(p.fileIndex);
  const nameMap = {};
  index.forEach(e => { nameMap[e.number] = e.name; });
  res.json({ ...kp, nameMap });
});

app.post('/api/knowledge', (req, res) => {
  const p = getCtx();
  const { number, name, content, prevRelated, nextRelated } = req.body;
  if (!number || !name) return res.status(400).json({ error: '编号和名称不能为空' });

  const safeName = sanitizeFilename(name);
  const filename = buildFilename(number, safeName);
  const filePath = path.join(p.storageDir, filename);

  if (fs.existsSync(filePath)) {
    return res.status(400).json({ error: '该编号的知识点已存在' });
  }

  const fileData = {
    number,
    name: name || '',
    content: content || '',
    prevRelated: prevRelated || [],
    nextRelated: nextRelated || []
  };
  const fileContent = generateKnowledgeFile(fileData);
  fs.writeFileSync(filePath, fileContent, 'utf-8');
  updateFileIndex(p);
  syncAllReciprocal(number, name, fileData.prevRelated, fileData.nextRelated, [], [], p);
  res.json({ success: true, number, name: safeName, filename });
});

app.put('/api/knowledge/:number', (req, res) => {
  const p = getCtx();
  const oldNumber = decodeURIComponent(req.params.number);
  const { number, name, content, prevRelated, nextRelated } = req.body;

  const index = loadJSON(p.fileIndex);
  const entry = index.find(e => e.number === oldNumber);
  if (!entry) return res.status(404).json({ error: '知识点未找到' });

  const oldPath = path.join(p.storageDir, entry.filename);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: '文件不存在' });

  const oldData = parseKnowledgeFile(oldPath);
  const oldPrev = oldData.prevRelated || [];
  const oldNext = oldData.nextRelated || [];

  const newNumber = number || oldNumber;
  const newName = name || entry.name;
  const safeName = sanitizeFilename(newName);
  const newFilename = buildFilename(newNumber, safeName);
  const newPath = path.join(p.storageDir, newFilename);

  const fileData = {
    number: newNumber,
    name: newName,
    content: content !== undefined ? content : '',
    prevRelated: prevRelated || [],
    nextRelated: nextRelated || []
  };
  const fileContent = generateKnowledgeFile(fileData);
  fs.writeFileSync(newPath, fileContent, 'utf-8');

  if (oldPath !== newPath) {
    fs.unlinkSync(oldPath);
  }

  if (oldNumber !== newNumber) {
    updateReferences(oldNumber, newNumber, newName, p);
  }

  syncAllReciprocal(newNumber, newName, fileData.prevRelated, fileData.nextRelated, oldPrev, oldNext, p);
  updateFileIndex(p);
  res.json({ success: true, number: newNumber, name: safeName, filename: newFilename });
});

app.delete('/api/knowledge/:number', (req, res) => {
  const p = getCtx();
  const number = decodeURIComponent(req.params.number);
  const index = loadJSON(p.fileIndex);
  const entry = index.find(e => e.number === number);
  if (!entry) return res.status(404).json({ error: '知识点未找到' });

  const filePath = path.join(p.storageDir, entry.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  removeReferences(number, p);

  updateFileIndex(p);
  res.json({ success: true });
});

app.get('/api/knowledge/:number/mindmap', (req, res) => {
  const p = getCtx();
  const number = decodeURIComponent(req.params.number);
  const mode = req.query.mode || 'forward';
  const forwardDepth = parseInt(req.query.forwardDepth) || 1;
  const backwardDepth = parseInt(req.query.backwardDepth) || 1;

  res.json(getMindMapData(number, mode, forwardDepth, backwardDepth, p));
});

// ============ Image Routes ============

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, getCtx().imageDir); }
      catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `_tmp_upload_${Date.now()}${ext.toLowerCase()}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.get('/api/images', (req, res) => {
  const p = getCtx();
  res.json(updateImageIndex(p));
});

app.get('/api/images/search', (req, res) => {
  const p = getCtx();
  const q = (req.query.q || '').toLowerCase();
  const index = updateImageIndex(p);
  if (!q) return res.json(index);
  const results = index.filter(e =>
    e.number.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
  );
  res.json(results);
});

app.post('/api/images/upload', imageUpload.single('image'), (req, res) => {
  const p = getCtx();
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const { number, name } = req.body;
  const safeName = sanitizeFilename(name || '未命名');
  const safeNumber = sanitizeFilename(number || '');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const newFilename = `${safeNumber}：${safeName}${ext}`;
  const newPath = path.join(p.imageDir, newFilename);

  let finalPath = newPath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(p.imageDir, `${safeNumber}：${safeName}(${counter})${ext}`);
    counter++;
  }

  fs.renameSync(req.file.path, finalPath);
  updateImageIndex(p);
  const finalFilename = path.basename(finalPath);
  res.json({ success: true, filename: finalFilename, number: safeNumber, name: safeName });
});

app.put('/api/images/:filename', (req, res) => {
  const p = getCtx();
  const oldFilename = decodeURIComponent(req.params.filename);
  const { number, name } = req.body;
  const oldPath = getImagePath(oldFilename, p);
  if (!oldPath || !fs.existsSync(oldPath)) return res.status(404).json({ error: '图片未找到' });

  const ext = path.extname(oldFilename);
  const safeName = sanitizeFilename(name || '');
  const safeNumber = sanitizeFilename(number || '');
  const newFilename = `${safeNumber}：${safeName}${ext}`;
  const newPath = path.join(p.imageDir, newFilename);

  if (oldPath !== newPath) {
    if (fs.existsSync(newPath)) return res.status(400).json({ error: '同名图片已存在' });
    fs.renameSync(oldPath, newPath);
  }
  updateImageIndex(p);
  res.json({ success: true, filename: newFilename });
});

app.get('/api/images/file/:filename', (req, res) => {
  const p = getCtx();
  const filename = decodeURIComponent(req.params.filename);
  const filePath = getImagePath(filename, p);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.delete('/api/images/:filename', (req, res) => {
  const p = getCtx();
  const filename = decodeURIComponent(req.params.filename);
  const filePath = getImagePath(filename, p);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '图片未找到' });
  try { fs.unlinkSync(filePath); } catch (e) { return res.status(500).json({ error: '删除失败: ' + e.message }); }
  updateImageIndex(p);
  res.json({ success: true });
});

// ============ Settings (per user) ============

app.get('/api/settings', (req, res) => {
  const p = getCtx();
  const settings = loadJSON(p.settingsFile, {
    signature: '',
    signatureFont: 'sans-serif',
    refreshRate: 60,
    language: 'zh-CN'
  });
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  const p = getCtx();
  saveJSON(p.settingsFile, req.body);
  res.json({ success: true });
});

// ============ Cloud Sync (per user) ============

app.get('/api/cloud-config', (req, res) => {
  const p = getCtx();
  const config = loadJSON(p.cloudConfigFile, {
    domain: '',
    username: '',
    password: '',
    saveCredentials: false
  });
  res.json(config);
});

app.put('/api/cloud-config', (req, res) => {
  const p = getCtx();
  const config = req.body;
  if (!config.saveCredentials) config.password = '';
  saveJSON(p.cloudConfigFile, config);
  res.json({ success: true });
});

app.post('/api/cloud/upload', async (req, res) => {
  const p = getCtx();
  try {
    const config = loadJSON(p.cloudConfigFile);
    if (!config.domain) return res.status(400).json({ error: '请先配置云端服务器' });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeUser = encodeURIComponent(config.username || 'user');
    const zipFilename = `${timestamp}_${safeUser}_knowledge.zip`;
    const zipPath = path.join(CLOUD_TRANSFER_DIR, '上传', zipFilename);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(p.kbDir, '知识点库');
      archive.finalize();
    });

    const zipContent = fs.readFileSync(zipPath);
    const safeFilename = Buffer.from(zipFilename, 'utf-8').toString('base64');
    const url = `${config.domain}/transfer/api/upload?name=${encodeURIComponent(safeFilename)}`;

    const result = await cloudRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64')
      },
      body: zipContent
    });

    try { fs.unlinkSync(zipPath); } catch (_) {}

    if (result.status < 200 || result.status >= 300) {
      let errMsg = 'HTTP ' + result.status;
      try { errMsg = JSON.parse(result.body).error || errMsg; } catch (_) {}
      return res.status(502).json({ error: '上传失败: ' + errMsg });
    }
    res.json({ success: true, message: '上传成功' });
  } catch (err) {
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});

app.post('/api/cloud/download', async (req, res) => {
  const p = getCtx();
  try {
    const config = loadJSON(p.cloudConfigFile);
    if (!config.domain) return res.status(400).json({ error: '请先配置云端服务器' });

    const authHeader = { 'Authorization': 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64') };

    const listResult = await cloudRequest(`${config.domain}/transfer/api/list`, { headers: authHeader });
    if (listResult.status === 401) throw new Error('云端认证失败，请检查账号和密码');
    if (listResult.status < 200 || listResult.status >= 300) {
      let errMsg = 'HTTP ' + listResult.status;
      try { errMsg = JSON.parse(listResult.body).error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }
    let fileList;
    try { fileList = JSON.parse(listResult.body); } catch { throw new Error('Invalid response: ' + listResult.body.substring(0, 200)); }

    const files = fileList.files || [];
    const safeUser = encodeURIComponent(config.username || 'user');
    const userFiles = files.filter(f => f.includes(safeUser)).sort().reverse();
    if (userFiles.length === 0) return res.status(404).json({ error: '云端没有备份文件' });

    const latestFile = userFiles[0];

    const downloadUrl = `${config.domain}/transfer/api/download/${encodeURIComponent(latestFile)}`;
    const dlResult = await cloudRequest(downloadUrl, { headers: authHeader, binary: true });
    if (dlResult.status === 401) throw new Error('云端认证失败，请检查账号和密码');
    if (dlResult.status !== 200) {
      let errMsg = 'HTTP ' + dlResult.status;
      try {
        const bodyStr = Buffer.isBuffer(dlResult.body) ? dlResult.body.toString('utf-8') : String(dlResult.body);
        const parsed = JSON.parse(bodyStr);
        if (parsed && parsed.error) errMsg = parsed.error;
      } catch (_) {}
      throw new Error('下载失败: ' + errMsg);
    }
    const fileData = dlResult.body;

    const zipPath = path.join(CLOUD_TRANSFER_DIR, '下载', latestFile);
    fs.writeFileSync(zipPath, fileData);

    const extractDir = path.join(CLOUD_TRANSFER_DIR, '_temp_extract');
    const extract = require('extract-zip');
    await extract(zipPath, { dir: extractDir });

    // Back up current local data before overwriting.
    const backupDir = path.join(CLOUD_TRANSFER_DIR, '本地备份');
    ensureDir(backupDir);
    const backupName = `本地备份_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const backupPath = path.join(backupDir, backupName);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(p.kbDir, '知识点库');
      archive.finalize();
    });

    const tempKb = path.join(extractDir, '知识点库');
    if (fs.existsSync(tempKb)) {
      ensureDir(p.kbDir);
      copyDirSync(tempKb, p.kbDir);
      const newFiles = new Set();
      const scanDir = (d) => {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          if (fs.statSync(fp).isDirectory()) scanDir(fp);
          else newFiles.add(path.relative(tempKb, fp));
        }
      };
      scanDir(tempKb);
      const cleanDir = (d) => {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          const rel = path.relative(p.kbDir, fp);
          if (fs.statSync(fp).isDirectory()) {
            cleanDir(fp);
            if (fs.readdirSync(fp).length === 0) try { fs.rmdirSync(fp); } catch (_) {}
          } else if (!newFiles.has(rel)) {
            try { fs.unlinkSync(fp); } catch (_) {}
          }
        }
      };
      if (fs.existsSync(p.kbDir)) cleanDir(p.kbDir);
    }

    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipPath); } catch (_) {}

    updateFileIndex(p);
    updateImageIndex(p);
    res.json({ success: true, message: '下载成功，本地知识点库已更新' });
  } catch (err) {
    res.status(500).json({ error: '下载失败: ' + err.message });
  }
});

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============ Helper: Update/Remove References ============

function updateReferences(oldNumber, newNumber, newName, p = getCtx()) {
  const index = loadJSON(p.fileIndex);
  for (const entry of index) {
    if (entry.number === oldNumber) continue;
    const fp = path.join(p.storageDir, entry.filename);
    if (!fs.existsSync(fp)) continue;
    let kp = parseKnowledgeFile(fp);

    let changed = false;
    const updateRel = (relList) => {
      for (const rel of relList) {
        if (rel.number === oldNumber) {
          rel.number = newNumber;
          rel.name = newName;
          changed = true;
        }
      }
    };

    updateRel(kp.prevRelated);
    updateRel(kp.nextRelated);

    if (changed) {
      const fileData = {
        number: kp.number,
        name: kp.name || "",
        content: kp.contentStr,
        prevRelated: kp.prevRelated,
        nextRelated: kp.nextRelated
      };
      fs.writeFileSync(fp, generateKnowledgeFile(fileData), 'utf-8');
    }
  }
}

function removeReferences(number, p = getCtx()) {
  const index = loadJSON(p.fileIndex);
  for (const entry of index) {
    const fp = path.join(p.storageDir, entry.filename);
    if (!fs.existsSync(fp)) continue;
    let kp = parseKnowledgeFile(fp);
    let changed = false;

    const prevLen = kp.prevRelated.length;
    const nextLen = kp.nextRelated.length;
    kp.prevRelated = kp.prevRelated.filter(r => r.number !== number);
    kp.nextRelated = kp.nextRelated.filter(r => r.number !== number);
    changed = kp.prevRelated.length !== prevLen || kp.nextRelated.length !== nextLen;

    if (changed) {
      const fileData = {
        number: kp.number,
        name: kp.name || "",
        content: kp.contentStr,
        prevRelated: kp.prevRelated,
        nextRelated: kp.nextRelated
      };
      fs.writeFileSync(fp, generateKnowledgeFile(fileData), 'utf-8');
    }
  }
}

// ============ Serve Frontend ============

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ Start ============

initAll();

app.listen(PORT, () => {
  console.log(`🌊 知识之海 已启航！`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`👥 多用户数据目录: ${USERS_ROOT}`);
});
