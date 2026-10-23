#!/usr/bin/env node
// 節點畫布工具：讀取、套用變更、自動排版 Excalidraw 檔
//
//   node canvas.mjs read  <檔案.excalidraw> [--pos]   列出節點樹（含 id、說明、鎖定狀態）
//   node canvas.mjs apply <檔案.excalidraw> <ops.json> 套用變更並排版
//   node canvas.mjs new   <檔案.excalidraw>           建立空白畫布
//   node canvas.mjs import <檔案.xmind> <新畫布.excalidraw>  把 Xmind 心智圖轉成新畫布（保留收合，圖片掛在節點下方）
//
// 每次修改前的備份放在畫布旁邊的 .canvas-history/ 資料夾。給 AI 的完整操作說明見 AGENTS.md
//
// 節點 = 有文字或有連線的方框／橢圓／菱形。文字第一行是名稱，其餘是說明。
//
// ops.json 格式（每一段都可省略）：
// {
//   "removeTree": ["<節點>"],           // 刪除節點和它底下整個分支
//   "remove":  ["<節點>"],
//   "update":  [{ "node": "<節點>", "name": "新名稱", "desc": "新說明", "color": "#a5d8ff" }],
//   "add":     [{ "key": "暫時代號", "name": "名稱", "desc": "說明", "parent": "<節點>", "color": "#b2f2bb" }],
//   "move":    [{ "node": "<節點>", "parent": "<節點>" }],  // 連同底下整個分支搬到新的上層，依順序排在最後
//   "connect": [{ "from": "<節點>", "to": "<節點>" }],
//   "layout":  "new" | "all" | "none",   // 預設 new：只排新節點，既有位置不動；all：全部重排（鎖定的不動）
//   "direction": "RIGHT" | "DOWN",        // 預設 RIGHT
//   "font": "Nunito" | "Excalifont"       // 整張畫布的節點換字型（預設新節點用 Nunito＝黑體）
// }
// <節點> 可以是 id、同一份 ops 裡的 key，或名稱（名稱重複時要用 id）。
//
// 收合（像 Xmind）：節點的 customData.collapsed = true 時，底下整個分支在畫布上隱藏，排版也跳過它們。
// 畫布上點節點右側的 − / ＋ 收合或展開（server.mjs 的 /fold 呼叫這裡的 foldScene）。
// 在收合的節點下新增子節點時，會自動展開它。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';

const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
const NODE_W = 280;
const FONT_SIZE = 16;
// Excalidraw 的字型代號和行高（行高要和 Excalidraw 一致，文字才不會跑出方框）
const FONTS = {
  Excalifont: { id: 5, lineHeight: 1.25 }, // 手寫風，中文用小賴字體
  Nunito: { id: 6, lineHeight: 1.35 }, // 一般，中文用電腦內建的黑體（Mac 蘋方、Windows 微軟正黑體）
};
const DEFAULT_FONT = FONTS.Nunito;
const FONT_FAMILY = DEFAULT_FONT.id;
const LINE_HEIGHT = DEFAULT_FONT.lineHeight;
const PAD = 5; // Excalidraw 綁定文字的固定內距
const V_PAD = 18; // 文字上下額外留白
const GAP_LAYER = 100; // 層與層之間
const GAP_SIBLING = 32; // 同層節點之間
const ARROW_GAP = 6;
const IMG_GAP = 8; // 節點和下方圖片的距離
const IMG_MAX_W = 360; // 圖片在畫布上的最大寬度
const IMG_MAX_PX = 1200; // 匯入時圖片縮到最長邊這麼多像素，畫布檔才不會太大
const PALETTE = ['#ffec99', '#a5d8ff', '#b2f2bb', '#d0bfff', '#ffc9c9'];
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 備份放在畫布旁邊：同一套工具給很多張畫布用，備份也不會混在一起
const historyDir = (file) => path.join(path.dirname(path.resolve(file)), '.canvas-history');

// ---------- 小工具 ----------

const rand = () => crypto.randomInt(1, 2 ** 31 - 1);
const newId = () => Array.from(crypto.randomBytes(20), (b) => ALPHABET[b % 62]).join('');

function baseElement(type, props) {
  return {
    id: newId(), type, x: 0, y: 0, width: 0, height: 0, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: rand(), version: 1,
    versionNonce: rand(), isDeleted: false, boundElements: null,
    updated: Date.now(), link: null, locked: false, ...props,
  };
}

function touch(el) {
  el.version = (el.version ?? 1) + 1;
  el.versionNonce = rand();
  el.updated = Date.now();
}

// 依陣列順序重新給 fractional index（a0..az, b00..bzz, c000..）
function indexKey(i) {
  if (i < 62) return 'a' + ALPHABET[i];
  i -= 62;
  if (i < 62 ** 2) return 'b' + ALPHABET[Math.floor(i / 62)] + ALPHABET[i % 62];
  i -= 62 ** 2;
  return 'c' + ALPHABET[Math.floor(i / 62 ** 2)] + ALPHABET[Math.floor(i / 62) % 62] + ALPHABET[i % 62];
}

// ---------- 文字量測與換行（估算，寧可偏寬） ----------

const WIDE = /[ᄀ-ᅟ←-⇿①-➿⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const NO_LINE_START = /^[，。、；：？！）」』〉》…,.;:!?)]$/;

function charWidth(ch, fs) {
  if (ch === ' ') return 0.4 * fs;
  if (WIDE.test(ch) || ch.codePointAt(0) > 0xffff) return 1.0 * fs;
  return 0.62 * fs;
}
const textWidth = (s, fs) => [...s].reduce((w, ch) => w + charWidth(ch, fs), 0);

