// ========== The Sea of Knowledge - Main App ==========

// 子路径适配：把绝对路径 /api/xxx 转为相对路径 api/xxx，
// 配合 <base> 标签即可在任意子路径（如 /ruanjian/）下部署
const resolvePath = (url) => url.replace(/^\/api\//, 'api/');

const API = {
  async _req(url, opts) {
    let res;
    try {
      res = await fetch(resolvePath(url), opts);
    } catch (e) {
      throw new Error('网络错误，请检查连接');
    }
    if (res.status === 401 && !url.includes('/api/auth/')) {
      showLoginPage();
      throw new Error('登录已过期，请重新登录');
    }
    if (!res.ok) {
      let msg = '请求失败';
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  },
  get(url) { return this._req(url); },
  post(url, data) {
    return this._req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  },
  put(url, data) {
    return this._req(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  },
  del(url) { return this._req(url, { method: 'DELETE' }); },
  async upload(url, formData) {
    let res;
    try {
      res = await fetch(resolvePath(url), { method: 'POST', body: formData });
    } catch (e) { throw new Error('网络错误，请检查连接'); }
    if (res.status === 401) {
      showLoginPage();
      throw new Error('登录已过期，请重新登录');
    }
    if (!res.ok) {
      let msg = '上传失败';
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }
};

// ========== Auth / Login ==========
let currentUser = null;

function showLoginPage() {
  currentUser = null;
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('topbar').style.display = 'none';
  document.getElementById('workspace').style.display = 'none';
}

function hideLoginPage() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('topbar').style.display = '';
  document.getElementById('workspace').style.display = '';
}

function setLoginMode(mode) {
  const isSetup = mode === 'setup';
  document.getElementById('login-sub').textContent = isSetup ? '首次使用：创建管理员账号' : '登录';
  document.getElementById('login-confirm').classList.toggle('hidden', !isSetup);
  document.getElementById('login-submit').textContent = isSetup ? '创建账号并进入' : '登录';
  document.getElementById('login-page').dataset.mode = mode;
}

function loginError(msg) {
  document.getElementById('login-error').textContent = msg || '';
}

function startApp(user) {
  currentUser = user;
  hideLoginPage();
  document.getElementById('current-user').textContent = user.username;
  document.getElementById('settings-current-user').textContent = user.username;
  document.getElementById('user-manage-section').classList.toggle('hidden', !user.isAdmin);
  PageManager.goHome();
  loadSettings();
  loadCloudConfig();
}

async function loadUserList() {
  try {
    const data = await API.get('/api/auth/users');
    const container = document.getElementById('user-list');
    container.innerHTML = data.users.map(u => `
      <div class="user-item">
        <span>${escHtml(u.username)}</span>
        <span class="user-badge">${u.isAdmin ? '管理员' : '普通用户'}</span>
      </div>
    `).join('');
  } catch (e) { /* ignore */ }
}

async function initAuth() {
  let initialized = true;
  try {
    const status = await API.get('/api/auth/status');
    initialized = status.initialized;
  } catch (e) { /* assume initialized */ }
  setLoginMode(initialized ? 'login' : 'setup');

  try {
    const me = await API.get('/api/auth/me');
    startApp(me);
    return;
  } catch (e) { /* not logged in */ }

  showLoginPage();
}

// ========== Page Manager ==========
const PageManager = {
  current: 'home-page',

  show(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
    this.current = pageId;
  },

  goHome() {
    _allKnowledgeList = []; // Reset cache to reload fresh data
    this.show('home-page');
    loadKnowledgeList();
    loadSignature();
    document.getElementById('list-search').value = '';
  }
};

// ========== Toast ==========
function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

// ========== Confirm Modal ==========
function showConfirm(msg) {
  return new Promise((resolve) => {
    document.getElementById('confirm-message').textContent = msg;
    document.getElementById('confirm-modal').classList.remove('hidden');
    document.getElementById('btn-confirm-yes').onclick = () => {
      document.getElementById('confirm-modal').classList.add('hidden');
      resolve(true);
    };
    document.getElementById('btn-confirm-no').onclick = () => {
      document.getElementById('confirm-modal').classList.add('hidden');
      resolve(false);
    };
  });
}

// ========== Settings ==========
async function loadSettings() {
  try {
    const s = await API.get('/api/settings');
    document.getElementById('setting-signature').value = s.signature || '';
    document.getElementById('setting-font').value = s.signatureFont || 'sans-serif';
    document.getElementById('setting-refresh').value = s.refreshRate || 60;
  } catch (e) { /* defaults */ }
}

async function saveSettings() {
  const settings = {
    signature: document.getElementById('setting-signature').value,
    signatureFont: document.getElementById('setting-font').value,
    refreshRate: parseInt(document.getElementById('setting-refresh').value) || 60
  };
  await API.put('/api/settings', settings);
  showToast('设置已保存');
  loadSignature();
}

async function loadSignature() {
  try {
    const s = await API.get('/api/settings');
    const text = document.getElementById('signature-text');
    text.textContent = s.signature || '在此设置你的电子签名';
    text.style.fontFamily = s.signatureFont || 'sans-serif';
  } catch (e) { /* ignore */ }
}

async function loadCloudConfig() {
  try {
    const c = await API.get('/api/cloud-config');
    document.getElementById('cloud-domain').value = c.domain || '';
    document.getElementById('cloud-username').value = c.username || '';
    document.getElementById('cloud-password').value = c.password || '';
    document.getElementById('cloud-save-cred').checked = c.saveCredentials || false;
    if (c.saveCredentials && c.password) {
      document.getElementById('cloud-password').value = c.password;
    }
  } catch (e) { /* defaults */ }
}

async function saveCloudConfig() {
  const config = {
    domain: document.getElementById('cloud-domain').value,
    username: document.getElementById('cloud-username').value,
    password: document.getElementById('cloud-password').value,
    saveCredentials: document.getElementById('cloud-save-cred').checked
  };
  await API.put('/api/cloud-config', config);
  showToast('云端配置已保存');
}

// ========== Knowledge Point List ==========
let _allKnowledgeList = [];

async function loadKnowledgeList(filterText = '') {
  try {
    let list = _allKnowledgeList;
    if (list.length === 0) {
      list = await API.get('/api/knowledge');
      _allKnowledgeList = list;
    }
    // Apply filter
    if (filterText) {
      const q = filterText.toLowerCase();
      list = list.filter(k => k.number.toLowerCase().includes(q) || k.name.toLowerCase().includes(q));
    } else {
      list = _allKnowledgeList;
    }
    const container = document.getElementById('recent-list');
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">' +
        (filterText ? '没有匹配的知识点' : '暂无知识点，点击上方按钮创建吧！') + '</div>';
      return;
    }
    container.innerHTML = list.map(k => `
      <div class="recent-item" onclick="openKnowledge('${encodeURIComponent(k.number)}')">
        <span class="ri-number">${escHtml(k.number)}</span>
        <span class="ri-name">${escHtml(k.name)}</span>
      </div>
    `).join('');
  } catch (e) {
    showToast('加载知识点列表失败: ' + e.message);
  }
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== Search ==========
let searchTimeout;
function setupSearch(inputId, resultsId, onClick) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (!q) { results.classList.add('hidden'); return; }
    searchTimeout = setTimeout(async () => {
      try {
        const list = await API.get(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
        if (list.length === 0) {
          results.innerHTML = '<div style="padding:12px;color:var(--text-muted);">未找到匹配的知识点</div>';
        } else {
          results.innerHTML = list.map(k => `
            <div class="search-item" data-number="${escHtml(k.number)}">
              <span class="si-number">${escHtml(k.number)}</span>
              <span class="si-name">${escHtml(k.name)}</span>
            </div>
          `).join('');
        }
        results.classList.remove('hidden');
        results.querySelectorAll('.search-item').forEach(item => {
          item.addEventListener('click', () => onClick(item.dataset.number));
        });
      } catch (e) { /* ignore */ }
    }, 300);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => results.classList.add('hidden'), 200);
  });
}

