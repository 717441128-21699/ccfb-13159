// 端到端验证:Edge headless + WebGL2,生成全部样例并批处理,检查指标
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn('node', [join(root, 'server.mjs'), '8123'], { cwd: root, stdio: 'pipe' });
await new Promise(r => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:8123/', { waitUntil: 'networkidle0' });
console.log('webgl2:', await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2')));

await page.click('#btnGenAll');
await page.waitForFunction(
  () => document.getElementById('globalStatus').textContent.includes('完成'),
  { timeout: 120000 },
);

for (let i = 0; i < 5; i++) {
  await page.evaluate(idx => { document.querySelectorAll('#pairList li')[idx].click(); }, i);
  await new Promise(r => setTimeout(r, 400));
  const m = await page.evaluate(() => ({
    time: document.getElementById('mTime').textContent,
    detail: document.getElementById('mDetail').textContent,
    bg: document.getElementById('mBg').textContent,
    hots: document.querySelectorAll('#hotTable tbody tr').length,
    name: document.querySelector('#pairList li.active').textContent.split('配准')[0].trim(),
    affine: ['rgDx', 'rgDy', 'rgScale', 'rgRot', 'rgK1'].map(id => document.getElementById(id).value).join(' '),
  }));
  console.log(JSON.stringify(m));
  await page.screenshot({ path: join(root, 'e2e', `shot-${i}.png`) });
  await page.evaluate(() => document.querySelector('#viewTabs button[data-view="3"]').click());
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: join(root, 'e2e', `edge-${i}.png`) });
  await page.evaluate(() => document.querySelector('#viewTabs button[data-view="0"]').click());
}

// 温度读取测试:点击画布中心
await page.evaluate(() => {
  const wrap = document.getElementById('canvasWrap');
  const r = wrap.getBoundingClientRect();
  wrap.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
});
await new Promise(r => setTimeout(r, 200));
console.log('readout:', await page.evaluate(() => document.getElementById('readout').textContent));

// 配准精度:估计映射 vs 样例真值映射(红外像素 -> 可见光像素)
const acc = await page.evaluate(() => {
  const { pairs, irPxToVisPx } = window.__app;
  const out = [];
  for (const st of pairs.values()) {
    const p = st.pair;
    if (!p.truth) continue;
    const { cam, depth } = p.truth;
    const W = p.visW, H = p.visH;
    const th = cam.rotDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    const gen = (u, v) => {
      let cx = (u + 0.5 - p.irW / 2) / p.irH, cy = (v + 0.5 - p.irH / 2) / p.irH;
      const f = 1 + cam.k1 * (cx * cx + cy * cy);
      cx *= f; cy *= f;
      let wx = cam.scale * (cs * cx - sn * cy) + cam.txPx / H;
      let wy = cam.scale * (sn * cx + cs * cy) + cam.tyPx / H;
      const px = Math.min(Math.max(Math.round(wx * H + W / 2), 0), W - 1);
      const py = Math.min(Math.max(Math.round(wy * H + H / 2), 0), H - 1);
      const par = cam.parK * (1 / depth[py * W + px] - 1);
      wx += par; wy += par * 0.3;
      return [wx * H + W / 2, wy * H + H / 2];
    };
    let se = 0, n = 0, mx = 0, seD = 0, nD = 0, seT = 0, seF = 0;
    const regTruth = {
      affine: { scale: cam.scale, rot: cam.rotDeg * Math.PI / 180, tx: cam.txPx / H, ty: cam.tyPx / H },
      k1: cam.k1, gridW: 24, gridH: 18, field: new Float32Array(24 * 18 * 2), score: 0,
    };
    const sizes = { visW: W, visH: H, irW: p.irW, irH: p.irH };
    for (let v = 6; v < p.irH; v += 12) {
      for (let u = 6; u < p.irW; u += 12) {
        const [tx, ty] = gen(u, v);
        const [ex, ey] = irPxToVisPx(u + 0.5, v + 0.5, st.reg, sizes, 1);
        const e = Math.hypot(tx - ex, ty - ey);
        se += e * e; n++; if (e > mx) mx = e;
        const onDev = p.devices.some(d => tx >= d.x && tx <= d.x + d.w && ty >= d.y && ty <= d.y + d.h);
        if (onDev) { seD += e * e; nD++; }
        const [fx, fy] = irPxToVisPx(u + 0.5, v + 0.5, regTruth, sizes, 0);
        seT += (tx - fx) ** 2 + (ty - fy) ** 2;
        const [gx2, gy2] = irPxToVisPx(u + 0.5, v + 0.5, st.reg, sizes, 0);
        seF += (tx - gx2) ** 2 + (ty - gy2) ** 2;
      }
    }
    out.push({
      name: p.name, rmsPx: +(Math.sqrt(se / n)).toFixed(2), maxPx: +mx.toFixed(2),
      devRmsPx: +(Math.sqrt(seD / Math.max(nD, 1))).toFixed(2),
      rmsTruthAffine: +(Math.sqrt(seT / n)).toFixed(2),
      rmsFoundNoField: +(Math.sqrt(seF / n)).toFixed(2),
    });
  }
  return out;
});
console.log('mapping accuracy:', JSON.stringify(acc));