function wrap(text, maxW, fs) {
  const out = [];
  for (const para of text.split('\n')) {
    const tokens = para.match(/[A-Za-z0-9_.@#%&+=\-/]+|\s+|./gu) ?? [];
    let line = '';
    for (let tok of tokens) {
      if (textWidth(line + tok, fs) <= maxW || NO_LINE_START.test(tok)) {
        line += tok;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = '';
      tok = tok.trimStart();
      while (textWidth(tok, fs) > maxW) {
        const chars = [...tok];
        let n = 1;
        while (n < chars.length && textWidth(chars.slice(0, n + 1).join(''), fs) <= maxW) n++;
        out.push(chars.slice(0, n).join(''));
        tok = chars.slice(n).join('');
      }
      line = tok;
    }
    out.push(line.trimEnd());
  }
  return out;
}

// 容器內可放文字的區域（對齊 Excalidraw 的算法）
function innerBox(node) {
  let ox = 0, oy = 0;
  if (node.type === 'ellipse') {
    ox = (node.width / 2) * (1 - Math.SQRT1_2);
    oy = (node.height / 2) * (1 - Math.SQRT1_2);
  } else if (node.type === 'diamond') {
    ox = node.width / 4;
    oy = node.height / 4;
  }
  return { x: node.x + ox + PAD, y: node.y + oy + PAD, w: node.width - 2 * (ox + PAD), h: node.height - 2 * (oy + PAD) };
}

// 依原始文字重新換行，必要時把節點長高，並把文字放回節點中間
function fitText(node, text, raw) {
  const fs = text.fontSize ?? FONT_SIZE;
  const lh = text.lineHeight ?? LINE_HEIGHT;
  let box = innerBox(node);
  const lines = wrap(raw, box.w - 8, fs);
  const th = lines.length * fs * lh;
  const extra = node.height - box.h; // 形狀造成的上下損失
  if (box.h < th) {
    node.height = Math.ceil(th + 2 * V_PAD + extra - 2 * PAD);
    touch(node);
    box = innerBox(node);
  }
  text.text = lines.join('\n');
  text.originalText = raw;
  text.width = Math.min(box.w, Math.max(1, ...lines.map((l) => textWidth(l, fs))));
  text.height = th;
  placeText(node, text);
}

function placeText(node, text) {
  const box = innerBox(node);
  const align = text.textAlign ?? 'left';
  text.x = align === 'left' ? box.x : align === 'right' ? box.x + box.w - text.width : box.x + (box.w - text.width) / 2;
  const valign = text.verticalAlign ?? 'middle';
  text.y = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - text.height : box.y + (box.h - text.height) / 2;
  touch(text);
}

const composeText = (name, desc) => (desc ? `${name}\n\n${desc}` : name);

// ---------- 讀取畫布成圖 ----------

function loadScene(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const scene = JSON.parse(raw);
  scene.elements ??= [];
  return { scene, mtime: fs.statSync(file).mtimeMs };
}

export function readGraph(scene) {
  const els = scene.elements.filter((e) => !e.isDeleted);
  const textOf = new Map();
  for (const t of els) if (t.type === 'text' && t.containerId) textOf.set(t.containerId, t);
  const shapes = new Map(els.filter((e) => NODE_TYPES.has(e.type)).map((e) => [e.id, e]));

  const arrows = els.filter((e) => e.type === 'arrow');
  const edges = [];
  const connected = new Set();
  for (const a of arrows) {
    const from = a.startBinding?.elementId;
    const to = a.endBinding?.elementId;
    if (shapes.has(from) && shapes.has(to)) {
      edges.push({ from, to, arrow: a });
      connected.add(from).add(to);
    }
  }

  const nodes = new Map();
  for (const el of shapes.values()) {
    const text = textOf.get(el.id);
    if (!text && !connected.has(el.id)) continue; // 沒字也沒線的形狀當裝飾，不算節點
    const raw = (text?.originalText ?? text?.text ?? '').replace(/\r/g, '');
    const [first = '', ...rest] = raw.split('\n');
    nodes.set(el.id, { id: el.id, el, text, name: first.trim(), desc: rest.join('\n').trim() });
  }
  // 掛在節點下方的圖片（customData.attachedTo），排版時跟著節點走
  for (const im of els) if (im.type === 'image' && nodes.has(im.customData?.attachedTo)) nodes.get(im.customData.attachedTo).image = im;
  const notes = els.filter((e) => e.type === 'text' && !e.containerId);
  const looseArrows = arrows.filter((a) => !edges.some((e) => e.arrow === a));
  return { nodes, edges, notes, looseArrows };
}

// ---------- read ----------

function cmdRead(file, opts) {
  const { scene } = loadScene(file);
  checkLastAdded(file, scene);
  const g = readGraph(scene);
  const out = [];
  out.push(`檔案：${path.basename(file)}　節點 ${g.nodes.size}、連線 ${g.edges.length}`);
  out.push('（🔒＝已鎖定，排版時不會移動；⊕已收合＝底下的分支在畫布上隱藏；[ ] 內是 id）');
  out.push('');

  const children = new Map();
  const hasParent = new Set();
  for (const e of g.edges) {
    if (!g.nodes.has(e.from) || !g.nodes.has(e.to)) continue;
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
    hasParent.add(e.to);
  }
  const byPos = (a, b) => g.nodes.get(a).el.y - g.nodes.get(b).el.y || g.nodes.get(a).el.x - g.nodes.get(b).el.x;
  for (const list of children.values()) list.sort(byPos);

  const seen = new Set();
  const line = (n, depth) => {
    const pad = '  '.repeat(depth);
    const lock = (n.el.locked ? ' 🔒' : '') + (isCollapsed(n) ? ' ⊕已收合' : '') + (n.image ? ' 🖼' : '');
    const pos = opts.pos ? ` @${Math.round(n.el.x)},${Math.round(n.el.y)} ${Math.round(n.el.width)}×${Math.round(n.el.height)}` : '';
    out.push(`${pad}${depth ? '→ ' : ''}${n.name || '（未命名）'}  [${n.id}]${lock}${pos}`);
    if (n.desc) for (const d of n.desc.split('\n')) out.push(`${pad}${depth ? '  ' : ''}  │ ${d}`);
  };
  const walk = (id, depth) => {
    const n = g.nodes.get(id);
    if (seen.has(id)) {
      out.push(`${'  '.repeat(depth)}→ ↺ ${n.name || '（未命名）'}（見上方）`);
      return;
    }
    seen.add(id);
    line(n, depth);
    for (const c of children.get(id) ?? []) walk(c, depth + 1);
  };
  const roots = [...g.nodes.keys()].filter((id) => !hasParent.has(id)).sort(byPos);
  for (const r of roots) walk(r, 0);
  for (const id of g.nodes.keys()) if (!seen.has(id)) walk(id, 0); // 環狀結構

  if (g.notes.length) {
    out.push('', '註記文字：');
    for (const t of g.notes) out.push(`  「${(t.originalText ?? t.text).replace(/\n/g, ' ⏎ ')}」 [${t.id}]`);
  }
  if (g.looseArrows.length) out.push('', `沒有接到兩個節點的箭頭：${g.looseArrows.length} 條`);
  console.log(out.join('\n'));
}

// ---------- 收合 ----------

export const isCollapsed = (n) => !!n.el.customData?.collapsed;

function childrenMap(g) {
  const ch = new Map();
  for (const e of g.edges) {
    if (!g.nodes.has(e.from) || !g.nodes.has(e.to) || e.from === e.to) continue;
    if (!ch.has(e.from)) ch.set(e.from, []);
    ch.get(e.from).push(e.to);
  }
  return ch;
}

// 被收合而隱藏的節點 → 負責它的「看得到的收合節點」（排版時隱藏的節點跟著它移動）
function foldInfo(g) {
  const ch = childrenMap(g);
  const hidden = new Map();
  for (const n of g.nodes.values()) {
    if (!isCollapsed(n)) continue;
    const queue = [...(ch.get(n.id) ?? [])];
    while (queue.length) {
      const id = queue.shift();
      if (id === n.id || hidden.has(id)) continue;
      hidden.set(id, n.id);
      queue.push(...(ch.get(id) ?? []));
    }
  }
  for (const [id, owner] of hidden) {
    let o = owner;
    const seen = new Set();
    while (hidden.has(o) && !seen.has(o)) { seen.add(o); o = hidden.get(o); }
    hidden.set(id, o);
  }
  return { hidden, ch };
}

function visibleGraph(g, hidden) {
  return {
    ...g,
    nodes: new Map([...g.nodes].filter(([id]) => !hidden.has(id))),
    edges: g.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)),
  };
}

function setCollapsed(n, value) {
  if (isCollapsed(n) === value) return false;
  const cd = { ...(n.el.customData ?? {}) };
  if (value) cd.collapsed = true;
  else delete cd.collapsed;
  n.el.customData = Object.keys(cd).length ? cd : undefined;
  touch(n.el);
  return true;
}

function depthMap(g, ch) {
  const hasParent = new Set(g.edges.map((e) => e.to));
  const depth = new Map();
  const queue = [...g.nodes.keys()].filter((id) => !hasParent.has(id)).map((id) => [id, 0]);
  while (queue.length) {
    const [id, d] = queue.shift();
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const c of ch.get(id) ?? []) queue.push([c, d + 1]);
  }
  return depth;
}

