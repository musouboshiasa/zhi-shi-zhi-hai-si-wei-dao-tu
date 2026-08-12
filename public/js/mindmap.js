// ========== Mind Map Renderer ==========

class MindMapRenderer {
  constructor(canvasId, containerId, data) {
    this.canvas = document.getElementById(canvasId);
    this.container = document.getElementById(containerId);
    this.data = data;
    this.ctx = this.canvas.getContext('2d');

    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.isNodeDragging = false;
    this.dragNode = null;
    this.dragNodeStartX = 0;
    this.dragNodeStartY = 0;
    this.dragMouseStartWorldX = 0;
    this.dragMouseStartWorldY = 0;
    this.hasMoved = false;
    this._potentialClickNode = null;
    this._potentialClickWorld = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.penColor = null;

    // Node layout
    this.nodes = [];
    this.nodePositions = {};
    this.nodeColors = {};

    // Bubble
    this.bubble = document.getElementById('kp-bubble');
    this.bubbleVisible = false;

    this.resize();
    this.bindEvents();
  }

  resize() {
    this.canvas.width = this.container.clientWidth;
    this.canvas.height = this.container.clientHeight;
  }

  bindEvents() {
    // Resize
    window.addEventListener('resize', () => {
      this.resize();
      this.render();
    });

    // Mouse events for panning
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));

    // Touch events (mobile/tablet) — forward to mouse handlers
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const me = new MouseEvent('mousedown', { clientX: t.clientX, clientY: t.clientY, bubbles: true });
      this.canvas.dispatchEvent(me);
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const me = new MouseEvent('mousemove', { clientX: t.clientX, clientY: t.clientY, bubbles: true });
      this.canvas.dispatchEvent(me);
    }, { passive: false });
    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { passive: false });

    // Set default cursor
    this.canvas.style.cursor = 'grab';

    // Bubble jump button
    this.bubble.querySelector('.bubble-jump').addEventListener('click', () => {
      const number = this.bubble.dataset.number;
      if (number && typeof openKnowledge === 'function') {
        openKnowledge(number);
      }
    });
  }

  // ---- Layout ----
  calculateLayout() {
    const nodes = this.data.nodes;
    const edges = this.data.edges;
    const centerNumber = this.data.centerNumber;

    // Build adjacency
    const adj = {};
    const inDegree = {};
    nodes.forEach(n => { adj[n.number] = []; inDegree[n.number] = 0; });
    edges.forEach(e => {
      if (!adj[e.from]) adj[e.from] = [];
      if (!adj[e.to]) adj[e.to] = [];
      adj[e.from].push(e.to);
      inDegree[e.to] = (inDegree[e.to] || 0) + 1;
    });

    // Find roots (no incoming edges, or the center node)
    let roots = nodes.filter(n => inDegree[n.number] === 0).map(n => n.number);
    if (roots.length === 0) roots = [centerNumber];

    // BFS layered layout
    const layers = {};
    const visited = new Set();
    let queue = roots.map(r => ({ id: r, layer: 0 }));

    // If center is not in roots, add it
    if (!roots.includes(centerNumber)) {
      queue = [{ id: centerNumber, layer: 0 }];
    }

    while (queue.length > 0) {
      const { id, layer } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      if (!layers[layer]) layers[layer] = [];
      layers[layer].push(id);

      for (const neighbor of (adj[id] || [])) {
        if (!visited.has(neighbor)) {
          queue.push({ id: neighbor, layer: layer + 1 });
        }
      }
    }

    // Also handle backward nodes (prevRelated)
    // Find nodes that point TO the center but aren't in adj
    const backwardLayers = {};
    nodes.forEach(n => {
      if (visited.has(n.number)) return;
      // Add to negative layers
      backwardLayers[-1] = backwardLayers[-1] || [];
      backwardLayers[-1].push(n.number);
    });

    // Assign positions
    const nodeWidth = 160;
    const nodeHeight = 70;
    const hGap = 200;
    const vGap = 30;
    const startX = 80;
    const startY = 80;

    const positions = {};
    const allLayers = { ...backwardLayers, ...layers };
    const layerKeys = Object.keys(allLayers).map(Number).sort((a, b) => a - b);

    let currentX = startX;
    for (const layer of layerKeys) {
      const ids = allLayers[layer];
      const totalHeight = ids.length * (nodeHeight + vGap);
      let currentY = startY + Math.max(0, (this.canvas.height - totalHeight) / 2 - startY);

      ids.forEach(id => {
        positions[id] = { x: currentX, y: currentY, w: nodeWidth, h: nodeHeight };
        currentY += nodeHeight + vGap;
      });

      currentX += nodeWidth + hGap;
    }

    this.positions = positions;
    this.adj = adj;

    // Calculate total bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    Object.values(positions).forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    });
    this.bounds = { minX: minX - 40, minY: minY - 40, maxX: maxX + 40, maxY: maxY + 40 };
  }

  // ---- Rendering ----
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Only calculate layout once; after that positions are mutable (drag)
    if (!this._layoutDone) {
      this.calculateLayout();
      this._layoutDone = true;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Draw nodes first
    this.data.nodes.forEach(node => {
      if (node.number !== this.dragNode) {
        this.drawNode(node);
      }
    });
    if (this.dragNode) {
      const draggedNode = this.data.nodes.find(n => n.number === this.dragNode);
      if (draggedNode) this.drawNode(draggedNode);
    }

    // Draw edges (arrows) on top of nodes — from center outward
    this.data.edges.forEach(edge => {
      this.drawArrow(edge.from, edge.to, edge.relation);
    });

    ctx.restore();
  }

  drawNode(node) {
    const pos = this.positions[node.number];
    if (!pos) return;

    const ctx = this.ctx;
    const color = this.nodeColors[node.number] || '#3b82f6'; // default blue
    const isCenter = node.number === this.data.centerNumber;
    const radius = 8;

    // Shadow
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    // Rounded rectangle
    ctx.beginPath();
    ctx.moveTo(pos.x + radius, pos.y);
    ctx.lineTo(pos.x + pos.w - radius, pos.y);
    ctx.quadraticCurveTo(pos.x + pos.w, pos.y, pos.x + pos.w, pos.y + radius);
    ctx.lineTo(pos.x + pos.w, pos.y + pos.h - radius);
    ctx.quadraticCurveTo(pos.x + pos.w, pos.y + pos.h, pos.x + pos.w - radius, pos.y + pos.h);
    ctx.lineTo(pos.x + radius, pos.y + pos.h);
    ctx.quadraticCurveTo(pos.x, pos.y + pos.h, pos.x, pos.y + pos.h - radius);
    ctx.lineTo(pos.x, pos.y + radius);
    ctx.quadraticCurveTo(pos.x, pos.y, pos.x + radius, pos.y);
    ctx.closePath();

    // Fill
    ctx.fillStyle = isCenter ? color : '#ffffff';
    ctx.fill();

    // Border
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = color;
    ctx.lineWidth = isCenter ? 3 : 2;
    ctx.stroke();

    // Number badge
    ctx.fillStyle = color;
    ctx.font = 'bold 11px -apple-system, "Microsoft YaHei", sans-serif';
    const numText = node.number.length > 18 ? node.number.substring(0, 18) + '...' : node.number;
    const numWidth = ctx.measureText(numText).width;
    const badgeX = pos.x + 8;
    const badgeY = pos.y + 6;
    ctx.fillText(numText, badgeX, badgeY + 12);

    // Name (centered in the remaining space below the badge)
    ctx.fillStyle = '#1a2332';
    ctx.font = 'bold 14px -apple-system, "Microsoft YaHei", sans-serif';
    const nameText = node.name.length > 16 ? node.name.substring(0, 16) + '...' : node.name;
    const nameY = pos.y + (pos.h + 12) / 2 + 2;
    ctx.fillText(nameText, pos.x + 10, nameY);

    // Drag handle — small icon bottom-right, ╋ shape
    const HS = 20;  // handle size, consistent with hit test
    const hx = pos.x + pos.w - HS;
    const hy = pos.y + pos.h - HS;
    ctx.save();
    ctx.strokeStyle = color + '60';
    ctx.lineWidth = 1.2;
    // small cross-hair / gripper
    ctx.strokeRect(hx + 4, hy + 4, HS - 8, HS - 8);
    ctx.beginPath();
    ctx.moveTo(hx + 7, hy + HS/2);
    ctx.lineTo(hx + HS - 7, hy + HS/2);
    ctx.moveTo(hx + HS/2, hy + 7);
    ctx.lineTo(hx + HS/2, hy + HS - 7);
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(fromNumber, toNumber, relation) {
    const fromPos = this.positions[fromNumber];
    const toPos = this.positions[toNumber];
    if (!fromPos || !toPos) return;

    const ctx = this.ctx;

    const fromCenter = { x: fromPos.x + fromPos.w / 2, y: fromPos.y + fromPos.h / 2 };
    const toCenter = { x: toPos.x + toPos.w / 2, y: toPos.y + toPos.h / 2 };

    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    // Dynamically choose edge based on relative position
    let sx, sy, ex, ey;
    if (Math.abs(dx) < 50) {
      // Vertical alignment: connect bottom to top
      sx = fromCenter.x;
      sy = fromPos.y + fromPos.h;
      ex = toCenter.x;
      ey = toPos.y;
    } else if (dx > 0) {
      // fromNode is LEFT of toNode → right edge of from, left edge of to
      sx = fromPos.x + fromPos.w;
      sy = fromCenter.y;
      ex = toPos.x;
      ey = toCenter.y;
    } else {
      // fromNode is RIGHT of toNode → left edge of from, right edge of to
      sx = fromPos.x;
      sy = fromCenter.y;
      ex = toPos.x + toPos.w;
      ey = toCenter.y;
    }

    // Curve control points
    const cpOffset = Math.abs(ex - sx) * 0.4;

    // Draw bezier curve
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + cpOffset, sy, ex - cpOffset, ey, ex, ey);
    ctx.strokeStyle = '#5a6d80';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Arrowhead
    const t = 0.95;
    const bx = Math.pow(1-t,3)*sx + 3*Math.pow(1-t,2)*t*(sx+cpOffset) + 3*(1-t)*t*t*(ex-cpOffset) + Math.pow(t,3)*ex;
    const by = Math.pow(1-t,3)*sy + 3*Math.pow(1-t,2)*t*sy + 3*(1-t)*t*t*ey + Math.pow(t,3)*ey;
    const t2 = 0.98;
    const ax = Math.pow(1-t2,3)*sx + 3*Math.pow(1-t2,2)*t2*(sx+cpOffset) + 3*(1-t2)*t2*t2*(ex-cpOffset) + Math.pow(t2,3)*ex;
    const ay = Math.pow(1-t2,3)*sy + 3*Math.pow(1-t2,2)*t2*sy + 3*(1-t2)*t2*t2*ey + Math.pow(t2,3)*ey;

    const angle = Math.atan2(by - ay, bx - ax);
    const arrowSize = 10;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - arrowSize * Math.cos(angle - Math.PI/6), by - arrowSize * Math.sin(angle - Math.PI/6));
    ctx.lineTo(bx - arrowSize * Math.cos(angle + Math.PI/6), by - arrowSize * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fillStyle = '#5a6d80';
    ctx.fill();

    // Relation label at midpoint
    if (relation && relation !== '无') {
      const midX = (sx + ex) / 2;
      const midY = (sy + ey) / 2 - 12;
      // Background pill for readability
      const labelW = ctx.measureText(relation).width + 12;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(midX - labelW/2, midY - 7, labelW, 16);
      ctx.fillStyle = '#3b82f6';
      ctx.font = 'bold 12px -apple-system, "Microsoft YaHei", sans-serif';
      ctx.fillText(relation, midX - ctx.measureText(relation).width/2, midY + 5);
    }
  }

  // ---- Interaction ----

  screenToWorld(screenX, screenY, rect) {
    return {
      x: (screenX - rect.left - this.offsetX) / this.scale,
      y: (screenY - rect.top - this.offsetY) / this.scale
    };
  }

  hitTestNode(wx, wy) {
    for (const number in this.positions) {
      const pos = this.positions[number];
      if (wx >= pos.x && wx <= pos.x + pos.w && wy >= pos.y && wy <= pos.y + pos.h) {
        return number;
      }
    }
    return null;
  }

  // Check if world coords are in a node's drag handle zone (bottom-right)
  hitTestDragHandle(wx, wy) {
    const HS = 20;
    for (const number in this.positions) {
      const pos = this.positions[number];
      const hx = pos.x + pos.w - HS;
      const hy = pos.y + pos.h - HS;
      if (wx >= hx && wx <= hx + HS && wy >= hy && wy <= hy + HS) {
        return number;
      }
    }
    return null;
  }

  onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const world = this.screenToWorld(e.clientX, e.clientY, rect);

    this.hasMoved = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    // 1. Drag handle → start node drag immediately
    const handleHit = this.hitTestDragHandle(world.x, world.y);
    if (handleHit) {
      this.isNodeDragging = true;
      this.dragNode = handleHit;
      const pos = this.positions[handleHit];
      this.dragNodeStartX = pos.x;
      this.dragNodeStartY = pos.y;
      this.dragMouseStartWorldX = world.x;
      this.dragMouseStartWorldY = world.y;
      this.hideBubble();
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // 2. Node body (no pen) → potential click for bubble
    const nodeHit = this.hitTestNode(world.x, world.y);
    if (nodeHit && !this.penColor) {
      this._potentialClickNode = nodeHit;
      this._potentialClickWorld = world;
      return;
    }

    // 3. Canvas pan
    this.isDragging = true;
    this.dragOffsetX = this.offsetX;
    this.dragOffsetY = this.offsetY;
    this.canvas.style.cursor = 'grabbing';
  }

  onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();

    // Node drag via handle
    if (this.isNodeDragging && this.dragNode) {
      const world = this.screenToWorld(e.clientX, e.clientY, rect);
      const dx = world.x - this.dragMouseStartWorldX;
      const dy = world.y - this.dragMouseStartWorldY;
      const pos = this.positions[this.dragNode];
      pos.x = this.dragNodeStartX + dx;
      pos.y = this.dragNodeStartY + dy;
      this.hasMoved = true;
      this.render();
      return;
    }

    // If user moves mouse while on a node body, cancel the potential click
    if (this._potentialClickNode) {
      if (Math.abs(e.clientX - this.dragStartX) > 3 || Math.abs(e.clientY - this.dragStartY) > 3) {
        this._potentialClickNode = null;
      }
      return;
    }

    // Canvas panning
    if (!this.isDragging) return;
    this.offsetX = this.dragOffsetX + (e.clientX - this.dragStartX);
    this.offsetY = this.dragOffsetY + (e.clientY - this.dragStartY);
    this.hasMoved = true;
    this.render();
  }

  onMouseUp(e) {
    const rect = this.canvas.getBoundingClientRect();

    // Handle potential click on node body
    if (this._potentialClickNode) {
      const clicked = this._potentialClickNode;
      this._potentialClickNode = null;

      // Pen active → color it
      if (this.penColor) {
        this.nodeColors[clicked] = this.penColor;
        this.render();
      } else {
        // Show bubble
        const node = this.data.nodes.find(n => n.number === clicked);
        if (node) this.showBubble(node, e.clientX, e.clientY);
      }
    }

    this._potentialClickNode = null;
    this.isDragging = false;
    this.isNodeDragging = false;
    this.dragNode = null;
    this.canvas.style.cursor = 'grab';
  }

  onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const newScale = Math.max(0.3, Math.min(3.0, this.scale * delta));
    this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
    this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
    this.scale = newScale;
    this.render();
  }

  onClick(e) {
    // No-op: all click logic handled in onMouseUp via _potentialDragNode
  }

  onDblClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const world = this.screenToWorld(e.clientX, e.clientY, rect);
    const hit = this.hitTestNode(world.x, world.y);
    if (hit && typeof openKnowledge === 'function') {
      openKnowledge(hit);
    }
  }

  showBubble(node, clientX, clientY) {
    this.bubble.querySelector('.bubble-number').textContent = node.number;
    this.bubble.querySelector('.bubble-name').textContent = node.name;
    this.bubble.querySelector('.bubble-preview').textContent = node.contentPreview || '(暂无内容)';
    this.bubble.dataset.number = node.number;

    // Position the bubble
    const containerRect = this.container.getBoundingClientRect();
    let bx = clientX - containerRect.left + 20;
    let by = clientY - containerRect.top - 60;

    // Keep within bounds
    if (bx + 220 > containerRect.width) bx = clientX - containerRect.left - 240;
    if (by < 10) by = 10;
    if (by + 180 > containerRect.height) by = containerRect.height - 190;

    this.bubble.style.left = bx + 'px';
    this.bubble.style.top = by + 'px';
    this.bubble.classList.remove('hidden');
    this.bubbleVisible = true;
  }

  hideBubble() {
    this.bubble.classList.add('hidden');
    this.bubbleVisible = false;
  }

  // ---- Public API ----
  setPenColor(color) {
    this.penColor = color;
  }

  zoomIn() {
    this.scale = Math.min(3.0, this.scale * 1.2);
  }

  zoomOut() {
    this.scale = Math.max(0.3, this.scale / 1.2);
  }

  resetZoom() {
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  destroy() {
    this.canvas.style.cursor = 'default';
    this.hideBubble();
    this.nodeColors = {};
    this.positions = {};
  }
}
