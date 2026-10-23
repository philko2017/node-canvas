#!/usr/bin/env node
// 即時畫布伺服器：瀏覽器裡的 Excalidraw 和 .excalidraw 檔雙向同步
//
//   node server.mjs <檔案.excalidraw> [port] [--open]
//
// 檔案不存在時會建立一張空白畫布。port 預設 5180。
// --open：啟動後用預設瀏覽器打開畫布。埠已被占用（畫布已經開著）時不重複啟動，直接打開瀏覽器。
//
// - 你在畫布上的修改會在停手約 0.6 秒後自動存回檔案
// - Claude 用 canvas.mjs 改檔後，畫布會自動載入（可以 Ctrl+Z 復原 Claude 的修改）
// - 兩邊同時改到時以檔案為準，畫布會提示你重做最後幾秒的修改
// - 收合／展開分支（POST /fold）在這裡改檔並重排，畫布再載入結果

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { foldScene, blankScene } from './canvas.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const openBrowser = process.argv.includes('--open');
if (!args[0]) {
  console.log('用法：node server.mjs <檔案.excalidraw> [port] [--open]');
  console.log('（Windows 也可以把畫布檔拖到「開啟畫布.cmd」上）');
  process.exit(1);
}
const file = path.resolve(args[0]);
const port = Number(args[1] ?? process.env.PORT ?? 5180);
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify(blankScene(), null, 2));
  console.log(`建立新畫布：${file}`);
}
const url = `http://localhost:${port}`;

const openCmd = { win32: ['cmd', ['/c', 'start', '', url]], darwin: ['open', [url]] }[process.platform] ?? ['xdg-open', [url]];
const openUrl = () => spawn(openCmd[0], openCmd[1], { detached: true, stdio: 'ignore' }).unref();

let content = fs.readFileSync(file, 'utf8');
let version = 1;
const clients = new Set();

const broadcast = () => {
  for (const res of clients) res.write(`data: ${JSON.stringify({ version })}\n\n`);
};

function writeAtomic(body) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

// 檔案被別人（Claude）改了就通知畫布
fs.watchFile(file, { interval: 300 }, () => {
  let next;
  try {
    next = fs.readFileSync(file, 'utf8');
    JSON.parse(next);
  } catch {
    return; // 寫到一半或暫時讀不到，等下一輪
  }
  if (next === content) return;
  content = next;
  version++;
  console.log(`[檔案更新] v${version}`);
  broadcast();
});

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(here, 'editor.html')));
    }
    if (req.method === 'GET' && url.pathname === '/scene') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ version, name: path.basename(file), scene: JSON.parse(content) }));
    }
    if (req.method === 'PUT' && url.pathname === '/scene') {
      const body = await readBody(req);
      if (Number(url.searchParams.get('base')) !== version) {
        return send(res, 409, 'application/json', JSON.stringify({ version }));
      }
      JSON.parse(body);
      content = body;
      version++;
      writeAtomic(body);
      broadcast();
      return send(res, 200, 'application/json', JSON.stringify({ version }));
    }
    if (req.method === 'POST' && url.pathname === '/fold') {
      const body = JSON.parse(await readBody(req));
      if (Number(body.base) !== version) return send(res, 409, 'application/json', JSON.stringify({ version }));
      const scene = JSON.parse(content);
      const r = await foldScene(scene, body, { layout: body.layout !== false });
      content = JSON.stringify(scene, null, 2);
      version++;
      writeAtomic(content);
      broadcast();
      return send(res, 200, 'application/json', JSON.stringify({ version, ...r }));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ version })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (err) {
    send(res, 500, 'text/plain; charset=utf-8', String(err));
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`${port} 埠已被占用，通常是畫布已經開著：${url}`);
  if (openBrowser) openUrl();
  process.exit(0);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`節點畫布：${url}　檔案：${file}`);
  console.log('這個視窗開著時畫布才能用，關掉就停止。');
  if (openBrowser) openUrl();
});