// 畫布上的收合操作：op = { op: 'toggle', id } | { op: 'expandAll' } | { op: 'level', level }
// level：第 level 層（根＝0）的節點收合，比它淺的展開。layout：收合／展開後是否重排看得到的節點
export async function foldScene(scene, op, { layout = true, direction = 'RIGHT' } = {}) {
  const g = readGraph(scene);
  const { ch } = foldInfo(g);
  let changed = 0;
  if (op.op === 'toggle') {
    const n = g.nodes.get(op.id);
    if (!n) throw new Error('找不到節點');
    if (!(ch.get(n.id)?.length) && !isCollapsed(n)) return { changed: 0 };
    changed += setCollapsed(n, !isCollapsed(n));
  } else if (op.op === 'expandAll') {
    for (const n of g.nodes.values()) changed += setCollapsed(n, false);
  } else if (op.op === 'level') {
    const depth = depthMap(g, ch);
    for (const n of g.nodes.values()) {
      const d = depth.get(n.id) ?? 0;
      changed += setCollapsed(n, d === op.level && !!ch.get(n.id)?.length);
    }
  } else throw new Error('不認得的收合操作');
  if (layout) await arrange(scene, readGraph(scene), { layout: 'all', direction });
  else syncBindings(scene);
  return { changed };
}

// ---------- 排版 ----------

async function elkLayout(g, direction) {
  const elk = new ELK();
  const ids = [...g.nodes.keys()];
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': String(GAP_SIBLING),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(GAP_LAYER),
      'elk.spacing.componentComponent': String(GAP_LAYER),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED', // 父節點對齊子節點群的中間
    },
    children: ids.map((id) => ({ id, width: boxW(g.nodes.get(id)), height: boxH(g.nodes.get(id)) })),
    edges: g.edges
      .filter((e) => e.from !== e.to && g.nodes.has(e.from) && g.nodes.has(e.to))
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const res = await elk.layout(graph);
  return new Map(res.children.map((c) => [c.id, { x: c.x, y: c.y }]));
}

