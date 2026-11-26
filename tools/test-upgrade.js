#!/usr/bin/env node
/* Simulate a pre-merge player (all 80 boards cleared) refreshing onto this build.
   Run from repo root: node tools/test-upgrade.js
   Needs google-chrome and a free port. */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purrjong-upgrade-'));
const oldDir = path.join(tmp, 'old');
const newDir = path.join(tmp, 'new');
const profile = path.join(tmp, 'chrome-profile');
const shots = path.join(tmp, 'shots');
fs.mkdirSync(shots); fs.mkdirSync(profile); fs.mkdirSync(oldDir); fs.mkdirSync(newDir);

execSync('git -C ' + JSON.stringify(root) + ' archive 8ba2f46 | tar -x -C ' + JSON.stringify(oldDir), { stdio: 'inherit' });
execSync('git -C ' + JSON.stringify(root) + ' archive HEAD | tar -x -C ' + JSON.stringify(newDir), { stdio: 'inherit' });
for (const f of ['src/app.js', 'src/progress.js', 'index.html']) {
  fs.copyFileSync(path.join(root, f), path.join(newDir, f));
}
fs.copyFileSync(path.join(root, 'tools/upgrade-runner.html'), path.join(tmp, 'upgrade-runner.html'));

const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.m4a': 'audio/mp4', '.webmanifest': 'application/manifest+json' };
function resolve(rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/\/+$/, '') || '/index.html';
  let file = path.join(rootDir, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return file;
}
const server = http.createServer((req, res) => {
  const u = req.url || '/';
  if (/\.(m4a|mp3|ogg|wav)(\?|$)/i.test(u)) {
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': 0, 'cache-control': 'no-store' });
    return res.end();
  }
  let file;
  if (u.startsWith('/old/')) file = resolve(oldDir, u.slice(5));
  else if (u.startsWith('/new/')) file = resolve(newDir, u.slice(5));
  else file = resolve(tmp, u);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found ' + u); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function listen() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('GET ' + url + ' ' + res.status);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  eval(expr) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => {
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
        return r.result && r.result.value;
      });
  }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

(async () => {
  const origin = await listen();
  console.log('serving', origin, 'from', tmp);
  const debugPort = 9224;
  const chrome = spawn('google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio',
    '--user-data-dir=' + profile, '--window-size=430,900',
    '--remote-debugging-port=' + debugPort,
    '--remote-debugging-address=127.0.0.1',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });
  try {
    let version;
    for (let i = 0; i < 40; i++) {
      try { version = await fetchJson('http://127.0.0.1:' + debugPort + '/json/version'); break; }
      catch (e) { await wait(100); }
    }
    if (!version) throw new Error('chrome debug port never came up\n' + stderr.slice(-2000));
    let page;
    for (let i = 0; i < 20; i++) {
      const list = await fetchJson('http://127.0.0.1:' + debugPort + '/json/list');
      page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) break;
      await wait(100);
    }
    if (!page) throw new Error('no page target');
    const ws = await openWs(page.webSocketDebuggerUrl);
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: origin + '/upgrade-runner.html' });
    const deadline = Date.now() + 25000;
    let title = '';
    while (Date.now() < deadline) {
      title = await cdp.eval('document.title') || '';
      if (/^(ALL_OK|FAIL|ERROR)/.test(title)) break;
      await wait(200);
    }
    const report = await cdp.eval('(() => { const el = document.getElementById("results"); try { return JSON.parse(el.textContent); } catch (e) { return { error: "parse: " + e.message, raw: el && el.textContent }; } })()');
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (png && png.data) fs.writeFileSync(path.join(shots, 'runner.png'), Buffer.from(png.data, 'base64'));
    console.log('title', title);
    ws.close();
    chrome.kill('SIGTERM');
    if (!report || report.error) {
      console.error(report);
      process.exitCode = 1;
    } else {
      for (const t of report.tests) {
        if (t.ok) console.log('ok  ', t.name);
        else { console.error('FAIL', t.name, t.detail == null ? '' : JSON.stringify(t.detail)); process.exitCode = 1; }
      }
      console.log(report.failed ? '\n' + report.failed + ' failed' : '\nall ' + report.tests.length + ' upgrade tests ok');
      if (report.failed) process.exitCode = 1;
    }
    console.log('shots at', shots);
  } catch (e) {
    console.error(e);
    console.error(stderr.slice(-2000));
    process.exitCode = 1;
  } finally {
    try { chrome.kill('SIGTERM'); } catch (e) { /* already gone */ }
    server.close();
  }
})();