setupSearch('global-search', 'search-results', (number) => openKnowledge(number));
setupSearch('home-search', 'home-search-results', (number) => openKnowledge(number));

// ========== Open Knowledge Point ==========
async function openKnowledge(number) {
  PageManager.show('kp-page');
  document.getElementById('global-search').value = '';

  try {
    const kp = await API.get(`/api/knowledge/${encodeURIComponent(number)}`);
    renderKnowledgeView(kp);
  } catch (e) {
    showToast('打开知识点失败: ' + e.message);
  }
}

function renderKnowledgeView(kp) {
  document.getElementById('kp-number-display').textContent = kp.number || '';
  document.getElementById('kp-name-display').textContent = kp.name || (kp.nameMap && kp.nameMap[kp.number]) || '(无名称)';

  // Render markdown content
  const contentHtml = marked.parse(protectMath(kp.contentStr || '*(暂无内容)*'));
  document.getElementById('kp-content-rendered').innerHTML = contentHtml;
  renderMath(document.getElementById('kp-content-rendered'));

  // Render prev related
  const prevList = document.getElementById('prev-related-list');
  if (kp.prevRelated && kp.prevRelated.length > 0) {
    prevList.innerHTML = kp.prevRelated.map(r => `
      <div class="related-item" onclick="openKnowledge('${encodeURIComponent(r.number)}')">
        <span class="rel-relation">${escHtml(r.relation || '无')}</span>
        <span class="rel-number">${escHtml(r.number)}</span>
        <span>${escHtml(r.name || (kp.nameMap && kp.nameMap[r.number]) || r.number)}</span>
      </div>
    `).join('');
  } else {
    prevList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">无前相关知识</div>';
  }

  // Render next related
  const nextList = document.getElementById('next-related-list');
  if (kp.nextRelated && kp.nextRelated.length > 0) {
    nextList.innerHTML = kp.nextRelated.map(r => `
      <div class="related-item" onclick="openKnowledge('${encodeURIComponent(r.number)}')">
        <span class="rel-relation">${escHtml(r.relation || '无')}</span>
        <span class="rel-number">${escHtml(r.number)}</span>
        <span>${escHtml(r.name || (kp.nameMap && kp.nameMap[r.number]) || r.number)}</span>
      </div>
    `).join('');
  } else {
    nextList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">无后相关知识</div>';
  }

  // Store current for edit
  document.getElementById('kp-page').dataset.currentNumber = kp.number;
}