// 评分检验:真值参数 vs 搜索到的参数(总分/MI/NCC 三分量)
const scoreTest = await page.evaluate(() => {
  const { pairs, engine } = window.__app;
  const out = [];
  for (const st of pairs.values()) {
    const p = st.pair;
    if (!p.truth) continue;
    engine.loadPair(p);
    const c = p.truth.cam, H = p.visH;
    const t = engine.scoreSlice(0, [c.txPx / H, c.tyPx / H], c.scale, c.rotDeg * Math.PI / 180, c.k1, [0, 0], 1, 1, 0);
    const a = st.reg.affine;
    const f = engine.scoreSlice(0, [a.tx, a.ty], a.scale, a.rot, st.reg.k1, [0, 0], 1, 1, 0);
    out.push({
      name: p.name.slice(0, 6),
      true: [t[0], t[1], t[2]].map(v => +v.toFixed(3)),
      found: [f[0], f[1], f[2]].map(v => +v.toFixed(3)),
    });
  }
  return out;
});
console.log('score [total,MI,NCC] truth vs found:', JSON.stringify(scoreTest));

// 评分地形可视化:真值 scale/rot 下 (tx,ty) 地貌(ASCII),* 为真值位置,# 为最大值
const landscape = await page.evaluate(() => {
  const { pairs, engine } = window.__app;
  const st = [...pairs.values()][0];
  const p = st.pair;
  engine.loadPair(p);
  const c = p.truth.cam, H = p.visH;
  const n = 48, step = 2 / H;
  const data = engine.scoreSlice(0, [c.txPx / H, c.tyPx / H], c.scale, c.rotDeg * Math.PI / 180, c.k1, [step, step], n, n, 0);
  let mn = Infinity, mx = -Infinity, ai = 0;
  for (let i = 0; i < n * n; i++) { const v = data[i * 4]; if (v < mn) mn = v; if (v > mx) { mx = v; ai = i; } }
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      if (i === ai) { line += '#'; continue; }
      if (x === n / 2 && y === n / 2) { line += '*'; continue; }
      const v = (data[i * 4] - mn) / (mx - mn);
      line += v > 0.8 ? '+' : v > 0.6 ? ':' : v > 0.4 ? '.' : ' ';
    }
    lines.push(line);
  }
  return { lines, argmaxOffsetPx: [(ai % n - n / 2) * 2, (Math.floor(ai / n) - n / 2) * 2], center: data[(n / 2 * n + n / 2) * 4], max: mx };
});
console.log('landscape scene1 (truth at *, max at #), argmax offset px:', landscape.argmaxOffsetPx, 'center:', landscape.center.toFixed(3), 'max:', landscape.max.toFixed(3));
console.log(landscape.lines.join('\n'));