// 節點占的範圍：方框加上掛在下方的圖片
const boxW = (n) => Math.max(n.el.width, n.image?.width ?? 0);
const boxH = (n) => n.el.height + (n.image ? IMG_GAP + n.image.height : 0);
const rectOf = (n, x = n.el.x, y = n.el.y) => ({ x, y, w: boxW(n), h: boxH(n) });
const overlaps = (a, b, m) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

// 只排新節點：整群新節點照 ELK 的相對位置掛在既有的父節點旁，撞到就往旁邊挪
function placeNew(g, elkPos, newIds, direction, preferredAnchor) {
  const moved = new Set();
  const placed = [...g.nodes.values()].filter((n) => !newIds.has(n.id)).map((n) => rectOf(n));
  const adj = new Map();
  for (const e of g.edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
  }
  const done = new Set();
  for (const start of newIds) {
    if (done.has(start)) continue;
    const group = [];
    const queue = [start];
    done.add(start);
    while (queue.length) {
      const id = queue.shift();
      group.push(id);
      for (const nb of adj.get(id) ?? []) if (newIds.has(nb) && !done.has(nb)) { done.add(nb); queue.push(nb); }
    }
    const neighbours = group.flatMap((id) => (adj.get(id) ?? []).filter((nb) => !newIds.has(nb) && g.nodes.has(nb)));
    const preferred = group.map((id) => preferredAnchor.get(id)).find((a) => a && !newIds.has(a));
    const anchor = preferred ?? neighbours[0];

    let dx, dy;
    if (anchor) {
      const a = g.nodes.get(anchor).el;
      dx = a.x - elkPos.get(anchor).x;
      dy = a.y - elkPos.get(anchor).y;
    } else {
      const all = [...g.nodes.values()].filter((n) => !newIds.has(n.id)).map((n) => n.el);
      const minX = Math.min(...group.map((id) => elkPos.get(id).x));
      const minY = Math.min(...group.map((id) => elkPos.get(id).y));
      dx = (all.length ? Math.min(...all.map((e) => e.x)) : 0) - minX;
      dy = (all.length ? Math.max(...all.map((e) => e.y + e.height)) + GAP_LAYER : 0) - minY;
    }
    // 撞到既有節點就沿著「同層」方向挪開
    for (let i = 0; i < 500; i++) {
      const rects = group.map((id) => rectOf(g.nodes.get(id), elkPos.get(id).x + dx, elkPos.get(id).y + dy));
      const r = rects.find((rr) => placed.some((p) => overlaps(rr, p, GAP_SIBLING / 2)));
      if (!r) break;
      const p = placed.find((pp) => overlaps(r, pp, GAP_SIBLING / 2));
      if (direction === 'RIGHT') dy += p.y + p.h + GAP_SIBLING - r.y;
      else dx += p.x + p.w + GAP_SIBLING - r.x;
    }
    for (const id of group) {
      const el = g.nodes.get(id).el;
      el.x = Math.round(elkPos.get(id).x + dx);
      el.y = Math.round(elkPos.get(id).y + dy);
      placed.push(rectOf(g.nodes.get(id)));
      moved.add(id);
    }
  }
  return moved;
}

// 全部重排：鎖定的節點不動，其餘照 ELK
function placeAll(g, elkPos) {
  const moved = new Set();
  const nodes = [...g.nodes.values()];
  const locked = nodes.filter((n) => n.el.locked);
  let dx, dy;
  if (locked.length) {
    dx = locked[0].el.x - elkPos.get(locked[0].id).x;
    dy = locked[0].el.y - elkPos.get(locked[0].id).y;
  } else {
    dx = Math.min(...nodes.map((n) => n.el.x)) - Math.min(...nodes.map((n) => elkPos.get(n.id).x));
    dy = Math.min(...nodes.map((n) => n.el.y)) - Math.min(...nodes.map((n) => elkPos.get(n.id).y));
  }
  for (const n of nodes) {
    if (n.el.locked) continue;
    const x = Math.round(elkPos.get(n.id).x + dx);
    const y = Math.round(elkPos.get(n.id).y + dy);
    if (x !== n.el.x || y !== n.el.y) { n.el.x = x; n.el.y = y; moved.add(n.id); }
  }
  const warn = [];
  for (const l of locked) {
    for (const n of nodes) if (n !== l && !n.el.locked && overlaps(rectOf(l), rectOf(n), 0)) warn.push(`「${l.name}」（鎖定）和「${n.name}」重疊`);
  }
  return { moved, warn };
}

// ---------- 箭頭 ----------

function routeArrow(arrow, a, b) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  let sp, ep, sfp, efp, horizontal;
  if (b.x >= a.x + a.width) { sp = { x: a.x + a.width + ARROW_GAP, y: ac.y }; ep = { x: b.x - ARROW_GAP, y: bc.y }; sfp = [1, 0.5]; efp = [0, 0.5]; horizontal = true; }
  else if (b.x + b.width <= a.x) { sp = { x: a.x - ARROW_GAP, y: ac.y }; ep = { x: b.x + b.width + ARROW_GAP, y: bc.y }; sfp = [0, 0.5]; efp = [1, 0.5]; horizontal = true; }
  else if (b.y >= a.y + a.height) { sp = { x: ac.x, y: a.y + a.height + ARROW_GAP }; ep = { x: bc.x, y: b.y - ARROW_GAP }; sfp = [0.5, 1]; efp = [0.5, 0]; horizontal = false; }
  else { sp = { x: ac.x, y: a.y - ARROW_GAP }; ep = { x: bc.x, y: b.y + b.height + ARROW_GAP }; sfp = [0.5, 0]; efp = [0.5, 1]; horizontal = false; }

  const dx = ep.x - sp.x;
  const dy = ep.y - sp.y;
  let points;
  if (!arrow.elbowed) points = [[0, 0], [dx, dy]];
  else if (horizontal) points = Math.abs(dy) < 1 ? [[0, 0], [dx, 0]] : [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]];
  else points = Math.abs(dx) < 1 ? [[0, 0], [0, dy]] : [[0, 0], [0, dy / 2], [dx, dy / 2], [dx, dy]];

  arrow.x = sp.x;
  arrow.y = sp.y;
  arrow.points = points;
  arrow.width = Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
  arrow.height = Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]));
  arrow.startBinding = { ...arrow.startBinding, elementId: a.id, focus: 0, gap: ARROW_GAP, ...(arrow.elbowed ? { fixedPoint: sfp } : {}) };
  arrow.endBinding = { ...arrow.endBinding, elementId: b.id, focus: 0, gap: ARROW_GAP, ...(arrow.elbowed ? { fixedPoint: efp } : {}) };
  if (arrow.elbowed) arrow.fixedSegments = null;
  touch(arrow);
}