// ========== Edit Knowledge Point ==========
async function openEdit(number) {
  PageManager.show('kp-edit-page');

  try {
    const kp = await API.get(`/api/knowledge/${encodeURIComponent(number)}`);
    document.getElementById('edit-number').value = kp.number || '';
    document.getElementById('edit-name').value = (kp.nameMap && kp.nameMap[kp.number]) || '';
    document.getElementById('edit-content').value = kp.contentStr || '';

    renderEditRelated(kp.prevRelated || [], 'edit-prev-related', 'prev');
    renderEditRelated(kp.nextRelated || [], 'edit-next-related', 'next');

    updatePreview();
  } catch (e) {
    showToast('打开编辑失败: ' + e.message);
  }
}

function renderEditRelated(list, containerId, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = list.map((r, i) => `
    <div class="edit-related-item">
      <span class="rel-number" style="color:var(--accent);font-weight:600;">${escHtml(r.number)}</span>
      <input type="text" class="rel-relation" value="${escHtml(r.relation || '无')}" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;text-align:center;">
      <span class="rel-name">${escHtml(r.name || r.number)}</span>
      <button class="del-rel-btn" data-type="${type}">×</button>
    </div>
  `).join('');

  container.querySelectorAll('.del-rel-btn').forEach(btn => {
    btn.addEventListener('click', () => { btn.parentElement.remove(); });
  });
}

function getEditRelated(type) {
  const containerId = type === 'prev' ? 'edit-prev-related' : 'edit-next-related';
  const container = document.getElementById(containerId);
  const items = [];
  container.querySelectorAll('.edit-related-item').forEach(el => {
    const number = el.querySelector('.rel-number')?.textContent?.trim() || '';
    const relation = el.querySelector('.rel-relation')?.value?.trim() || '无';
    const name = el.querySelector('.rel-name')?.textContent?.trim() || '';
    if (number) items.push({ number, relation, name });
  });
  return items;
}

function renderMath(el) {
  if (typeof renderMathInElement !== 'undefined') {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\\\[', right: '\\\\]', display: true },
          { left: '\\\\(', right: '\\\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (_) { /* ignore */ }
  }
}

// Protect LaTeX delimiters from being eaten by marked.js
function protectMath(content) {
  return content
    .replace(/\\\\\[/g, '$$')
    .replace(/\\\\\]/g, '$$')
    .replace(/\\\[/g, '$$')
    .replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$');
}
function updatePreview() {
  const content = document.getElementById('edit-content').value;
  const preview = document.getElementById('edit-preview');
  preview.innerHTML = marked.parse(protectMath(content || '*(预览为空)*'));
  renderMath(preview);
}

// Setup edit related search
function setupEditRelatedSearch(inputId, resultsId, type) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (!q) { results.classList.add('hidden'); return; }
    searchTimeout = setTimeout(async () => {
      try {
        const list = await API.get(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = list.slice(0, 8).map(k => `
          <div class="search-item" data-number="${escHtml(k.number)}" data-name="${escHtml(k.name)}">
            <span class="si-number">${escHtml(k.number)}</span>
            <span class="si-name">${escHtml(k.name)}</span>
          </div>
        `).join('');
        if (list.length > 8) {
          results.innerHTML += '<div style="padding:6px 12px;font-size:11px;color:var(--text-muted);">还有更多结果...</div>';
        }
        // Also add a "manual entry" option
        results.innerHTML += `
          <div class="search-item" data-manual="true">
            <span style="color:var(--accent);">直接输入: ${escHtml(q)}</span>
          </div>
        `;
        results.classList.remove('hidden');
        results.querySelectorAll('.search-item').forEach(item => {
          item.addEventListener('click', () => {
            const number = item.dataset.number || q;
            const name = item.dataset.name || q;
            addEditRelated(type, number, name);
            results.classList.add('hidden');
            input.value = '';
          });
        });
      } catch (e) { /* ignore */ }
    }, 300);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => results.classList.add('hidden'), 200);
  });
}

