// 主程序:批次导入 / 配准调整 / 融合显示 / 发热点清单
import { ImagePair, Registration, Hotspot, FusionParams, Metrics } from './types.js';
import { Engine, GRID_W, GRID_H } from './gl/engine.js';
import { autoRegister, defaultRegistration, tempAtVis, irPxToVisPx, visPxToIrPx } from './registration.js';
import { detectHotspots } from './hotspots.js';
import { computeMetrics } from './metrics.js';
import { generateSample, SCENE_LIST } from './samples.js';

interface PairState {
  pair: ImagePair;
  reg: Registration;
  hotspots: Hotspot[];
  metrics: Metrics | null;
  processed: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const glCanvas = $('glCanvas') as HTMLCanvasElement;
const overlay = $('overlayCanvas') as HTMLCanvasElement;
const octx = overlay.getContext('2d')!;
const engine = new Engine(glCanvas);

const params: FusionParams = { t0: 35, t1: 75, maxAlpha: 0.85, palette: 'iron', fieldScale: 1, view: 0 };
const pairs = new Map<string, PairState>();
let current: PairState | null = null;
let selectedHot: number | null = null;

function setStatus(s: string): void { $('globalStatus').textContent = s; }

// ---------- 图像对管理 ----------

function addPair(pair: ImagePair): void {
  const st: PairState = {
    pair, reg: defaultRegistration(pair), hotspots: [], metrics: null, processed: false,
  };
  pairs.set(pair.id, st);
  const li = document.createElement('li');
  li.id = `pair-${pair.id}`;
  li.innerHTML = `<div>${pair.name}</div><div class="meta">待处理</div>`;
  li.onclick = () => selectPair(pair.id);
  $('pairList').appendChild(li);
  if (!current) selectPair(pair.id);
}

function updatePairItem(st: PairState): void {
  const li = $(`pair-${st.pair.id}`);
  if (!li) return;
  const m = st.metrics;
  const hot = st.hotspots.length;
  li.querySelector('.meta')!.innerHTML = m
    ? `配准+融合 ${Math.round(m.regMs + m.fuseMs)} ms · <span class="hot">${hot} 个发热点</span>`
    : '待处理';
}

function selectPair(id: string): void {
  const st = pairs.get(id);
  if (!st) return;
  current = st;
  selectedHot = null;
  document.querySelectorAll('#pairList li').forEach(el => el.classList.remove('active'));
  $(`pair-${id}`)?.classList.add('active');
  engine.loadPair(st.pair);
  overlay.width = st.pair.visW; overlay.height = st.pair.visH;
  syncRegSliders();
  render();
  renderHotTable();
  renderMetrics();
}

// ---------- 处理流水线 ----------

function processPair(st: PairState): void {
  const { pair, reg } = st;
  engine.loadPair(pair);
  const t0 = performance.now();
  autoRegister(engine, pair, reg);
  const t1 = performance.now();
  engine.render(reg, params);
  const fused = engine.readCanvas();
  const t2 = performance.now();
  st.hotspots = detectHotspots(pair, reg, params.fieldScale);
  st.metrics = computeMetrics(pair, reg, fused, params.t0, params.t1, params.fieldScale, t1 - t0, t2 - t1);
  st.processed = true;
  updatePairItem(st);
}

async function processAll(): Promise<void> {
  setStatus('批处理中…');
  for (const st of pairs.values()) {
    processPair(st);
    await new Promise(r => setTimeout(r, 0));
  }
  if (current) { selectPair(current.pair.id); }
  setStatus('批处理完成');
}

// ---------- 渲染 ----------

function render(): void {
  if (!current) return;
  const { pair, reg } = current;
  engine.render(reg, params);
  drawOverlay();
}

function drawOverlay(): void {
  const st = current;
  if (!st) return;
  const { pair, reg } = st;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (($('chkDevices') as HTMLInputElement).checked) {
    octx.strokeStyle = 'rgba(240,200,80,0.85)';
    octx.fillStyle = 'rgba(240,200,80,0.95)';
    octx.lineWidth = 1;
    octx.font = '11px sans-serif';
    for (const d of pair.devices) {
      octx.strokeRect(d.x, d.y, d.w, d.h);
      octx.fillText(`${d.device}/${d.part}`, d.x + 2, d.y - 3);
    }
  }

  // 发热点框
  octx.font = 'bold 12px sans-serif';
  for (const h of st.hotspots) {
    const sel = h.id === selectedHot;
    octx.strokeStyle = h.level === 3 ? '#ff4d4f' : h.level === 2 ? '#ffa940' : '#ffe58f';
    octx.lineWidth = sel ? 3.5 : 2;
    const [x, y, w, hh] = h.boxVis;
    const pad = 4;
    octx.strokeRect(x - pad, y - pad, w + pad * 2, hh + pad * 2);
    const label = `#${h.id} ${h.device}${h.part ? '/' + h.part : ''} ${h.maxTemp.toFixed(1)}°C`;
    const tw = octx.measureText(label).width;
    octx.fillStyle = 'rgba(10,14,18,0.8)';
    octx.fillRect(x - pad, y - pad - 18, tw + 8, 16);
    octx.fillStyle = '#fff';
    octx.fillText(label, x - pad + 4, y - pad - 6);
  }

  // 视差场矢量
  if (($('chkField') as HTMLInputElement).checked && st.processed) {
    octx.strokeStyle = 'rgba(80,220,255,0.9)';
    octx.fillStyle = 'rgba(80,220,255,0.9)';
    octx.lineWidth = 1;
    const H = pair.visH;
    for (let gy = 0; gy < reg.gridH; gy++) {
      for (let gx = 0; gx < reg.gridW; gx++) {
        const u = (gx + 0.5) / reg.gridW, v = (gy + 0.5) / reg.gridH;
        const dx = reg.field[(gy * reg.gridW + gx) * 2] * H * params.fieldScale;
        const dy = reg.field[(gy * reg.gridW + gx) * 2 + 1] * H * params.fieldScale;
        const x = u * pair.visW, y = v * pair.visH;
        octx.beginPath();
        octx.moveTo(x, y);
        octx.lineTo(x + dx * 4, y + dy * 4);
        octx.stroke();
        octx.beginPath();
        octx.arc(x + dx * 4, y + dy * 4, 1.6, 0, Math.PI * 2);
        octx.fill();
      }
    }
  }
}

function renderMetrics(): void {
  const m = current?.metrics;
  const fmt = (v: number, ok: boolean) => `<span class="${ok ? 'ok' : 'bad'}">${(v * 100).toFixed(1)}%</span>`;
  if (!m) {
    $('mTime').textContent = '耗时 —';
    $('mDetail').textContent = '细节保持 —';
    $('mBg').textContent = '背景对比度 —';
    $('mScore').textContent = '配准得分 —';
    return;
  }
  const total = m.regMs + m.fuseMs;
  $('mTime').innerHTML = `配准 ${m.regMs.toFixed(0)}ms + 融合 ${m.fuseMs.toFixed(0)}ms = <span class="${total < 500 ? 'ok' : 'bad'}">${total.toFixed(0)}ms</span>(限 500ms)`;
  $('mDetail').innerHTML = `细节保持 ${fmt(m.detailRetention, m.detailRetention >= 0.9)}(≥90%)`;
  $('mBg').innerHTML = `背景对比度 ${fmt(m.bgContrast, m.bgContrast >= 0.8)}(损失≤20%)`;
  $('mScore').textContent = `配准得分 ${current!.reg.score.toFixed(3)}`;
}

function renderHotTable(): void {
  const tbody = $('hotTable').querySelector('tbody')!;
  tbody.innerHTML = '';
  if (!current) return;
  for (const h of current.hotspots) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${h.id}</td><td>${h.device}${h.part ? '/' + h.part : ''}</td>` +
      `<td>${h.maxTemp.toFixed(1)}°C</td><td>+${h.deltaT.toFixed(1)}K</td>` +
      `<td><span class="lv lv${h.level}">${['', '一般', '严重', '危急'][h.level]}</span></td>`;
    tr.onclick = () => { selectedHot = h.id; drawOverlay(); };
    tbody.appendChild(tr);
  }
  if (!current.hotspots.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">未发现越限发热点</td></tr>';
  }
}

// ---------- 配准滑块 ----------

function syncRegSliders(): void {
  if (!current) return;
  const a = current.reg.affine, H = current.pair.visH;
  const set = (id: string, v: number) => { ($(id) as HTMLInputElement).value = String(v); $(id + 'V').textContent = ''; };
  set('rgDx', +(a.tx * H).toFixed(1));
  set('rgDy', +(a.ty * H).toFixed(1));
  set('rgScale', +a.scale.toFixed(3));
  set('rgRot', +(a.rot * 180 / Math.PI).toFixed(2));
  set('rgK1', +current.reg.k1.toFixed(3));
  updateSliderLabels();
}

function updateSliderLabels(): void {
  const g = (id: string) => ($(id) as HTMLInputElement).value;
  $('rgDxV').textContent = `${g('rgDx')}px`;
  $('rgDyV').textContent = `${g('rgDy')}px`;
  $('rgScaleV').textContent = g('rgScale');
  $('rgRotV').textContent = `${g('rgRot')}°`;
  $('rgK1V').textContent = g('rgK1');
  $('rgFieldV').textContent = g('rgField');
  $('rgT0V').textContent = `${g('rgT0')}°C`;
  $('rgT1V').textContent = `${g('rgT1')}°C`;
  $('rgAlphaV').textContent = g('rgAlpha');
}

function bindRegSliders(): void {
  const H = () => current!.pair.visH;
  const on = (id: string, f: (v: number) => void) => {
    $(id).addEventListener('input', () => {
      if (!current) return;
      f(Number(($(id) as HTMLInputElement).value));
      updateSliderLabels();
      render();
    });
  };
  on('rgDx', v => current!.reg.affine.tx = v / H());
  on('rgDy', v => current!.reg.affine.ty = v / H());
  on('rgScale', v => current!.reg.affine.scale = v);
  on('rgRot', v => current!.reg.affine.rot = v * Math.PI / 180);
  on('rgK1', v => current!.reg.k1 = v);
  on('rgField', v => params.fieldScale = v);
  on('rgT0', v => params.t0 = v);
  on('rgT1', v => params.t1 = v);
  on('rgAlpha', v => params.maxAlpha = v);
  $('chkField').addEventListener('change', render);
  $('chkDevices').addEventListener('change', render);
  $('selPalette').addEventListener('change', () => {
    params.palette = ($('selPalette') as HTMLSelectElement).value as FusionParams['palette'];
    engine.setPalette(params.palette);
    render();
  });
  $('btnAutoReg').addEventListener('click', () => {
    if (!current) return;
    const t0 = performance.now();
    autoRegister(engine, current.pair, current.reg);
    const regMs = performance.now() - t0;
    if (current.metrics) current.metrics.regMs = regMs;
    syncRegSliders();
    render();
    renderMetrics();
    setStatus(`自动配准完成,耗时 ${regMs.toFixed(0)}ms`);
  });
  $('btnResetReg').addEventListener('click', () => {
    if (!current) return;
    current.reg = defaultRegistration(current.pair);
    engine.clearField();
    syncRegSliders();
    render();
  });
}

// ---------- 视图切换 / 温度读取 ----------

function bindViews(): void {
  document.querySelectorAll('#viewTabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#viewTabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      params.view = Number((btn as HTMLElement).dataset.view);
      render();
    });
  });

  const readout = $('readout');
  glCanvas.parentElement!.addEventListener('click', e => {
    if (!current) return;
    const { pair, reg } = current;
    const rect = glCanvas.getBoundingClientRect();
    const scale = Math.min(rect.width / pair.visW, rect.height / pair.visH);
    const ox = (rect.width - pair.visW * scale) / 2;
    const oy = (rect.height - pair.visH * scale) / 2;
    const x = (e.clientX - rect.left - ox) / scale;
    const y = (e.clientY - rect.top - oy) / scale;
    if (x < 0 || y < 0 || x >= pair.visW || y >= pair.visH) { readout.hidden = true; return; }
    const t = tempAtVis(pair, reg, x, y, params.fieldScale);
    const dev = pair.devices.find(d => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h);
    const wrapRect = glCanvas.parentElement!.getBoundingClientRect();
    readout.hidden = false;
    readout.style.left = `${e.clientX - wrapRect.left + 12}px`;
    readout.style.top = `${e.clientY - wrapRect.top + 12}px`;
    readout.innerHTML = t === null
      ? `(${x.toFixed(0)}, ${y.toFixed(0)}) 超出红外视场`
      : `<b>${t.toFixed(1)} °C</b> @(${x.toFixed(0)}, ${y.toFixed(0)})` +
        (dev ? `<br>${dev.device} / ${dev.part}` : '');
    // 十字标记
    drawOverlay();
    octx.strokeStyle = '#fff';
    octx.lineWidth = 1.5;
    octx.beginPath();
    octx.moveTo(x - 8, y); octx.lineTo(x + 8, y);
    octx.moveTo(x, y - 8); octx.lineTo(x, y + 8);
    octx.stroke();
  });
}

// ---------- 样例与导入 ----------

function bindSamples(): void {
  const box = $('sampleButtons');
  for (const s of SCENE_LIST) {
    const btn = document.createElement('button');
    btn.textContent = s.name;
    btn.onclick = () => { addPair(generateSample(s.id)); setStatus(`已生成样例:${s.name}`); };
    box.appendChild(btn);
  }
  $('btnGenAll').addEventListener('click', async () => {
    for (const s of SCENE_LIST) addPair(generateSample(s.id));
    await processAll();
  });
  $('btnProcessAll').addEventListener('click', processAll);
}

async function fileToImageData(f: File): Promise<ImageData> {
  const bmp = await createImageBitmap(f);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

function bindImport(): void {
  $('fileInput').addEventListener('change', async () => {
    const files = Array.from(($('fileInput') as HTMLInputElement).files || []);
    if (!files.length) return;
    setStatus('导入中…');
    const irs: File[] = [], viss: File[] = [], rest: File[] = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (/ir|红外|thermal|inf/.test(n)) irs.push(f);
      else if (/vis|rgb|可见|light/.test(n)) viss.push(f);
      else rest.push(f);
    }
    for (const f of rest) (irs.length <= viss.length ? irs : viss).push(f);
    irs.sort((a, b) => a.name.localeCompare(b.name));
    viss.sort((a, b) => a.name.localeCompare(b.name));
    const tMin = Number(($('impTMin') as HTMLInputElement).value);
    const tMax = Number(($('impTMax') as HTMLInputElement).value);
    const n = Math.min(irs.length, viss.length);
    for (let i = 0; i < n; i++) {
      const [irImg, visImg] = await Promise.all([fileToImageData(irs[i]), fileToImageData(viss[i])]);
      const temp = new Float32Array(irImg.width * irImg.height);
      for (let p = 0; p < temp.length; p++) {
        temp[p] = tMin + (irImg.data[p * 4] / 255) * (tMax - tMin);
      }
      addPair({
        id: `imp-${Date.now()}-${i}`,
        name: viss[i].name.replace(/\.[^.]+$/, ''),
        visW: visImg.width, visH: visImg.height, vis: visImg,
        irW: irImg.width, irH: irImg.height, irGray: irImg,
        temp, tempMin: tMin, tempMax: tMax,
        devices: [], suggestedK1: 0.12,
      });
    }
    setStatus(`已导入 ${n} 对图像`);
  });
}

// ---------- 启动 ----------

bindSamples();
bindImport();
bindRegSliders();
bindViews();
updateSliderLabels();
setStatus('就绪:生成样例或导入图像对');

// 调试/验证钩子
(window as unknown as { __app: unknown }).__app = { pairs, engine, params, irPxToVisPx, visPxToIrPx };