// (scale, rot) 地貌:真值 t 下,横轴 scale ±0.1,纵轴 rot ±3°
const ls2 = await page.evaluate(() => {
  const { pairs, engine } = window.__app;
  const st = [...pairs.values()][0];
  const p = st.pair;
  engine.loadPair(p);
  const c = p.truth.cam, H = p.visH;
  const n = 41;
  const data = engine.scoreSlice(1, [c.txPx / H, c.tyPx / H], c.scale, c.rotDeg * Math.PI / 180, c.k1, [0.005, 0.15 * Math.PI / 180], n, n, 0);
  let mn = Infinity, mx = -Infinity, ai = 0;
  for (let i = 0; i < n * n; i++) { const v = data[i * 4]; if (v < mn) mn = v; if (v > mx) { mx = v; ai = i; } }
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (i === ai) { line += '#'; continue; }
      if (x === (n - 1) / 2 && y === (n - 1) / 2) { line += '*'; continue; }
      const v = (data[i * 4] - mn) / (mx - mn);
      line += v > 0.8 ? '+' : v > 0.6 ? ':' : v > 0.4 ? '.' : ' ';
    }
    lines.push(line);
  }
  return { lines, argmax: [((ai % n) - 20) * 0.005, (Math.floor(ai / n) - 20) * 0.15], center: data[(20 * n + 20) * 4], max: mx };
});
console.log('scale/rot landscape (truth *, max #), argmax [dScale, dRotDeg]:', ls2.argmax, 'center:', ls2.center.toFixed(3), 'max:', ls2.max.toFixed(3));
console.log(ls2.lines.join('\n'));

// 阶段1 实际看到的地貌:lod 3,真值 scale/rot 切片,(tx,ty) ±60px
const ls3 = await page.evaluate(() => {
  const { pairs, engine } = window.__app;
  const st = [...pairs.values()][3]; // 母线线夹
  const p = st.pair;
  engine.loadPair(p);
  const c = p.truth.cam, H = p.visH;
  const n = 48, step = 2 / H;
  const data = engine.scoreSlice(0, [c.txPx / H, c.tyPx / H], c.scale, c.rotDeg * Math.PI / 180, c.k1, [step, step], n, n, 0);
  let mn = Infinity, mx = -Infinity, ai = 0;
  for (let i = 0; i < n * n; i++) { const v = data[i * 4]; if (v < mn) mn = v; if (v > mx) { mx = v; ai = i; } }
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (i === ai) { line += '#'; continue; }
      if (x === n / 2 && y === n / 2) { line += '*'; continue; }
      const v = (data[i * 4] - mn) / (mx - mn);
      line += v > 0.8 ? '+' : v > 0.6 ? ':' : v > 0.4 ? '.' : ' ';
    }
    lines.push(line);
  }
  return { lines, argmaxPx: [(ai % n - n / 2) * 2, (Math.floor(ai / n) - n / 2) * 2], center: data[(n / 2 * n + n / 2) * 4], max: mx };
});
console.log('scene4 (tx,ty) landscape at truth s/rot (truth *, max #):', ls3.argmaxPx, 'center:', ls3.center.toFixed(3), 'max:', ls3.max.toFixed(3));
console.log(ls3.lines.join('\n'));

// 终裁:真值参数渲染融合图,热点辉光应正好落在触头上
await page.evaluate(() => {
  const { pairs, engine, params } = window.__app;
  const st = [...pairs.values()][0];
  const p = st.pair;
  const c = p.truth.cam, H = p.visH;
  st.reg.affine = { scale: c.scale, rot: c.rotDeg * Math.PI / 180, tx: c.txPx / H, ty: c.tyPx / H };
  st.reg.k1 = c.k1;
  st.reg.field = new Float32Array(24 * 18 * 2);
  engine.loadPair(p);
  engine.uploadField(st.reg.field);
  engine.render(st.reg, { ...params, view: 0, fieldScale: 1 });
});
await page.screenshot({ path: join(root, 'e2e', 'truth-fused.png') });

await browser.close();
server.kill();
console.log('E2E DONE');