function newArrow(a, b) {
  return baseElement('arrow', {
    points: [[0, 0], [1, 0]], lastCommittedPoint: null,
    startBinding: { elementId: a.id, focus: 0, gap: ARROW_GAP },
    endBinding: { elementId: b.id, focus: 0, gap: ARROW_GAP },
    startArrowhead: null, endArrowhead: 'arrow',
    elbowed: true, fixedSegments: null, startIsSpecial: null, endIsSpecial: null,
  });
}

// 讓每個節點的 boundElements 和實際的文字、箭頭一致
function syncBindings(scene) {
  const els = scene.elements.filter((e) => !e.isDeleted);
  const bound = new Map();
  const add = (id, entry) => { if (!bound.has(id)) bound.set(id, []); bound.get(id).push(entry); };
  for (const e of els) {
    if (e.type === 'text' && e.containerId) add(e.containerId, { type: 'text', id: e.id });
    if (e.type === 'arrow') {
      if (e.startBinding?.elementId) add(e.startBinding.elementId, { type: 'arrow', id: e.id });
      if (e.endBinding?.elementId && e.endBinding.elementId !== e.startBinding?.elementId) add(e.endBinding.elementId, { type: 'arrow', id: e.id });
    }
  }
  for (const e of els) {
    if (e.type === 'text' || e.type === 'arrow' || e.type === 'line' || e.type === 'freedraw') continue;
    const next = bound.get(e.id) ?? null;
    if (JSON.stringify(next ?? []) !== JSON.stringify(e.boundElements ?? [])) { e.boundElements = next; touch(e); }
  }
  scene.elements.forEach((e, i) => { e.index = indexKey(i); });
}

// ---------- apply ----------

async function cmdApply(file, opsFile) {
  const ops = JSON.parse(fs.readFileSync(opsFile, 'utf8'));
  const { scene, mtime } = loadScene(file);
  checkLastAdded(file, scene);
  const { report, newIds, g } = await applyOps(scene, ops);
  writeScene(file, scene, mtime);
  saveHistory(file, ops, [...newIds].map((id) => ({ id, name: g.nodes.get(id)?.name })));
  console.log(report.join('\n') || '沒有變更');
}