function addEditRelated(type, number, name) {
  const containerId = type === 'prev' ? 'edit-prev-related' : 'edit-next-related';
  const container = document.getElementById(containerId);
  const div = document.createElement('div');
  div.className = 'edit-related-item';
  div.innerHTML = `
    <span class="rel-number" style="color:var(--accent);font-weight:600;">${escHtml(number)}</span>
    <input type="text" class="rel-relation" value="无" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;text-align:center;">
    <span class="rel-name">${escHtml(name)}</span>
    <button class="del-rel-btn" data-type="${type}">×</button>
  `;
  div.querySelector('.del-rel-btn').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

setupEditRelatedSearch('add-prev-search', 'prev-search-results', 'prev');
setupEditRelatedSearch('add-next-search', 'next-search-results', 'next');

// ========== Mind Map ==========
let mindMap = null;

async function openMindMap(number, mode) {
  PageManager.show('mindmap-page');
  document.getElementById('mindmap-title').textContent = `思维导图 - ${number}`;

  let forwardDepth = 1, backwardDepth = 1;
  if (mode === 'free' || mode === 'surrounding') {
    forwardDepth = parseInt(document.getElementById('free-forward-depth').value) || 2;
    backwardDepth = parseInt(document.getElementById('free-backward-depth').value) || 2;
  } else if (mode === 'forward') {
    forwardDepth = 3; backwardDepth = 0;
  }

  try {
    const data = await API.get(
      `/api/knowledge/${encodeURIComponent(number)}/mindmap?mode=${mode}&forwardDepth=${forwardDepth}&backwardDepth=${backwardDepth}`
    );
    if (mindMap) mindMap.destroy();
    let refreshRate = 60;
    try {
      const settings = await API.get('/api/settings');
      refreshRate = settings.refreshRate || 60;
    } catch (_) { /* use default */ }
    mindMap = new MindMapRenderer('mindmap-canvas', 'mindmap-canvas-container', data, refreshRate);
    mindMap.render();
  } catch (e) {
    showToast('加载思维导图失败: ' + e.message);
  }
}

// ========== Image Management ==========
async function loadImageManager(searchQuery = '') {
  try {
    const list = searchQuery
      ? await API.get(`/api/images/search?q=${encodeURIComponent(searchQuery)}`)
      : await API.get('/api/images');
    const grid = document.getElementById('img-manager-grid');
    if (list.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">暂无图片</div>';
    } else {
      grid.innerHTML = list.map(img => `
        <div class="img-card" data-filename="${escHtml(img.filename)}" data-number="${escHtml(img.number || '')}" data-name="${escHtml(img.name || '')}">
          <img class="img-card-thumb" src="api/images/file/${encodeURIComponent(img.filename)}" alt="${escHtml(img.name)}" loading="lazy"
            onerror="this.parentElement.querySelector('.img-card-thumb').textContent='🖼'">
          <div class="img-card-info">
            <div class="img-card-number">${escHtml(img.number || '-')}</div>
            <div class="img-card-name" title="${escHtml(img.name)}">${escHtml(img.name || img.filename)}</div>
          </div>
        </div>
      `).join('');

      // Click handlers
      grid.querySelectorAll('.img-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (isMultiselectMode) {
            card.classList.toggle('selected');
          } else {
            // Single select - deselect others
            grid.querySelectorAll('.img-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
          }
        });
        card.addEventListener('dblclick', () => {
          const img = document.getElementById('img-full-preview');
          img.src = `api/images/file/${encodeURIComponent(card.dataset.filename)}`;
          document.getElementById('img-preview-overlay').classList.remove('hidden');
        });
      });
    }
  } catch (e) {
    showToast('加载图片失败: ' + e.message);
  }
}

let isMultiselectMode = false;

function toggleMultiselect() {
  isMultiselectMode = !isMultiselectMode;
  const btn = document.getElementById('btn-img-multiselect');
  btn.textContent = isMultiselectMode ? '☑ 退出多选' : '☑ 多选';
  if (!isMultiselectMode) {
    document.querySelectorAll('.img-card.selected').forEach(c => c.classList.remove('selected'));
  }
}

