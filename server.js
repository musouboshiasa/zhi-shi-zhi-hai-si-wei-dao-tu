const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const archiver = require('archiver');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Paths
const KB_DIR = path.join(__dirname, '知识点库');
const STORAGE_DIR = path.join(KB_DIR, '储存文件');
const IMAGE_DIR = path.join(KB_DIR, '图片');
const FILE_INDEX = path.join(KB_DIR, '文件索引.json');
const IMAGE_INDEX = path.join(KB_DIR, '图片索引.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const CLOUD_CONFIG_FILE = path.join(__dirname, '云端', 'cloud-config.json');
const CLOUD_TRANSFER_DIR = path.join(__dirname, '云端', '中转');

// Image static serving
app.use('/图片', express.static(IMAGE_DIR));
app.use('/api/images/file', express.static(IMAGE_DIR));

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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// Resolve a path strictly inside IMAGE_DIR, rejecting path traversal (e.g. "../").
// Returns the absolute path, or null if the filename tries to escape IMAGE_DIR.
function getImagePath(filename) {
  const base = path.resolve(IMAGE_DIR);
  const target = path.resolve(IMAGE_DIR, filename);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

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
function updateKpFile(number, updateFn) {
  const index = loadJSON(FILE_INDEX);
  const entry = index.find(e => e.number === number);
  if (!entry) return;
  const fp = path.join(STORAGE_DIR, entry.filename);
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

function syncReciprocal(selfNumber, selfName, relatedNumber, relation, dir) {
  // dir: 'next' = add self to target's nextRelated; 'prev' = add self to target's prevRelated
  updateKpFile(relatedNumber, data => {
    const list = dir === 'next' ? data.nextRelated : data.prevRelated;
    const existing = list.find(r => r.number === selfNumber);
    if (existing) {
      existing.relation = relation || '无';
      existing.name = selfName;
    } else {
      list.push({ number: selfNumber, relation: relation || '无', name: selfName });
    }
  });
}

function unsyncReciprocal(selfNumber, relatedNumber, dir) {
  updateKpFile(relatedNumber, data => {
    const list = dir === 'next' ? data.nextRelated : data.prevRelated;
    const idx = list.findIndex(r => r.number === selfNumber);
    if (idx >= 0) list.splice(idx, 1);
  });
}

function syncAllReciprocal(selfNumber, selfName, prevRelated, nextRelated, oldPrev, oldNext) {
  // Add/update new reciprocal links
  (prevRelated || []).forEach(r => syncReciprocal(selfNumber, selfName, r.number, r.relation, 'next'));
  (nextRelated || []).forEach(r => syncReciprocal(selfNumber, selfName, r.number, r.relation, 'prev'));
  // Remove old ones that are no longer present
  (oldPrev || []).forEach(r => {
    if (!(prevRelated || []).find(nr => nr.number === r.number))
      unsyncReciprocal(selfNumber, r.number, 'next');
  });
  (oldNext || []).forEach(r => {
    if (!(nextRelated || []).find(nr => nr.number === r.number))
      unsyncReciprocal(selfNumber, r.number, 'prev');
  });
}

function buildFilename(id, title) {
  return sanitizeFilename(`${id}：${title}.md`);
}

// Gets a knowledge point by ID from file index
function getKpByNumber(number) {
  const index = loadJSON(FILE_INDEX);
  const entry = index.find(e => e.number === number);
  if (!entry) return null;
  const filePath = path.join(STORAGE_DIR, entry.filename);
  if (!fs.existsSync(filePath)) return null;
  const parsed = parseKnowledgeFile(filePath);
  return { ...parsed, filename: entry.filename };
}

// ============ Mind Map Data Generation ============

function getMindMapData(centerNumber, mode, forwardDepth = 1, backwardDepth = 1) {
  const index = loadJSON(FILE_INDEX);
  const visited = new Set();
  const nodes = [];
  const edges = [];

  function getNode(number) {
    const entry = index.find(e => e.number === number);
    if (!entry) return null;
    const filePath = path.join(STORAGE_DIR, entry.filename);
    if (!fs.existsSync(filePath)) return null;
    return parseKnowledgeFile(filePath);
  }

  function addNodeAndEdges(number, parentNum = null, relation = null, depth = 0, bwMax = 1, fwMax = 1, direction = 'forward') {
    if (depth > (direction === 'backward' ? bwMax : fwMax)) return;

    // Add a directed edge before the visited check so cycles are still linked.
    // Arrows always point to the "后相关" (next) node, so a backward traversal
    // means `number` (prev) points to `parentNum`.
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

  // Deduplicate reciprocal edges (A→B and B→A → keep only one)
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
function updateFileIndex() {
  const files = fs.readdirSync(STORAGE_DIR).filter(f => f.endsWith('.md'));
  const index = [];
  for (const f of files) {
    const match = f.match(/^(.+?)：(.+)\.md$/);
    if (match) {
      // Read original name from file name section if available
      const fp = path.join(STORAGE_DIR, f);
      let realName = match[2];
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        const nameMatch = content.match(/（（名称区））\n(.+)\n/);
        if (nameMatch) realName = nameMatch[1].trim();
      } catch (_) {}
      index.push({ number: match[1], name: realName, filename: f });
    }
  }
  // Hierarchical numeric sort: split by '-' and compare each part numerically
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
  saveJSON(FILE_INDEX, index);
  return index;
}

function updateImageIndex() {
  ensureDir(IMAGE_DIR);
  const files = fs.readdirSync(IMAGE_DIR);
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
  saveJSON(IMAGE_INDEX, index);
  return index;
}

// Initialize
ensureDir(STORAGE_DIR);
ensureDir(IMAGE_DIR);
ensureDir(CLOUD_TRANSFER_DIR);
ensureDir(path.join(CLOUD_TRANSFER_DIR, '上传'));
ensureDir(path.join(CLOUD_TRANSFER_DIR, '下载'));
ensureDir(path.join(CLOUD_TRANSFER_DIR, '_temp_extract'));
updateFileIndex();
updateImageIndex();

// ============ API Routes ============

// --- Knowledge Points ---

// List all knowledge points
app.get('/api/knowledge', (req, res) => {
  const index = updateFileIndex();
  res.json(index);
});

// Search knowledge points
app.get('/api/knowledge/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const index = loadJSON(FILE_INDEX);
  if (!q) return res.json(index);
  const results = index.filter(e =>
    e.number.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
  );
  res.json(results);
});

// Get a specific knowledge point
app.get('/api/knowledge/:number', (req, res) => {
  const number = decodeURIComponent(req.params.number);
  const kp = getKpByNumber(number);
  if (!kp) return res.status(404).json({ error: '知识点未找到' });
  // Get names for related points
  const index = loadJSON(FILE_INDEX);
  const nameMap = {};
  index.forEach(e => { nameMap[e.number] = e.name; });
  res.json({ ...kp, nameMap });
});

// Create a new knowledge point
app.post('/api/knowledge', (req, res) => {
  const { number, name, content, prevRelated, nextRelated } = req.body;
  if (!number || !name) return res.status(400).json({ error: '编号和名称不能为空' });

  const safeName = sanitizeFilename(name);
  const filename = buildFilename(number, safeName);
  const filePath = path.join(STORAGE_DIR, filename);

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
  updateFileIndex();
  syncAllReciprocal(number, name, fileData.prevRelated, fileData.nextRelated, [], []);
  res.json({ success: true, number, name: safeName, filename });
});

// Update a knowledge point
app.put('/api/knowledge/:number', (req, res) => {
  const oldNumber = decodeURIComponent(req.params.number);
  const { number, name, content, prevRelated, nextRelated } = req.body;

  const index = loadJSON(FILE_INDEX);
  const entry = index.find(e => e.number === oldNumber);
  if (!entry) return res.status(404).json({ error: '知识点未找到' });

  const oldPath = path.join(STORAGE_DIR, entry.filename);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: '文件不存在' });

  // Parse old data before overwriting
  const oldData = parseKnowledgeFile(oldPath);
  const oldPrev = oldData.prevRelated || [];
  const oldNext = oldData.nextRelated || [];

  const newNumber = number || oldNumber;
  const newName = name || entry.name;
  const safeName = sanitizeFilename(newName);
  const newFilename = buildFilename(newNumber, safeName);
  const newPath = path.join(STORAGE_DIR, newFilename);

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

  // Update references in other files
  if (oldNumber !== newNumber) {
    updateReferences(oldNumber, newNumber, newName);
  }

  syncAllReciprocal(newNumber, newName, fileData.prevRelated, fileData.nextRelated, oldPrev, oldNext);
  updateFileIndex();
  res.json({ success: true, number: newNumber, name: safeName, filename: newFilename });
});

// Delete a knowledge point
app.delete('/api/knowledge/:number', (req, res) => {
  const number = decodeURIComponent(req.params.number);
  const index = loadJSON(FILE_INDEX);
  const entry = index.find(e => e.number === number);
  if (!entry) return res.status(404).json({ error: '知识点未找到' });

  const filePath = path.join(STORAGE_DIR, entry.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  // Remove references from other files
  removeReferences(number);

  updateFileIndex();
  res.json({ success: true });
});

// Get mind map data
app.get('/api/knowledge/:number/mindmap', (req, res) => {
  const number = decodeURIComponent(req.params.number);
  const mode = req.query.mode || 'forward';
  const forwardDepth = parseInt(req.query.forwardDepth) || 1;
  const backwardDepth = parseInt(req.query.backwardDepth) || 1;

  const data = getMindMapData(number, mode, forwardDepth, backwardDepth);
  res.json(data);
});

// --- Images ---

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMAGE_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const safeExt = ext.toLowerCase();
      cb(null, `_tmp_upload_${Date.now()}${safeExt}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// List images
app.get('/api/images', (req, res) => {
  const index = updateImageIndex();
  res.json(index);
});

// Search images
app.get('/api/images/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const index = updateImageIndex();
  if (!q) return res.json(index);
  const results = index.filter(e =>
    e.number.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
  );
  res.json(results);
});

// Upload image
app.post('/api/images/upload', imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const { number, name } = req.body;
  const safeName = sanitizeFilename(name || '未命名');
  const safeNumber = sanitizeFilename(number || '');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const newFilename = `${safeNumber}：${safeName}${ext}`;
  const newPath = path.join(IMAGE_DIR, newFilename);

  // Handle duplicate names
  let finalPath = newPath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(IMAGE_DIR, `${safeNumber}：${safeName}(${counter})${ext}`);
    counter++;
  }

  fs.renameSync(req.file.path, finalPath);
  updateImageIndex();
  const finalFilename = path.basename(finalPath);
  res.json({ success: true, filename: finalFilename, number: safeNumber, name: safeName });
});

// Update image info
app.put('/api/images/:filename', (req, res) => {
  const oldFilename = decodeURIComponent(req.params.filename);
  const { number, name } = req.body;
  const oldPath = getImagePath(oldFilename);
  if (!oldPath || !fs.existsSync(oldPath)) return res.status(404).json({ error: '图片未找到' });

  const ext = path.extname(oldFilename);
  const safeName = sanitizeFilename(name || '');
  const safeNumber = sanitizeFilename(number || '');
  const newFilename = `${safeNumber}：${safeName}${ext}`;
  const newPath = path.join(IMAGE_DIR, newFilename);

  if (oldPath !== newPath) {
    if (fs.existsSync(newPath)) return res.status(400).json({ error: '同名图片已存在' });
    fs.renameSync(oldPath, newPath);
  }
  updateImageIndex();
  res.json({ success: true, filename: newFilename });
});

// Serve image files
app.get('/api/images/file/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = getImagePath(filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Delete image
app.delete('/api/images/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = getImagePath(filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '图片未找到' });
  try { fs.unlinkSync(filePath); } catch (e) { return res.status(500).json({ error: '删除失败: ' + e.message }); }
  updateImageIndex();
  res.json({ success: true });
});

// --- Settings ---

app.get('/api/settings', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {
    signature: '',
    signatureFont: 'sans-serif',
    refreshRate: 60,
    language: 'zh-CN'
  });
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  const settings = req.body;
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true });
});

// --- Cloud Sync ---

app.get('/api/cloud-config', (req, res) => {
  const config = loadJSON(CLOUD_CONFIG_FILE, {
    domain: '',
    username: '',
    password: '',
    saveCredentials: false
  });
  res.json(config);
});

app.put('/api/cloud-config', (req, res) => {
  const config = req.body;
  // Only persist the password when the user explicitly opts in ("记住登录信息"),
  // so credentials are not silently written to disk in plaintext.
  if (!config.saveCredentials) config.password = '';
  saveJSON(CLOUD_CONFIG_FILE, config);
  res.json({ success: true });
});

// Upload to cloud
app.post('/api/cloud/upload', async (req, res) => {
  try {
    const config = loadJSON(CLOUD_CONFIG_FILE);
    if (!config.domain) return res.status(400).json({ error: '请先配置云端服务器' });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeUser = encodeURIComponent(config.username || 'user');
    const zipFilename = `${timestamp}_${safeUser}_knowledge.zip`;
    const zipPath = path.join(CLOUD_TRANSFER_DIR, '上传', zipFilename);

    // Create zip
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(KB_DIR, '知识点库');
      archive.finalize();
    });

    // Upload to cloud server
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

    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore cleanup failure */ }

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

// Download from cloud
app.post('/api/cloud/download', async (req, res) => {
  try {
    const config = loadJSON(CLOUD_CONFIG_FILE);
    if (!config.domain) return res.status(400).json({ error: '请先配置云端服务器' });

    const authHeader = { 'Authorization': 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64') };

    // Get file list
    const listResult = await cloudRequest(`${config.domain}/transfer/api/list`, { headers: authHeader });
    if (listResult.status === 401) throw new Error('云端认证失败，请检查账号和密码');
    if (listResult.status < 200 || listResult.status >= 300) {
      let errMsg = 'HTTP ' + listResult.status;
      try { errMsg = JSON.parse(listResult.body).error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }
    let fileList;
    try { fileList = JSON.parse(listResult.body); } catch { throw new Error('Invalid response: ' + listResult.body.substring(0, 200)); }

    // Find the most recent backup
    const files = fileList.files || [];
    const safeUser = encodeURIComponent(config.username || 'user');
    const userFiles = files.filter(f => f.includes(safeUser)).sort().reverse();
    if (userFiles.length === 0) return res.status(404).json({ error: '云端没有备份文件' });

    const latestFile = userFiles[0];

    // Download the file
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
    const fileData = dlResult.body; // already a Buffer

    // Save and extract
    const zipPath = path.join(CLOUD_TRANSFER_DIR, '下载', latestFile);
    fs.writeFileSync(zipPath, fileData);

    // Extract
    const extractDir = path.join(CLOUD_TRANSFER_DIR, '_temp_extract');
    const extract = require('extract-zip');
    await extract(zipPath, { dir: extractDir });

    // Back up the current local knowledge base before overwriting, so a bad
    // download can be rolled back.
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
      archive.directory(KB_DIR, '知识点库');
      archive.finalize();
    });

    // Replace current KB — copy new files, then remove stale ones individually
    const tempKb = path.join(extractDir, '知识点库');
    if (fs.existsSync(tempKb)) {
      ensureDir(KB_DIR);
      // First: copy new files over (overwrite existing)
      copyDirSync(tempKb, KB_DIR);
      // Second: remove old files that don't exist in new data
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
          const rel = path.relative(KB_DIR, fp);
          if (fs.statSync(fp).isDirectory()) {
            cleanDir(fp);
            if (fs.readdirSync(fp).length === 0) try { fs.rmdirSync(fp); } catch (_) {}
          } else if (!newFiles.has(rel)) {
            try { fs.unlinkSync(fp); } catch (_) {}
          }
        }
      };
      if (fs.existsSync(KB_DIR)) cleanDir(KB_DIR);
    }

    // Cleanup (safe-delete may fail, ignore)
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipPath); } catch (_) {}

    updateFileIndex();
    updateImageIndex();
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

function updateReferences(oldNumber, newNumber, newName) {
  const index = loadJSON(FILE_INDEX);
  for (const entry of index) {
    if (entry.number === oldNumber) continue;
    const fp = path.join(STORAGE_DIR, entry.filename);
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

function removeReferences(number) {
  const index = loadJSON(FILE_INDEX);
  for (const entry of index) {
    const fp = path.join(STORAGE_DIR, entry.filename);
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

// Start server
app.listen(PORT, () => {
  console.log(`🌊 知识之海 已启航！`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`📚 知识点库: ${STORAGE_DIR}`);
});