async function applyOps(scene, ops) {
  const direction = ops.direction === 'DOWN' ? 'DOWN' : 'RIGHT';
  let g = readGraph(scene);
  const keys = new Map();
  const report = [];

  const resolve = (ref) => {
    if (keys.has(ref)) return keys.get(ref);
    if (g.nodes.has(ref)) return ref;
    const hits = [...g.nodes.values()].filter((n) => n.name === String(ref).trim());
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) throw new Error(`名稱「${ref}」有 ${hits.length} 個節點，請改用 id：${hits.map((h) => h.id).join(', ')}`);
    throw new Error(`找不到節點「${ref}」`);
  };

  // 1. 刪除（整個分支、單一節點）
  for (const ref of ops.removeTree ?? []) {
    const top = resolve(ref);
    const ids = new Set([top]);
    const queue = [top];
    while (queue.length) {
      const id = queue.shift();
      for (const e of g.edges) if (e.from === id && !ids.has(e.to)) { ids.add(e.to); queue.push(e.to); }
    }
    const drop = new Set();
    for (const id of ids) { const n = g.nodes.get(id); drop.add(id); if (n.text) drop.add(n.text.id); if (n.image) drop.add(n.image.id); }
    for (const e of g.edges) if (ids.has(e.from) || ids.has(e.to)) drop.add(e.arrow.id);
    scene.elements = scene.elements.filter((e) => !drop.has(e.id));
    report.push(`刪除「${g.nodes.get(top).name}」及底下 ${ids.size - 1} 個節點`);
    g = readGraph(scene);
  }
  for (const ref of ops.remove ?? []) {
    const id = resolve(ref);
    const n = g.nodes.get(id);
    const drop = new Set([id, n.text?.id, n.image?.id]);
    for (const e of g.edges) if (e.from === id || e.to === id) drop.add(e.arrow.id);
    scene.elements = scene.elements.filter((e) => !drop.has(e.id));
    report.push(`刪除「${n.name}」`);
    g = readGraph(scene);
  }

  // 2. 修改
  for (const u of ops.update ?? []) {
    const id = resolve(u.node);
    const n = g.nodes.get(id);
    const name = u.name ?? n.name;
    const desc = u.desc ?? n.desc;
    if (u.color) { n.el.backgroundColor = u.color; touch(n.el); }
    if (u.name !== undefined || u.desc !== undefined) {
      let text = n.text;
      if (!text) {
        text = baseElement('text', textProps(n.el.id));
        scene.elements.splice(scene.elements.indexOf(n.el) + 1, 0, text);
      }
      fitText(n.el, text, composeText(name, desc));
    }
    report.push(`修改「${n.name}」${u.name && u.name !== n.name ? ` → 「${u.name}」` : ''}`);
    g = readGraph(scene);
  }

  // 3. 新增節點
  const newIds = new Set();
  const preferredAnchor = new Map();
  const newArrows = [];

  // 2b. 整張畫布換字型（節點變高時，相連的箭頭重新拉線）
  if (ops.font) {
    const f = FONTS[ops.font];
    if (!f) throw new Error(`不認得的字型「${ops.font}」，可以用：${Object.keys(FONTS).join('、')}`);
    let count = 0;
    for (const n of g.nodes.values()) {
      if (!n.text || (n.text.fontFamily === f.id && n.text.lineHeight === f.lineHeight)) continue;
      n.text.fontFamily = f.id;
      n.text.lineHeight = f.lineHeight;
      fitText(n.el, n.text, n.text.originalText ?? n.text.text);
      for (const e of g.edges) if (e.from === n.id || e.to === n.id) newArrows.push(e.arrow.id);
      count++;
    }
    scene.appState = { ...(scene.appState ?? {}), currentItemFontFamily: f.id }; // 在畫布上新打的字也用這個字型
    report.push(`${count} 個節點換成 ${ops.font}`);
  }
  for (const a of ops.add ?? []) {
    const parentId = a.parent ? resolve(a.parent) : null;
    if (parentId && setCollapsed(g.nodes.get(parentId), false)) report.push(`展開「${g.nodes.get(parentId).name}」（要在底下新增節點）`);
    const depth = parentId ? depthOf(g, parentId) + 1 : 0;
    const node = baseElement('rectangle', {
      width: a.width ?? NODE_W, height: 60,
      backgroundColor: a.color ?? PALETTE[depth % PALETTE.length],
      roundness: { type: 3 }, boundElements: [],
    });
    const text = baseElement('text', textProps(node.id));
    fitText(node, text, composeText(a.name, a.desc ?? ''));
    scene.elements.push(node, text);
    if (a.key) keys.set(a.key, node.id);
    newIds.add(node.id);
    if (parentId) {
      const arrow = newArrow(g.nodes.get(parentId).el, node);
      scene.elements.push(arrow);
      newArrows.push(arrow.id);
      preferredAnchor.set(node.id, parentId);
    }
    report.push(`新增「${a.name}」${parentId ? `（接在「${g.nodes.get(parentId).name}」後面）` : ''}`);
    g = readGraph(scene);
  }

  // 3b. 搬移：節點連同底下整個分支（文字、圖片）改接到新的上層。依 move 的順序排在新上層的最後面
  for (const m of ops.move ?? []) {
    const id = resolve(m.node);
    const parentId = resolve(m.parent);
    const sub = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const x = queue.shift();
      for (const e of g.edges) if (e.from === x && !sub.has(e.to)) { sub.add(e.to); queue.push(e.to); }
    }
    if (sub.has(parentId)) throw new Error(`不能把「${g.nodes.get(id).name}」搬到它自己的分支底下`);
    const n = g.nodes.get(id);
    const drop = new Set(g.edges.filter((e) => e.to === id).map((e) => e.arrow.id));
    const own = new Set([n.el.id, n.text?.id, n.image?.id]);
    const moved = scene.elements.filter((e) => own.has(e.id));
    scene.elements = scene.elements.filter((e) => !drop.has(e.id) && !own.has(e.id));
    scene.elements.push(...moved); // 移到最後，排版時才會排在兄弟節點的後面
    const arrow = newArrow(g.nodes.get(parentId).el, n.el);
    scene.elements.push(arrow);
    newArrows.push(arrow.id);
    report.push(`搬移「${n.name}」→ 接在「${g.nodes.get(parentId).name}」後面`);
    g = readGraph(scene);
  }

  // 4. 新增連線
  for (const c of ops.connect ?? []) {
    const from = resolve(c.from);
    const to = resolve(c.to);
    const arrow = newArrow(g.nodes.get(from).el, g.nodes.get(to).el);
    scene.elements.push(arrow);
    newArrows.push(arrow.id);
    report.push(`連線「${g.nodes.get(from).name}」→「${g.nodes.get(to).name}」`);
    g = readGraph(scene);
  }

  // 5～6. 排版、文字跟著走、箭頭重新拉線
  report.push(...(await arrange(scene, g, { layout: ops.layout ?? 'new', direction, newIds, preferredAnchor, newArrows })));
  return { report, newIds, keys, g };
}

// ---------- 匯入 Xmind ----------

// 從 zip 取出一個檔案（.xmind 是 zip），不用額外套件
function unzipEntry(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('不是有效的 .xmind 檔（讀不到 zip 結構）');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// 圖片的像素大小（PNG、JPEG、GIF），讀不到回傳 null
function imageSize(b) {
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let p = 2; p + 9 < b.length; ) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(p + 7), h: b.readUInt16BE(p + 5) };
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  return null;
}