function getSelectedImages() {
  const cards = document.querySelectorAll('.img-card.selected');
  return Array.from(cards).map(c => c.dataset.filename);
}

// ========== Image Insert (from editor) ==========
async function openImageInsert() {
  document.getElementById('image-insert-modal').classList.remove('hidden');
  await searchInsertImages('');
}

async function searchInsertImages(query) {
  try {
    const list = query
      ? await API.get(`/api/images/search?q=${encodeURIComponent(query)}`)
      : await API.get('/api/images');
    const results = document.getElementById('img-search-results');
    results.innerHTML = list.map(img => `
      <div class="img-grid-item" data-filename="${escHtml(img.filename)}" data-number="${escHtml(img.number || '')}" data-name="${escHtml(img.name || '')}">
        <img src="api/images/file/${encodeURIComponent(img.filename)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 80%22><text y=%2250%22 x=%2250%25%22 text-anchor=%22middle%22>🖼</text></svg>'">
        <div class="img-grid-label">${escHtml(img.number || '')} ${escHtml((img.name || '').substring(0, 8))}</div>
      </div>
    `).join('');

    results.querySelectorAll('.img-grid-item').forEach(item => {
      item.addEventListener('click', () => {
        results.querySelectorAll('.img-grid-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        // Store selected data directly on the results element
        results._selectedFilename = item.dataset.filename;
        results._selectedNumber = item.dataset.number;
        results._selectedName = item.dataset.name;
      });
    });
  } catch (e) { /* ignore */ }
}

function confirmImageInsert() {
  const results = document.getElementById('img-search-results');
  const selected = results._selectedFilename;
  if (!selected) { showToast('请先选择一张图片'); return; }

  const name = results._selectedName || results._selectedFilename || '';
  const filename = results._selectedFilename || '';
  // Use API route to avoid URL encoding issues with Chinese filenames
  const mdRef = `![${name}](api/images/file/${encodeURIComponent(filename)})`;
  navigator.clipboard.writeText(mdRef).then(() => {
    showToast('图片引用已复制到剪贴板，请粘贴到正文中');
    document.getElementById('image-insert-modal').classList.add('hidden');
  }).catch(() => {
    showToast('图片引用: ' + mdRef);
    document.getElementById('image-insert-modal').classList.add('hidden');
  });
}

// ========== Image Upload ==========
async function uploadImage(file, number, name) {
  const formData = new FormData();
  formData.append('image', file);
  formData.append('number', number);
  formData.append('name', name);
  return API.upload('/api/images/upload', formData);
}

// ========== Event Listeners ==========
document.addEventListener('DOMContentLoaded', () => {
  // ---- Top Bar ----
  document.getElementById('btn-new-kp').addEventListener('click', () => {
    document.getElementById('kp-page').dataset.currentNumber = '';
    document.getElementById('edit-number').value = '';
    document.getElementById('edit-name').value = '';
    document.getElementById('edit-content').value = '';
    document.getElementById('edit-prev-related').innerHTML = '';
    document.getElementById('edit-next-related').innerHTML = '';
    document.getElementById('edit-preview').innerHTML = '';
    PageManager.show('kp-edit-page');
  });

  document.getElementById('btn-images').addEventListener('click', () => {
    PageManager.show('images-page');
    loadImageManager();
  });

  document.getElementById('btn-settings-toggle').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.remove('hidden');
    loadSettings();
    loadCloudConfig();
    loadUserList();
  });

  // ---- Home Page ----
  document.getElementById('btn-home-new').addEventListener('click', () => {
    document.getElementById('kp-page').dataset.currentNumber = '';
    document.getElementById('edit-number').value = '';
    document.getElementById('edit-name').value = '';
    document.getElementById('edit-content').value = '';
    document.getElementById('edit-prev-related').innerHTML = '';
    document.getElementById('edit-next-related').innerHTML = '';
    document.getElementById('edit-preview').innerHTML = '';
    PageManager.show('kp-edit-page');
  });

  document.getElementById('btn-home-images').addEventListener('click', () => {
    PageManager.show('images-page');
    loadImageManager();
  });

  // List search filter
  document.getElementById('list-search').addEventListener('input', (e) => {
    loadKnowledgeList(e.target.value);
  });

  // ---- KP View Page ----
  document.getElementById('btn-back').addEventListener('click', () => PageManager.goHome());

  document.getElementById('btn-edit').addEventListener('click', () => {
    const number = document.getElementById('kp-page').dataset.currentNumber;
    if (number) openEdit(number);
  });

  document.getElementById('btn-delete-kp').addEventListener('click', async () => {
    const number = document.getElementById('kp-page').dataset.currentNumber;
    if (!number) return;
    const confirmed = await showConfirm(`确定要删除知识点「${number}」吗？此操作不可撤销！`);
    if (confirmed) {
      try {
        await API.del(`/api/knowledge/${encodeURIComponent(number)}`);
        showToast('知识点已删除');
        PageManager.goHome();
      } catch (e) {
        showToast('删除失败: ' + e.message);
      }
    }
  });

  document.getElementById('btn-mindmap').addEventListener('click', () => {
    document.getElementById('mindmap-mode-modal').classList.remove('hidden');
  });

  // ---- Mind Map Mode Selection ----
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const freeControls = document.getElementById('free-mode-controls');
      if (mode === 'free' || mode === 'surrounding') {
        freeControls.classList.remove('hidden');
        freeControls.dataset.mode = mode;
        return;
      }
      freeControls.classList.add('hidden');
      const number = document.getElementById('kp-page').dataset.currentNumber;
      if (number) {
        document.getElementById('mindmap-mode-modal').classList.add('hidden');
        openMindMap(number, mode);
      }
    });
  });

  // Free mode: rebuild go button each time, read number fresh
  document.getElementById('free-mode-controls').addEventListener('change', rebuildFreeGoBtn);

  function rebuildFreeGoBtn() {
    // Remove old button if exists
    const oldBtn = document.getElementById('btn-free-go');
    if (oldBtn) oldBtn.remove();

    const goBtn = document.createElement('button');
    goBtn.id = 'btn-free-go';
    goBtn.className = 'btn-primary';
    goBtn.textContent = '生成思维导图';
    goBtn.style.marginTop = '12px';
    goBtn.addEventListener('click', () => {
      const number = document.getElementById('kp-page').dataset.currentNumber;
      const ctrls = document.getElementById('free-mode-controls');
      const mode = ctrls.dataset.mode || 'free';
      if (number) {
        document.getElementById('mindmap-mode-modal').classList.add('hidden');
        openMindMap(number, mode);
      }
    });
    document.getElementById('free-mode-controls').appendChild(goBtn);
  }

  document.getElementById('btn-mindmap-cancel').addEventListener('click', () => {
    document.getElementById('mindmap-mode-modal').classList.add('hidden');
  });

  // ---- Mind Map Page ----
  document.getElementById('btn-mindmap-back').addEventListener('click', () => {
    if (mindMap) { mindMap.destroy(); mindMap = null; }
    const number = document.getElementById('kp-page').dataset.currentNumber;
    // Go back to the KP view page instead of home
    if (document.getElementById('kp-page').classList.contains('active')) {
      // already on kp page
    } else {
      PageManager.show('kp-page');
    }
    PageManager.show('kp-page');
  });

  // Mind map pen tools
  let activePenColor = null;
  document.getElementById('btn-red-pen').addEventListener('click', () => {
    activePenColor = '#ef4444';
    updatePenActive();
  });
  document.getElementById('btn-green-pen').addEventListener('click', () => {
    activePenColor = '#10b981';
    updatePenActive();
  });
  document.getElementById('btn-blue-pen').addEventListener('click', () => {
    activePenColor = '#3b82f6';
    updatePenActive();
  });
  document.getElementById('btn-clear-pen').addEventListener('click', () => {
    activePenColor = null;
    updatePenActive();
  });

  function updatePenActive() {
    ['btn-red-pen', 'btn-green-pen', 'btn-blue-pen'].forEach(id => {
      document.getElementById(id).classList.remove('active');
    });
    if (activePenColor === '#ef4444') document.getElementById('btn-red-pen').classList.add('active');
    if (activePenColor === '#10b981') document.getElementById('btn-green-pen').classList.add('active');
    if (activePenColor === '#3b82f6') document.getElementById('btn-blue-pen').classList.add('active');
    if (mindMap) mindMap.setPenColor(activePenColor);
  }

  // Create a new knowledge point directly from the mind map view
  document.getElementById('btn-mindmap-new').addEventListener('click', () => {
    if (mindMap) { mindMap.destroy(); mindMap = null; }
    document.getElementById('kp-page').dataset.currentNumber = '';
    document.getElementById('edit-number').value = '';
    document.getElementById('edit-name').value = '';
    document.getElementById('edit-content').value = '';
    document.getElementById('edit-prev-related').innerHTML = '';
    document.getElementById('edit-next-related').innerHTML = '';
    document.getElementById('edit-preview').innerHTML = '';
    PageManager.show('kp-edit-page');
  });

  // Mind map zoom
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    if (mindMap) { mindMap.zoomIn(); mindMap.render(); }
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    if (mindMap) { mindMap.zoomOut(); mindMap.render(); }
  });
  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    if (mindMap) { mindMap.resetZoom(); mindMap.render(); }
  });

  // ---- KP Edit Page ----
  document.getElementById('btn-edit-back').addEventListener('click', () => {
    const number = document.getElementById('edit-number').value;
    if (number) {
      openKnowledge(number);
    } else {
      PageManager.goHome();
    }
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const number = document.getElementById('edit-number').value.trim();
    const name = document.getElementById('edit-name').value.trim();
    const content = document.getElementById('edit-content').value;

    if (!number || !name) {
      showToast('编号和名称不能为空');
      return;
    }

    const data = {
      number,
      name,
      content,
      prevRelated: getEditRelated('prev'),
      nextRelated: getEditRelated('next')
    };

    try {
      const currentNumber = document.getElementById('kp-page').dataset.currentNumber;
      if (currentNumber) {
        // Update existing
        await API.put(`/api/knowledge/${encodeURIComponent(currentNumber)}`, data);
        showToast('知识点已更新');
      } else {
        // Create new
        await API.post('/api/knowledge', data);
        showToast('知识点已创建');
      }
      openKnowledge(number);
    } catch (e) {
      showToast('保存失败: ' + e.message);
    }
  });

  document.getElementById('edit-content').addEventListener('input', updatePreview);

  // ---- Image Insert (from editor) ----
  document.getElementById('btn-insert-image').addEventListener('click', () => openImageInsert());
  document.getElementById('btn-img-insert-cancel').addEventListener('click', () => {
    document.getElementById('image-insert-modal').classList.add('hidden');
  });

  // Extend insert modal to have confirm button
  const insertModal = document.getElementById('image-insert-modal').querySelector('.modal-content');
  const confirmInsertBtn = document.createElement('button');
  confirmInsertBtn.className = 'btn-primary';
  confirmInsertBtn.textContent = '确认选择';
  confirmInsertBtn.style.marginTop = '8px';
  confirmInsertBtn.addEventListener('click', confirmImageInsert);
  insertModal.appendChild(confirmInsertBtn);

  document.getElementById('img-search-input').addEventListener('input', () => {
    searchInsertImages(document.getElementById('img-search-input').value);
  });

  // Upload from editor
  document.getElementById('btn-upload-img').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.remove('hidden');
  });
  document.getElementById('btn-upload-cancel').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.add('hidden');
  });
  document.getElementById('btn-upload-confirm').addEventListener('click', async () => {
    const file = document.getElementById('upload-img-file').files[0];
    const number = document.getElementById('upload-img-number').value.trim();
    const name = document.getElementById('upload-img-name').value.trim();
    if (!file) { showToast('请选择文件'); return; }
    if (!number || !name) { showToast('请填写编号和名称'); return; }
    try {
      await uploadImage(file, number, name);
      showToast('图片上传成功');
      document.getElementById('upload-modal').classList.add('hidden');
      document.getElementById('upload-img-number').value = '';
      document.getElementById('upload-img-name').value = '';
      document.getElementById('upload-img-file').value = '';
      searchInsertImages(document.getElementById('img-search-input').value);
    } catch (e) {
      showToast('上传失败: ' + e.message);
    }
  });

  // ---- Image Manager Page ----
  document.getElementById('btn-images-back').addEventListener('click', () => PageManager.goHome());

  document.getElementById('img-manager-search').addEventListener('input', () => {
    loadImageManager(document.getElementById('img-manager-search').value);
  });

  document.getElementById('btn-img-upload-manager').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.remove('hidden');
  });

  document.getElementById('btn-img-multiselect').addEventListener('click', toggleMultiselect);

  document.getElementById('btn-img-delete').addEventListener('click', async () => {
    const filenames = getSelectedImages();
    if (filenames.length === 0) { showToast('请选择要删除的图片'); return; }
    const confirmed = await showConfirm(`确定要删除 ${filenames.length} 张图片吗？`);
    if (!confirmed) return;
    for (const fn of filenames) {
      try { await API.del(`/api/images/${encodeURIComponent(fn)}`); } catch (e) { showToast('删除失败: ' + e.message); }
    }
    showToast('已删除所选图片');
    loadImageManager(document.getElementById('img-manager-search').value);
  });

  document.getElementById('btn-img-edit').addEventListener('click', async () => {
    const filenames = getSelectedImages();
    if (filenames.length !== 1) { showToast('请选择一张图片进行修改'); return; }
    const fn = filenames[0];
    const card = document.querySelector(`.img-card[data-filename="${fn}"]`);
    const newNumber = prompt('新编号:', card ? card.dataset.number : '');
    const newName = prompt('新名称:', card ? card.dataset.name : '');
    if (newNumber === null || newName === null) return;
    try {
      await API.put(`/api/images/${encodeURIComponent(fn)}`, { number: newNumber, name: newName });
      showToast('图片信息已更新');
      loadImageManager(document.getElementById('img-manager-search').value);
    } catch (e) {
      showToast('修改失败: ' + e.message);
    }
  });

  document.getElementById('btn-img-preview-close').addEventListener('click', () => {
    document.getElementById('img-preview-overlay').classList.add('hidden');
  });

  // ---- Settings ----
  document.getElementById('btn-settings-close').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
    saveSettings();
    saveCloudConfig();
  });

  document.getElementById('btn-exit').addEventListener('click', () => {
    // Browsers usually only allow closing a tab the script itself opened, so
    // attempt window.close() and also tell the user how to exit manually.
    window.close();
    showToast('感谢使用 The Sea of Knowledge！如页面未关闭，请手动关闭浏览器标签页。');
  });

  // ---- Cloud Actions ----
  document.getElementById('btn-cloud-upload').addEventListener('click', async () => {
    const status = document.getElementById('cloud-status');
    status.textContent = '正在上传...';
    status.className = 'cloud-status';
    try {
      await saveCloudConfig();
      const result = await API.post('/api/cloud/upload', {});
      status.textContent = result.message || '上传成功';
      status.className = 'cloud-status success';
    } catch (e) {
      status.textContent = '上传失败: ' + e.message;
      status.className = 'cloud-status error';
    }
  });

  document.getElementById('btn-cloud-download').addEventListener('click', async () => {
    const confirmed = await showConfirm('下载将覆盖本地知识点库，确定继续吗？');
    if (!confirmed) return;
    const status = document.getElementById('cloud-status');
    status.textContent = '正在下载...';
    status.className = 'cloud-status';
    try {
      await saveCloudConfig();
      const result = await API.post('/api/cloud/download', {});
      status.textContent = result.message || '下载成功';
      status.className = 'cloud-status success';
      loadKnowledgeList();
    } catch (e) {
      status.textContent = '下载失败: ' + e.message;
      status.className = 'cloud-status error';
    }
  });

  // ---- Keyboard shortcuts ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
      document.getElementById('mindmap-mode-modal').classList.add('hidden');
    }
  });

  // ---- Auth ----
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError('');
    const mode = document.getElementById('login-page').dataset.mode || 'login';
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const remember = document.getElementById('login-remember').checked;

    if (!username || !password) { loginError('请输入账号和密码'); return; }
    if (mode === 'setup') {
      const confirm = document.getElementById('login-confirm').value;
      if (password !== confirm) { loginError('两次输入的密码不一致'); return; }
    }

    const submitBtn = document.getElementById('login-submit');
    submitBtn.disabled = true;
    try {
      const res = await fetch(resolvePath(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember })
      });
      const data = await res.json();
      if (!res.ok) { loginError(data.error || '登录失败'); return; }
      document.getElementById('login-password').value = '';
      document.getElementById('login-confirm').value = '';
      startApp(data);
    } catch (err) {
      loginError('网络错误，请重试');
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    try { await API.post('/api/auth/logout', {}); } catch (_) {}
    document.getElementById('settings-panel').classList.add('hidden');
    if (mindMap) { mindMap.destroy(); mindMap = null; }
    _allKnowledgeList = [];
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-confirm').value = '';
    showLoginPage();
  });

  document.getElementById('btn-change-password').addEventListener('click', async () => {
    const oldPassword = document.getElementById('pw-old').value;
    const newPassword = document.getElementById('pw-new').value;
    if (!oldPassword || !newPassword) { showToast('请输入原密码和新密码'); return; }
    if (newPassword.length < 4) { showToast('新密码至少 4 位'); return; }
    try {
      await API.put('/api/auth/password', { oldPassword, newPassword });
      showToast('密码已修改');
      document.getElementById('pw-old').value = '';
      document.getElementById('pw-new').value = '';
    } catch (e) { showToast('修改失败: ' + e.message); }
  });

  document.getElementById('btn-add-user').addEventListener('click', async () => {
    const username = document.getElementById('new-user-name').value.trim();
    const password = document.getElementById('new-user-password').value;
    if (!username || !password) { showToast('请输入账号和密码'); return; }
    try {
      await API.post('/api/auth/users', { username, password });
      showToast('账号已添加');
      document.getElementById('new-user-name').value = '';
      document.getElementById('new-user-password').value = '';
      loadUserList();
    } catch (e) { showToast('添加失败: ' + e.message); }
  });

  // Kick off authentication
  initAuth();
});
