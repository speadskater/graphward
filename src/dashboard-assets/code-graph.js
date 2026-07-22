(() => {
  const CLUSTER_COLORS = ["#45d7ff", "#64f0b0", "#b28cff", "#ffd166", "#ff7aa2", "#58e0d1", "#6fa8ff", "#f39c55", "#8fe388", "#d58cff"];
  const KIND_COLORS = {
    Function: "#57d5ff",
    Method: "#50e3aa",
    Class: "#b695ff",
    Constructor: "#ff7aa2",
    Module: "#ffc857",
  };
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function hash(value, salt = 0) {
    let output = (2166136261 ^ salt) >>> 0;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      output ^= text.charCodeAt(index);
      output = Math.imul(output, 16777619) >>> 0;
    }
    output ^= output >>> 16;
    output = Math.imul(output, 2246822507) >>> 0;
    output ^= output >>> 13;
    return output >>> 0;
  }

  function unit(value, salt) {
    return hash(value, salt) / 4294967295;
  }

  function rgba(hex, alpha) {
    const value = hex.replace("#", "");
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function clusterRadius(cluster) {
    return 34 + Math.min(172, Math.pow(Math.max(1, cluster.shown_node_count), 0.42) * 8.5);
  }

  function layoutClusters(clusters, links) {
    const rows = clusters.map((cluster, index) => {
      const shell = 175 + Math.sqrt(index + 1) * 122;
      const angle = index * GOLDEN_ANGLE;
      return {
        ...cluster,
        color: CLUSTER_COLORS[index % CLUSTER_COLORS.length],
        radius: clusterRadius(cluster),
        x: Math.cos(angle) * shell,
        y: Math.sin(angle) * shell * 0.72,
        z: (unit(cluster.id, 17) - 0.5) * shell * 1.25,
      };
    });
    const byId = new Map(rows.map((cluster) => [cluster.id, cluster]));
    const graphLinks = links
      .map((link) => ({ source: byId.get(link.source), target: byId.get(link.target), weight: Number(link.calls ?? 0) + Number(link.imports ?? 0) }))
      .filter((link) => link.source && link.target);
    for (let iteration = 0; iteration < 90; iteration += 1) {
      const movement = new Map(rows.map((cluster) => [cluster.id, { x: -cluster.x * 0.0025, y: -cluster.y * 0.0025, z: -cluster.z * 0.0025 }]));
      for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
          const first = rows[left];
          const second = rows[right];
          let dx = second.x - first.x;
          let dy = second.y - first.y;
          let dz = second.z - first.z;
          let distance = Math.hypot(dx, dy, dz);
          if (distance < 0.001) {
            dx = unit(`${first.id}:${second.id}`, 31) - 0.5;
            dy = unit(`${first.id}:${second.id}`, 37) - 0.5;
            dz = unit(`${first.id}:${second.id}`, 41) - 0.5;
            distance = Math.hypot(dx, dy, dz);
          }
          const minimum = first.radius + second.radius + 132;
          const pressure = distance < minimum ? (minimum - distance) * 0.045 : 1_600 / (distance * distance);
          const scale = pressure / distance;
          const mx = dx * scale;
          const my = dy * scale;
          const mz = dz * scale;
          movement.get(first.id).x -= mx;
          movement.get(first.id).y -= my;
          movement.get(first.id).z -= mz;
          movement.get(second.id).x += mx;
          movement.get(second.id).y += my;
          movement.get(second.id).z += mz;
        }
      }
      for (const link of graphLinks) {
        const dx = link.target.x - link.source.x;
        const dy = link.target.y - link.source.y;
        const dz = link.target.z - link.source.z;
        const distance = Math.max(1, Math.hypot(dx, dy, dz));
        const desired = link.source.radius + link.target.radius + 156;
        const pull = (distance - desired) * Math.min(0.018, 0.004 + Math.log1p(link.weight) * 0.0015) / distance;
        const mx = dx * pull;
        const my = dy * pull;
        const mz = dz * pull;
        movement.get(link.source.id).x += mx;
        movement.get(link.source.id).y += my;
        movement.get(link.source.id).z += mz;
        movement.get(link.target.id).x -= mx;
        movement.get(link.target.id).y -= my;
        movement.get(link.target.id).z -= mz;
      }
      for (const cluster of rows) {
        const delta = movement.get(cluster.id);
        cluster.x += clamp(delta.x, -18, 18);
        cluster.y += clamp(delta.y, -18, 18);
        cluster.z += clamp(delta.z, -18, 18);
      }
    }
    return rows;
  }

  function placeNodes(data, clusters) {
    const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    const groups = new Map(clusters.map((cluster) => [cluster.id, []]));
    for (const node of data.nodes) groups.get(node.cluster_id)?.push(node);
    const nodes = [];
    for (const cluster of clusters) {
      const members = (groups.get(cluster.id) ?? []).sort((a, b) => b.score - a.score || a.id - b.id);
      for (let index = 0; index < members.length; index += 1) {
        const source = members[index];
        const key = source.stable_key ?? source.id;
        const theta = unit(key, 53) * Math.PI * 2;
        const phi = Math.acos(clamp(unit(key, 59) * 2 - 1, -1, 1));
        const shell = 0.16 + 0.84 * Math.sqrt((index + 1) / Math.max(1, members.length));
        const radius = cluster.radius * shell * (0.28 + 0.72 * Math.pow(unit(key, 61), 0.42));
        nodes.push({
          ...source,
          cluster,
          x: cluster.x + Math.sin(phi) * Math.cos(theta) * radius,
          y: cluster.y + Math.sin(phi) * Math.sin(theta) * radius * (0.72 + unit(key, 67) * 0.35),
          z: cluster.z + Math.cos(phi) * radius,
          screen: null,
        });
      }
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = data.edges
      .map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
      .filter((edge) => edge.sourceNode && edge.targetNode);
    const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
    for (const edge of edges) {
      adjacency.get(edge.source).add(edge.target);
      adjacency.get(edge.target).add(edge.source);
    }
    const worldRadius = Math.max(300, ...clusters.map((cluster) => Math.hypot(cluster.x, cluster.y, cluster.z) + cluster.radius));
    return { nodes, edges, byId, adjacency, clusterById, worldRadius };
  }

  class CodeGraphRenderer {
    constructor(canvas, tooltip, { onSelect, onOpen } = {}) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.onSelect = onSelect;
      this.onOpen = onOpen;
      this.data = null;
      this.rotationX = -0.2;
      this.rotationY = -0.28;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.dragging = false;
      this.pointerMoved = 0;
      this.selectedId = null;
      this.hoverId = null;
      this.showCalls = true;
      this.showImports = true;
      this.showTests = true;
      this.colorMode = "cluster";
      this.running = false;
      this.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.frame = null;
      this.lastFrame = 0;
      this.bindEvents();
    }

    bindEvents() {
      this.canvas.addEventListener("pointerdown", (event) => {
        this.canvas.setPointerCapture(event.pointerId);
        this.dragging = true;
        this.pointerMoved = 0;
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        this.autoRotate = false;
        this.canvas.classList.add("is-dragging");
      });
      this.canvas.addEventListener("pointermove", (event) => {
        const point = this.pointerPoint(event);
        if (this.dragging) {
          const dx = event.clientX - this.lastPointerX;
          const dy = event.clientY - this.lastPointerY;
          this.pointerMoved += Math.abs(dx) + Math.abs(dy);
          this.rotationY += dx * 0.006;
          this.rotationX = clamp(this.rotationX + dy * 0.006, -1.25, 1.25);
          this.lastPointerX = event.clientX;
          this.lastPointerY = event.clientY;
          this.schedule();
          return;
        }
        const hit = this.findNodeAt(point.x, point.y);
        const nextId = hit?.id ?? null;
        if (nextId !== this.hoverId) {
          this.hoverId = nextId;
          this.updateTooltip(hit, point.x, point.y);
          this.schedule();
        } else if (hit) {
          this.positionTooltip(point.x, point.y);
        }
      });
      this.canvas.addEventListener("pointerup", (event) => {
        const point = this.pointerPoint(event);
        if (this.dragging && this.pointerMoved < 6) this.select(this.findNodeAt(point.x, point.y));
        this.dragging = false;
        this.canvas.classList.remove("is-dragging");
      });
      this.canvas.addEventListener("pointerleave", () => {
        if (!this.dragging) {
          this.hoverId = null;
          this.tooltip.hidden = true;
          this.schedule();
        }
      });
      this.canvas.addEventListener("dblclick", (event) => {
        const point = this.pointerPoint(event);
        const node = this.findNodeAt(point.x, point.y);
        if (!node) return;
        this.select(node);
        this.onOpen?.(node);
      });
      this.canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        this.autoRotate = false;
        this.zoom = clamp(this.zoom * Math.exp(-event.deltaY * 0.0011), 0.3, 4);
        this.schedule();
      }, { passive: false });
    }

    pointerPoint(event) {
      const rectangle = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
    }

    setData(data) {
      const clusters = layoutClusters(data.clusters ?? [], data.cluster_edges ?? []);
      this.data = { ...data, ...placeNodes(data, clusters), clusters };
      this.selectedId = null;
      this.hoverId = null;
      this.resetCamera();
      this.start();
    }

    setOptions({ showCalls, showImports, showTests, colorMode } = {}) {
      if (typeof showCalls === "boolean") this.showCalls = showCalls;
      if (typeof showImports === "boolean") this.showImports = showImports;
      if (typeof showTests === "boolean") this.showTests = showTests;
      if (colorMode === "cluster" || colorMode === "kind") this.colorMode = colorMode;
      this.schedule();
    }

    resetCamera() {
      this.rotationX = -0.2;
      this.rotationY = -0.28;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.schedule();
    }

    start() {
      this.running = true;
      this.schedule();
    }

    stop() {
      this.running = false;
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    schedule() {
      if (!this.running || this.frame != null) return;
      this.frame = requestAnimationFrame((time) => {
        this.frame = null;
        const elapsed = this.lastFrame ? Math.min(32, time - this.lastFrame) : 16;
        this.lastFrame = time;
        if (this.autoRotate && !this.dragging) this.rotationY += elapsed * 0.000032;
        this.draw();
        if (this.autoRotate) this.schedule();
      });
    }

    canvasSize() {
      const rectangle = this.canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rectangle.width * ratio));
      const height = Math.max(1, Math.round(rectangle.height * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const context = this.canvas.getContext("2d");
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { context, width: rectangle.width, height: rectangle.height };
    }

    project(point, width, height) {
      const cosineY = Math.cos(this.rotationY);
      const sineY = Math.sin(this.rotationY);
      const x1 = point.x * cosineY - point.z * sineY;
      const z1 = point.x * sineY + point.z * cosineY;
      const cosineX = Math.cos(this.rotationX);
      const sineX = Math.sin(this.rotationX);
      const y2 = point.y * cosineX - z1 * sineX;
      const z2 = point.y * sineX + z1 * cosineX;
      const baseScale = Math.min(width * 0.84, height * 1.08) / Math.max(1, this.data.worldRadius * 2);
      const camera = this.data.worldRadius * 3.1;
      const perspective = clamp(camera / Math.max(camera * 0.34, camera - z2), 0.46, 2.3);
      return {
        x: width / 2 + this.panX + x1 * baseScale * this.zoom * perspective,
        y: height / 2 + this.panY + y2 * baseScale * this.zoom * perspective,
        depth: z2,
        perspective,
        scale: baseScale * this.zoom * perspective,
      };
    }

    nodeVisible(node) {
      return this.showTests || !node.test;
    }

    edgeVisible(edge) {
      if (edge.kind === "calls" && !this.showCalls) return false;
      if (edge.kind === "imports" && !this.showImports) return false;
      return this.nodeVisible(edge.sourceNode) && this.nodeVisible(edge.targetNode);
    }

    activeSet() {
      const activeId = this.selectedId ?? this.hoverId;
      if (activeId == null || !this.data) return null;
      return new Set([activeId, ...(this.data.adjacency.get(activeId) ?? [])]);
    }

    nodeColor(node) {
      return this.colorMode === "kind" ? (KIND_COLORS[node.kind] ?? "#9db0c3") : node.cluster.color;
    }

    drawEdges(context, activeId) {
      const regular = { calls: [], imports: [] };
      const active = { calls: [], imports: [] };
      for (const edge of this.data.edges) {
        if (!this.edgeVisible(edge)) continue;
        const target = edge.source === activeId || edge.target === activeId ? active : regular;
        target[edge.kind].push(edge);
      }
      const stroke = (rows, color, alpha, width) => {
        if (!rows.length) return;
        context.beginPath();
        for (const edge of rows) {
          const source = edge.sourceNode.screen;
          const target = edge.targetNode.screen;
          if (!source || !target) continue;
          context.moveTo(source.x, source.y);
          context.lineTo(target.x, target.y);
        }
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = width;
        context.stroke();
      };
      stroke(regular.calls, "#6ed7ff", activeId == null ? 0.13 : 0.025, 0.55);
      stroke(regular.imports, "#ff9f43", activeId == null ? 0.16 : 0.035, 0.65);
      stroke(active.calls, "#b7efff", 0.82, 1.2);
      stroke(active.imports, "#ffc27c", 0.88, 1.3);
      context.globalAlpha = 1;
    }

    drawNodeGroups(context, nodes, alpha, radiusBoost = 0) {
      const groups = new Map();
      for (const node of nodes) {
        const color = this.nodeColor(node);
        const group = groups.get(color) ?? [];
        group.push(node);
        groups.set(color, group);
      }
      context.globalAlpha = alpha;
      for (const [color, rows] of groups) {
        context.beginPath();
        for (const node of rows) {
          const screen = node.screen;
          const degree = Number(node.incoming ?? 0) + Number(node.outgoing ?? 0);
          const radius = clamp((0.72 + Math.log1p(degree) * 0.32 + radiusBoost) * Math.sqrt(screen.perspective), 0.65, 4.4 + radiusBoost);
          context.moveTo(screen.x + radius, screen.y);
          context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        }
        context.fillStyle = color;
        context.fill();
      }
      context.globalAlpha = 1;
    }

    drawClusters(context, width, height) {
      for (const cluster of this.data.clusters) {
        const visible = this.showTests || !cluster.tests;
        if (!visible) continue;
        const center = this.project(cluster, width, height);
        cluster.screen = center;
        const radius = clamp(cluster.radius * center.scale, 10, Math.max(width, height) * 0.36);
        const gradient = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
        gradient.addColorStop(0, rgba(cluster.color, 0.11));
        gradient.addColorStop(0.55, rgba(cluster.color, 0.035));
        gradient.addColorStop(1, rgba(cluster.color, 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(center.x, center.y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    drawClusterLabels(context, width, height) {
      const labels = [];
      const selectedCluster = this.data.byId.get(this.selectedId)?.cluster_id ?? null;
      context.font = "600 9px Segoe UI";
      context.textBaseline = "middle";
      for (const cluster of this.data.clusters) {
        if (!this.showTests && cluster.tests) continue;
        const point = this.project({ x: cluster.x, y: cluster.y - cluster.radius * 0.76, z: cluster.z }, width, height);
        if (point.x < -120 || point.y < -40 || point.x > width + 120 || point.y > height + 40) continue;
        const label = String(cluster.name ?? cluster.path).toUpperCase();
        const count = new Intl.NumberFormat().format(cluster.shown_node_count);
        const text = `${label}  ${count}`;
        const widthValue = context.measureText(text).width + 30;
        labels.push({
          cluster,
          point,
          text,
          widthValue,
          rect: { left: point.x - widthValue / 2 - 4, right: point.x + widthValue / 2 + 4, top: point.y - 16, bottom: point.y + 16 },
        });
      }
      labels.sort((a, b) => Number(b.cluster.id === selectedCluster) - Number(a.cluster.id === selectedCluster)
        || b.cluster.shown_node_count - a.cluster.shown_node_count
        || b.point.depth - a.point.depth);
      const placed = [];
      for (const label of labels) {
        const overlaps = placed.some((item) => !(label.rect.right < item.rect.left || label.rect.left > item.rect.right || label.rect.bottom < item.rect.top || label.rect.top > item.rect.bottom));
        if (overlaps && label.cluster.id !== selectedCluster) continue;
        placed.push(label);
        if (placed.length >= 22) break;
      }
      placed.sort((a, b) => a.point.depth - b.point.depth);
      for (const { cluster, point, text, widthValue } of placed) {
        const left = point.x - widthValue / 2;
        const top = point.y - 12;
        context.beginPath();
        context.roundRect(left, top, widthValue, 24, 12);
        context.fillStyle = "rgba(7, 14, 27, 0.9)";
        context.fill();
        context.strokeStyle = rgba(cluster.color, 0.5);
        context.lineWidth = 1;
        context.stroke();
        context.beginPath();
        context.arc(left + 12, point.y, 3.4, 0, Math.PI * 2);
        context.fillStyle = cluster.color;
        context.fill();
        context.fillStyle = "#d8e5f2";
        context.textAlign = "left";
        context.fillText(text, left + 21, point.y + 0.5);
      }
    }

    drawSelection(context) {
      const node = this.data.byId.get(this.selectedId ?? this.hoverId);
      if (!node?.screen || !this.nodeVisible(node)) return;
      context.save();
      context.beginPath();
      context.arc(node.screen.x, node.screen.y, this.selectedId === node.id ? 5.5 : 4.2, 0, Math.PI * 2);
      context.fillStyle = this.nodeColor(node);
      context.shadowColor = this.nodeColor(node);
      context.shadowBlur = 18;
      context.fill();
      context.shadowBlur = 0;
      context.strokeStyle = "rgba(242, 248, 255, 0.92)";
      context.lineWidth = 1;
      context.stroke();
      context.restore();
    }

    draw() {
      if (!this.data) return;
      const { context, width, height } = this.canvasSize();
      context.clearRect(0, 0, width, height);
      this.drawClusters(context, width, height);
      const visibleNodes = [];
      for (const node of this.data.nodes) {
        node.screen = this.project(node, width, height);
        if (this.nodeVisible(node) && node.screen.x > -20 && node.screen.y > -20 && node.screen.x < width + 20 && node.screen.y < height + 20) visibleNodes.push(node);
      }
      const activeId = this.selectedId ?? this.hoverId;
      const activeSet = this.activeSet();
      this.drawEdges(context, activeId);
      if (activeSet) {
        this.drawNodeGroups(context, visibleNodes.filter((node) => !activeSet.has(node.id)), 0.12);
        this.drawNodeGroups(context, visibleNodes.filter((node) => activeSet.has(node.id)), 0.96, 0.5);
      } else {
        this.drawNodeGroups(context, visibleNodes, 0.88);
      }
      this.drawSelection(context);
      this.drawClusterLabels(context, width, height);
    }

    findNodeAt(x, y) {
      if (!this.data) return null;
      let best = null;
      let bestDistance = 11 * 11;
      for (const node of this.data.nodes) {
        if (!this.nodeVisible(node) || !node.screen) continue;
        const dx = node.screen.x - x;
        const dy = node.screen.y - y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance || (distance === bestDistance && node.screen.depth > (best?.screen?.depth ?? -Infinity))) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    }

    select(node) {
      this.selectedId = node?.id ?? null;
      this.onSelect?.(node ?? null);
      this.schedule();
    }

    clearSelection() {
      this.select(null);
    }

    focus(query) {
      if (!this.data) return null;
      const needle = String(query ?? "").trim().toLowerCase();
      if (!needle) return null;
      const matches = this.data.nodes
        .filter((node) => `${node.name} ${node.qualified_name} ${node.file_path}`.toLowerCase().includes(needle))
        .map((node) => {
          const name = String(node.name).toLowerCase();
          const qualified = String(node.qualified_name).toLowerCase();
          const path = String(node.file_path).toLowerCase();
          let score = Number(node.score ?? 0);
          if (name === needle || qualified === needle) score += 1_000;
          else if (name.startsWith(needle) || qualified.startsWith(needle)) score += 100;
          else if (path.endsWith(needle)) score += 20;
          return { node, score };
        })
        .sort((a, b) => b.score - a.score || a.node.id - b.node.id);
      const node = matches[0]?.node ?? null;
      if (!node) return null;
      if (node.test && !this.showTests) this.showTests = true;
      const rectangle = this.canvas.getBoundingClientRect();
      const projected = this.project(node, rectangle.width, rectangle.height);
      this.panX += rectangle.width / 2 - projected.x;
      this.panY += rectangle.height / 2 - projected.y;
      this.autoRotate = false;
      this.select(node);
      return node;
    }

    updateTooltip(node, x, y) {
      if (!node) {
        this.tooltip.hidden = true;
        return;
      }
      this.tooltip.innerHTML = `<strong>${escapeHtml(node.qualified_name ?? node.name)}</strong><small>${escapeHtml(node.file_path)}:${node.start_line} · ${escapeHtml(node.kind)}</small>`;
      this.tooltip.hidden = false;
      this.positionTooltip(x, y);
    }

    positionTooltip(x, y) {
      const stage = this.canvas.parentElement.getBoundingClientRect();
      const width = this.tooltip.offsetWidth || 220;
      const height = this.tooltip.offsetHeight || 48;
      this.tooltip.style.left = `${clamp(x + 14, 8, stage.width - width - 8)}px`;
      this.tooltip.style.top = `${clamp(y + 14, 8, stage.height - height - 8)}px`;
    }
  }

  window.GraphwardCodeGraph = { CodeGraphRenderer };
})();