// 大圖縮小（macOS 用 sips、Windows 用 PowerShell），做不到就用原圖
function shrinkImage(buf, ext, size) {
  if (!size || Math.max(size.w, size.h) <= IMG_MAX_PX) return { buf, size };
  const k = IMG_MAX_PX / Math.max(size.w, size.h);
  const next = { w: Math.round(size.w * k), h: Math.round(size.h * k) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-img-'));
  const src = path.join(dir, `in.${ext}`);
  const out = path.join(dir, `out.${ext}`);
  try {
    fs.writeFileSync(src, buf);
    if (process.platform === 'darwin') execFileSync('sips', ['-z', String(next.h), String(next.w), src, '--out', out], { stdio: 'ignore' });
    else if (process.platform === 'win32') {
      const fmt = ext === 'png' ? 'Png' : ext === 'gif' ? 'Gif' : 'Jpeg';
      const ps = `Add-Type -AssemblyName System.Drawing; $i=[Drawing.Image]::FromFile('${src}'); $b=New-Object Drawing.Bitmap $i,${next.w},${next.h}; $b.Save('${out}',[Drawing.Imaging.ImageFormat]::${fmt}); $b.Dispose(); $i.Dispose()`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    } else return { buf, size };
    const small = fs.readFileSync(out);
    return small.length < buf.length ? { buf: small, size: next } : { buf, size };
  } catch {
    return { buf, size };
  } finally {
    for (const f of [src, out]) if (fs.existsSync(f)) fs.unlinkSync(f); // 不用 rmSync：Node 24 在 Windows 遇到中文路徑會崩潰
    fs.rmdirSync(dir);
  }
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

// Xmind 主題的圖片 → 畫布檔的 files 項目＋圖片元素（掛在節點下方，和節點同一個群組，拖節點時一起動）
function attachImage(scene, n, image, buf) {
  const name = image.src.replace(/^xap:/, '');
  let data = unzipEntry(buf, name);
  if (!data) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  let size = imageSize(data);
  ({ buf: data, size } = shrinkImage(data, ext, size));
  const fileId = crypto.createHash('sha1').update(data).digest('hex');
  scene.files[fileId] ??= { mimeType: MIME[ext] ?? 'image/png', id: fileId, dataURL: `data:${MIME[ext] ?? 'image/png'};base64,${data.toString('base64')}`, created: Date.now() };
  // 顯示大小：照 Xmind 設定的，沒有就用像素大小，最寬 IMG_MAX_W
  const ratio = size ? size.h / size.w : (image.height && image.width ? image.height / image.width : 0.75);
  const w = Math.min(IMG_MAX_W, image.width ?? size?.w ?? NODE_W);
  const group = newId();
  const el = baseElement('image', {
    width: Math.round(w), height: Math.round(w * ratio), fileId, status: 'saved', scale: [1, 1], crop: null,
    strokeColor: 'transparent', groupIds: [group], customData: { attachedTo: n.id },
  });
  n.el.groupIds = [group];
  if (n.text) n.text.groupIds = [group];
  scene.elements.push(el);
  return true;
}

// Xmind 主題 → 名稱＋說明。多行標題：第一行當名稱；很長的單行「名稱：內容」從冒號切開
function topicText(t) {
  const title = (t.title ?? '').replace(/\r/g, '').trim();
  let [name = '', ...rest] = title.split('\n');
  let desc = rest.join('\n').trim();
  const m = !desc && name.length > 30 && name.match(/^(.{1,12}?)[：:]\s*(.+)$/s);
  if (m) { name = m[1]; desc = m[2]; }
  const extra = [];
  if (t.labels?.length) extra.push(`標籤：${t.labels.join('、')}`);
  if (t.href) extra.push(t.href);
  const note = t.notes?.plain?.content?.replace(/\r/g, '').trim();
  if (note) extra.push(`備註：${note}`);
  desc = [desc, ...extra].filter(Boolean).join('\n');
  if (!name.trim()) name = t.image ? '（圖片）' : '（未命名）';
  return { name: name.trim(), desc };
}

async function cmdImport(xmindFile, file) {
  if (fs.existsSync(file)) throw new Error(`${file} 已存在，請換一個畫布檔名`);
  const buf = fs.readFileSync(xmindFile);
  const json = unzipEntry(buf, 'content.json');
  if (!json) throw new Error('這是舊版 Xmind 8 的格式，請先用新版 Xmind 打開再存檔一次');
  const sheets = JSON.parse(json.toString('utf8'));

  const ops = { add: [], layout: 'none' };
  const folded = [];
  const images = [];
  let n = 0;
  const walk = (t, parent) => {
    const key = `x${n++}`;
    const { name, desc } = topicText(t);
    if (t.image?.src) images.push({ key, image: t.image });
    ops.add.push({ key, name, desc, parent });
    if (t.branch === 'folded') folded.push(key);
    for (const c of t.children?.attached ?? []) walk(c, key);
    // 摘要（summary）當作被摘要那一層的子節點；浮動主題（detached）當作另外的根
    for (const s of t.children?.summary ?? []) walk(s, key);
    for (const d of t.children?.detached ?? []) if (!d.titleUnedited || d.children) walk(d, null); // 沒改過字的空白浮動主題不要
  };
  for (const s of sheets) walk(s.rootTopic, null);

  const scene = blankScene();
  const { keys } = await applyOps(scene, ops);
  let g = readGraph(scene);
  for (const k of folded) setCollapsed(g.nodes.get(keys.get(k)), true);
  let lost = 0;
  for (const im of images) if (!attachImage(scene, g.nodes.get(keys.get(im.key)), im.image, buf)) lost++;
  g = readGraph(scene);
  await arrange(scene, g, { layout: 'all', direction: 'RIGHT' });

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(scene, null, 2));
  fs.renameSync(tmp, file);
  const rel = sheets.reduce((s, sh) => s + (sh.relationships?.length ?? 0), 0);
  console.log(`已匯入 ${sheets.length} 張工作表、${ops.add.length} 個節點 → ${file}`);
  if (folded.length) console.log(`照 Xmind 收合了 ${folded.length} 個分支`);
  if (images.length) console.log(`匯入 ${images.length - lost} 張圖片（放在節點下方）`);
  if (lost) console.log(`⚠ ${lost} 張圖片在 .xmind 裡找不到，沒有匯入`);
  if (rel) console.log(`⚠ ${rel} 條關係線（relationship）沒有匯入`);
}

// 排版：收合而隱藏的節點不參加，跟著負責它的收合節點一起移動
export async function arrange(scene, g, { layout, direction, newIds = new Set(), preferredAnchor = new Map(), newArrows = [] }) {
  const report = [];
  const { hidden } = foldInfo(g);
  const vg = visibleGraph(g, hidden);
  const before = new Map([...new Set(hidden.values())].map((o) => [o, { x: g.nodes.get(o).el.x, y: g.nodes.get(o).el.y }]));
  let moved = new Set();
  if (layout !== 'none' && vg.nodes.size) {
    const elkPos = await elkLayout(vg, direction);
    if (layout === 'all') {
      const r = placeAll(vg, elkPos);
      moved = r.moved;
      report.push(`全部重排：移動 ${moved.size} 個節點${hidden.size ? `（${hidden.size} 個收合中的節點跟著移動）` : ''}`);
      report.push(...r.warn.map((w) => `⚠ ${w}`));
    } else {
      const visibleNew = new Set([...newIds].filter((id) => !hidden.has(id)));
      if (visibleNew.size) moved = placeNew(vg, elkPos, visibleNew, direction, preferredAnchor);
    }
  }
  for (const [id, owner] of hidden) {
    const b = before.get(owner);
    const o = g.nodes.get(owner).el;
    const el = g.nodes.get(id).el;
    if (o.x !== b.x || o.y !== b.y) { el.x += o.x - b.x; el.y += o.y - b.y; moved.add(id); }
  }
  for (const id of moved) {
    const n = g.nodes.get(id);
    if (n.text) placeText(n.el, n.text);
    touch(n.el);
  }
  const reroute = new Set(newArrows);
  for (const e of g.edges) if (moved.has(e.from) || moved.has(e.to)) reroute.add(e.arrow.id);
  for (const e of g.edges) if (reroute.has(e.arrow.id)) routeArrow(e.arrow, g.nodes.get(e.from).el, g.nodes.get(e.to).el);
  for (const n of g.nodes.values()) {
    if (!n.image) continue;
    const x = n.el.x, y = n.el.y + n.el.height + IMG_GAP;
    if (n.image.x !== x || n.image.y !== y) { n.image.x = x; n.image.y = y; touch(n.image); }
  }
  syncBindings(scene);
  return report;
}

function textProps(containerId) {
  return {
    text: '', originalText: '', fontSize: FONT_SIZE, fontFamily: FONT_FAMILY,
    textAlign: 'left', verticalAlign: 'middle', containerId, autoResize: true, lineHeight: LINE_HEIGHT,
  };
}

function depthOf(g, id) {
  const parents = new Map();
  for (const e of g.edges) if (!parents.has(e.to)) parents.set(e.to, e.from);
  let d = 0;
  const seen = new Set();
  while (parents.has(id) && !seen.has(id)) { seen.add(id); id = parents.get(id); d++; }
  return d;
}

// ---------- 存檔、備份、覆蓋偵測 ----------

function writeScene(file, scene, mtime) {
  if (fs.statSync(file).mtimeMs !== mtime) throw new Error('檔案在處理途中被修改了（可能你剛好在編輯），請再跑一次');
  scene.type ??= 'excalidraw';
  scene.version ??= 2;
  scene.source ??= 'https://excalidraw.com';
  scene.appState ??= { viewBackgroundColor: '#ffffff' };
  scene.files ??= {};
  fs.mkdirSync(historyDir(file), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(historyDir(file), `${path.basename(file, '.excalidraw')}.${stamp}.excalidraw`));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(scene, null, 2));
  fs.renameSync(tmp, file);
}

const markerOf = (file) => path.join(historyDir(file), `${path.basename(file, '.excalidraw')}.last-added.json`);

function saveHistory(file, ops, added) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(historyDir(file), `${path.basename(file, '.excalidraw')}.${stamp}.ops.json`), JSON.stringify(ops, null, 2));
  if (added.length) fs.writeFileSync(markerOf(file), JSON.stringify(added));
}

// 上次新增的節點如果不見了，可能是被舊的編輯器分頁存檔蓋掉
function checkLastAdded(file, scene) {
  const marker = markerOf(file);
  if (!fs.existsSync(marker)) return;
  const added = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.unlinkSync(marker); // 不用 rmSync：Node 24 在 Windows 遇到中文路徑會崩潰
  const ids = new Set(scene.elements.filter((e) => !e.isDeleted).map((e) => e.id));
  const missing = added.filter((a) => !ids.has(a.id));
  if (missing.length) {
    console.log(`⚠ 上次 Claude 新增的節點不在檔案裡了：${missing.map((m) => `「${m.name}」`).join('、')}`);
    console.log('  若不是刻意刪除，可能是被舊的編輯器分頁存檔覆蓋，備份在畫布旁邊的 .canvas-history/\n');
  }
}

export const blankScene = () => ({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, files: {} });

function cmdNew(file) {
  if (fs.existsSync(file)) throw new Error(`${file} 已存在`);
  fs.writeFileSync(file, JSON.stringify(blankScene(), null, 2));
  console.log(`已建立 ${file}`);
}

// ---------- main ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [cmd, file, arg] = isMain ? process.argv.slice(2) : [];
if (isMain) try {
  if (cmd === 'read' && file) cmdRead(file, { pos: process.argv.includes('--pos') });
  else if (cmd === 'apply' && file && arg) await cmdApply(file, arg);
  else if (cmd === 'new' && file) cmdNew(file);
  else if (cmd === 'import' && file && arg) await cmdImport(file, arg);
  else {
    console.log('用法：node canvas.mjs read <檔案> [--pos] | apply <檔案> <ops.json> | new <檔案> | import <檔案.xmind> <新畫布.excalidraw>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`錯誤：${err.message}`);
  process.exitCode = 1;
}
