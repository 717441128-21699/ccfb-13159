const W = 800, H = 600;
const IR_W = 320, IR_H = 240;
// 确定性随机
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function makeCtx(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')];
}
function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let x = -r; x <= r; x++)
            acc += src[y * w + Math.min(Math.max(x, 0), w - 1)];
        for (let x = 0; x < w; x++) {
            tmp[y * w + x] = acc / n;
            const xa = Math.min(x + r + 1, w - 1), xs = Math.max(x - r, 0);
            acc += src[y * w + xa] - src[y * w + xs];
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++)
            acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc / n;
            const ya = Math.min(y + r + 1, h - 1), ys = Math.max(y - r, 0);
            acc += tmp[ya * w + x] - tmp[ys * w + x];
        }
    }
    return out;
}
function metalGrad(ctx, x0, x1, c0, c1, c2) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, c0);
    g.addColorStop(0.5, c1);
    g.addColorStop(1, c2);
    return g;
}
/** 支柱绝缘子:芯棒 + 伞裙串 + 上下法兰 */
function postInsulator(ctx, x, yBase, yTop, r, mask) {
    const h = yBase - yTop;
    ctx.fillStyle = mask ? '#fff' : metalGrad(ctx, x - r * 0.55, x + r * 0.55, '#5c646e', '#9aa3ad', '#4c545e');
    ctx.fillRect(x - r * 0.55, yTop, r * 1.1, h);
    const n = Math.max(3, Math.floor(h / 26));
    for (let i = 0; i < n; i++) {
        const y = yTop + (i + 0.5) * h / n;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.5, r * 0.62, 0, 0, Math.PI * 2);
        ctx.fillStyle = mask ? '#fff' : (i % 2 ? '#8b939d' : '#a7b0ba');
        ctx.fill();
        if (!mask) {
            ctx.beginPath();
            ctx.ellipse(x, y - r * 0.18, r * 1.5, r * 0.3, 0, Math.PI, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.28)';
            ctx.fill();
        }
    }
    for (const y of [yTop, yBase]) {
        ctx.fillStyle = mask ? '#fff' : metalGrad(ctx, x - r, x + r, '#6b7280', '#b6bec7', '#565e68');
        ctx.fillRect(x - r, y - 7, r * 2, 14);
        if (!mask) {
            ctx.fillStyle = '#3c434c';
            for (let i = -1; i <= 1; i++) {
                ctx.beginPath();
                ctx.arc(x + i * r * 0.6, y, 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}
/** 悬式绝缘子串(盘形 Bell) */
function discString(ctx, x, yTop, yBot, r, mask) {
    const n = Math.max(3, Math.floor((yBot - yTop) / 30));
    for (let i = 0; i < n; i++) {
        const y = yTop + (i + 0.5) * (yBot - yTop) / n;
        ctx.fillStyle = mask ? '#fff' : '#7e8791';
        ctx.fillRect(x - 3, y - 16, 6, 20); // 连接金具
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.52, 0, 0, Math.PI * 2);
        ctx.fillStyle = mask ? '#fff' : (i % 2 ? '#95503c' : '#a55f49'); // 瓷质棕红
        ctx.fill();
        if (!mask) {
            ctx.beginPath();
            ctx.ellipse(x, y - r * 0.15, r * 0.96, r * 0.24, 0, Math.PI, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.22)';
            ctx.fill();
        }
    }
}
function bolt(ctx, x, y, r, mask) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = mask ? '#fff' : metalGrad(ctx, x - r, x + r, '#4a515b', '#c8cfd7', '#3f4650');
    ctx.fill();
    if (!mask) {
        ctx.beginPath();
        ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fill();
    }
}
function tube(ctx, x0, y0, x1, y1, w, mask, c = '#9aa3ad') {
    ctx.strokeStyle = mask ? '#fff' : c;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (!mask) {
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = w * 0.3;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - w * 0.22);
        ctx.lineTo(x1, y1 - w * 0.22);
        ctx.stroke();
    }
}
/** 背景:天空/远处构架/地面(同时画进 bgMask 用于背景热结构) */
function background(ctx, bg, rng) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#7fa8c9');
    sky.addColorStop(0.7, '#b8cdd9');
    sky.addColorStop(1, '#9aa89b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // 远处构架与母线
    ctx.strokeStyle = 'rgba(90,100,112,0.55)';
    ctx.lineWidth = 3;
    bg.strokeStyle = '#fff';
    bg.lineWidth = 5;
    for (const bx of [90, 700]) {
        ctx.beginPath();
        ctx.moveTo(bx, 60);
        ctx.lineTo(bx, 430);
        ctx.stroke();
        bg.beginPath();
        bg.moveTo(bx, 60);
        bg.lineTo(bx, 430);
        bg.stroke();
        ctx.beginPath();
        ctx.moveTo(bx - 26, 60);
        ctx.lineTo(bx + 26, 60);
        ctx.stroke();
        bg.beginPath();
        bg.moveTo(bx - 26, 60);
        bg.lineTo(bx + 26, 60);
        bg.stroke();
        ctx.beginPath();
        ctx.moveTo(bx - 18, 110);
        ctx.lineTo(bx + 18, 110);
        ctx.stroke();
    }
    ctx.lineWidth = 2;
    bg.lineWidth = 3;
    for (const y of [70, 118]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y - 6);
        ctx.stroke();
        bg.beginPath();
        bg.moveTo(0, y);
        bg.lineTo(W, y - 6);
        bg.stroke();
    }
    // 地面
    ctx.fillStyle = '#77806e';
    ctx.fillRect(0, 500, W, 100);
    bg.fillStyle = '#fff';
    bg.fillRect(0, 500, W, 100);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let i = 0; i < 40; i++)
        ctx.fillRect(rng() * W, 500 + rng() * 96, 12 + rng() * 30, 3);
}
/** 铭牌 */
function plate(ctx, x, y, text) {
    ctx.fillStyle = '#e8e4d8';
    ctx.fillRect(x, y, 74, 20);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, 74, 20);
    ctx.fillStyle = '#222';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, x + 37, y + 14);
}
// ---------- 场景 ----------
function sceneBase(seed) {
    const rng = mulberry32(seed);
    const [, vis] = makeCtx(W, H);
    const [maskC, mask] = makeCtx(W, H);
    const [, bgMask] = makeCtx(W, H);
    const b = {
        vis, mask, bgMask, rng, depth: new Float32Array(W * H).fill(1),
        hots: [], devices: [],
        hot(x, y, sigma, dT) { this.hots.push({ x, y, sigma, dT }); },
        device(name, part, x, y, w, h) { this.devices.push({ device: name, part, x, y, w, h }); },
        applyDepth(d) {
            const data = mask.getImageData(0, 0, W, H).data;
            for (let i = 0; i < W * H; i++)
                if (data[i * 4] > 128)
                    this.depth[i] = d;
        },
        finish() { },
    };
    background(vis, bgMask, rng);
    return b;
}
function buildScene1() {
    const b = sceneBase(101);
    // 110kV 隔离开关:两支柱绝缘子 + 导电臂 + 触头
    postInsulator(b.vis, 290, 470, 300, 16, false);
    postInsulator(b.vis, 510, 470, 300, 16, false);
    postInsulator(b.mask, 290, 470, 300, 16, true);
    postInsulator(b.mask, 510, 470, 300, 16, true);
    tube(b.vis, 290, 292, 560, 292, 14, false, '#aeb6bf');
    tube(b.mask, 290, 292, 560, 292, 14, true);
    // 触头座(静触头)
    b.vis.fillStyle = metalGrad(b.vis, 496, 544, '#6b7280', '#c2c9d1', '#565e68');
    b.vis.fillRect(496, 272, 48, 40);
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(496, 272, 48, 40);
    bolt(b.vis, 508, 282, 5, false);
    bolt(b.vis, 532, 282, 5, false);
    bolt(b.mask, 508, 282, 5, true);
    bolt(b.mask, 532, 282, 5, true);
    plate(b.vis, 262, 486, 'GW4-110');
    b.applyDepth(1.0);
    b.device('110kV隔离开关', 'A相触头', 492, 266, 58, 52);
    b.device('110kV隔离开关', '导电臂', 288, 280, 210, 26);
    b.device('110kV隔离开关', '左支柱绝缘子', 262, 296, 56, 180);
    b.device('110kV隔离开关', '右支柱绝缘子', 482, 296, 56, 180);
    b.hot(520, 290, 10, 45); // 触头发热(危急)
    b.hot(296, 292, 7, 14); // 导电臂根部轻微
    return b;
}
function buildScene2() {
    const b = sceneBase(202);
    // 220kV 悬式绝缘子串
    b.vis.fillStyle = '#5d666f';
    b.vis.fillRect(0, 60, 480, 26); // 横担
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(0, 60, 480, 26);
    discString(b.vis, 420, 92, 372, 30, false);
    discString(b.mask, 420, 92, 372, 30, true);
    tube(b.vis, 420, 372, 420, 420, 8, false, '#8f98a2');
    tube(b.mask, 420, 372, 420, 420, 8, true);
    plate(b.vis, 330, 64, '220kV');
    b.applyDepth(1.15); // 较远
    b.device('220kV线路', '绝缘子串', 384, 92, 72, 290);
    b.device('220kV线路', '球头挂环', 402, 86, 36, 34);
    b.device('220kV线路', '横担', 0, 56, 480, 34);
    b.hot(420, 102, 9, 26); // 球头连接发热(严重)
    b.hot(420, 210, 15, 6); // 污秽轻微发热(不越限)
    return b;
}
function buildScene3() {
    const b = sceneBase(303);
    // 1号主变:油箱 + 倾斜高压套管 + 接线端子
    b.vis.fillStyle = metalGrad(b.vis, 200, 620, '#4e5a50', '#6e7d6f', '#45503f');
    b.vis.fillRect(200, 420, 420, 140);
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(200, 420, 420, 140);
    b.vis.fillStyle = 'rgba(0,0,0,0.18)';
    b.vis.fillRect(200, 434, 420, 6); // 油位线
    for (const rx of [250, 330, 490, 570]) { // 散热片
        b.vis.fillStyle = '#59655c';
        b.vis.fillRect(rx, 430, 18, 120);
        b.mask.fillRect(rx, 430, 18, 120);
    }
    // 套管:从 (430,424) 到 (372,180)
    const x0 = 430, y0 = 424, x1 = 372, y1 = 180;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (const ctx of [b.vis, b.mask]) {
        const m = ctx === b.mask;
        ctx.save();
        ctx.translate(x0, y0);
        ctx.rotate(ang + Math.PI / 2);
        ctx.fillStyle = m ? '#fff' : '#8f5a44';
        ctx.fillRect(-13, -len, 26, len);
        const n = 9;
        for (let i = 0; i < n; i++) {
            const y = -(i + 0.5) * len / n;
            ctx.beginPath();
            ctx.ellipse(0, y, 24, 9, 0, 0, Math.PI * 2);
            ctx.fillStyle = m ? '#fff' : (i % 2 ? '#7e4e3a' : '#99604a');
            ctx.fill();
        }
        ctx.restore();
    }
    // 接线端子 + 引线
    b.vis.fillStyle = '#c8cfd7';
    b.vis.fillRect(356, 158, 32, 26);
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(356, 158, 32, 26);
    bolt(b.vis, 366, 168, 5, false);
    bolt(b.vis, 380, 168, 5, false);
    bolt(b.mask, 366, 168, 5, true);
    bolt(b.mask, 380, 168, 5, true);
    tube(b.vis, 372, 158, 372, 96, 6, false, '#b9c0c9');
    tube(b.mask, 372, 158, 372, 96, 6, true);
    plate(b.vis, 300, 470, '1号主变');
    b.applyDepth(0.9); // 较近,视差大
    b.device('1号主变', '高压套管', 340, 180, 100, 250);
    b.device('1号主变', '接线端子', 352, 152, 42, 36);
    b.device('1号主变', '本体油箱', 200, 420, 420, 140);
    b.hot(372, 168, 11, 62); // 端子发热(危急)
    b.hot(410, 430, 20, 5); // 油面正常温升
    return b;
}
function buildScene4() {
    const b = sceneBase(404);
    // 35kV 母线 + T 型线夹,螺栓发热
    tube(b.vis, 0, 240, W, 236, 26, false, '#a8b0ba');
    tube(b.mask, 0, 240, W, 236, 26, true);
    b.vis.fillStyle = metalGrad(b.vis, 356, 446, '#5a626c', '#aeb6bf', '#4c545e');
    b.vis.fillRect(356, 206, 90, 66);
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(356, 206, 90, 66);
    for (const [bx, by] of [[372, 220], [430, 220], [372, 256], [430, 256]]) {
        bolt(b.vis, bx, by, 7, false);
        bolt(b.mask, bx, by, 7, true);
    }
    tube(b.vis, 401, 272, 401, 330, 12, false, '#9aa3ad');
    tube(b.mask, 401, 272, 401, 330, 12, true);
    plate(b.vis, 360, 340, '35kV母线');
    b.applyDepth(1.05);
    b.device('35kV母线', 'T型线夹', 352, 200, 100, 80);
    b.device('35kV母线', '母线', 0, 222, W, 40);
    b.hot(372, 220, 6, 18); // 螺栓1(一般)
    b.hot(430, 220, 6, 23); // 螺栓2(严重)
    b.hot(401, 240, 14, 8); // 线夹体
    return b;
}
function buildScene5() {
    const b = sceneBase(505);
    // 电流互感器:正常工况(对照组)
    postInsulator(b.vis, 400, 490, 310, 18, false);
    postInsulator(b.mask, 400, 490, 310, 18, true);
    b.vis.fillStyle = metalGrad(b.vis, 356, 444, '#5a626c', '#9fa8b2', '#4c545e');
    b.vis.fillRect(356, 252, 88, 60); // 头部壳体
    b.mask.fillStyle = '#fff';
    b.mask.fillRect(356, 252, 88, 60);
    tube(b.vis, 380, 252, 380, 228, 8, false, '#aeb6bf');
    tube(b.vis, 420, 252, 420, 228, 8, false, '#aeb6bf');
    tube(b.mask, 380, 252, 380, 228, 8, true);
    tube(b.mask, 420, 252, 420, 228, 8, true);
    plate(b.vis, 366, 506, 'TA-110');
    b.applyDepth(0.95);
    b.device('110kV电流互感器', '头部', 352, 224, 96, 92);
    b.device('110kV电流互感器', '支柱绝缘子', 372, 306, 56, 190);
    b.hot(400, 280, 16, 4); // 正常负载温升
    return b;
}
const SCENE_DEFS = [
    { id: 'gw', name: '隔离开关·触头发热', build: buildScene1, cam: { scale: 0.93, rotDeg: 1.2, txPx: 10, tyPx: -7, k1: 0.12, parK: 0.05 } },
    { id: 'ins', name: '绝缘子串·球头发热', build: buildScene2, cam: { scale: 0.90, rotDeg: -1.6, txPx: -12, tyPx: 6, k1: 0.15, parK: 0.06 } },
    { id: 'bush', name: '主变套管·端子发热', build: buildScene3, cam: { scale: 0.95, rotDeg: 0.8, txPx: 14, tyPx: 9, k1: 0.10, parK: 0.07 } },
    { id: 'bus', name: '母线线夹·螺栓发热', build: buildScene4, cam: { scale: 0.91, rotDeg: 2.0, txPx: -8, tyPx: -10, k1: 0.14, parK: 0.05 } },
    { id: 'ct', name: '电流互感器·正常工况', build: buildScene5, cam: { scale: 0.94, rotDeg: -0.9, txPx: 6, tyPx: 12, k1: 0.11, parK: 0.06 } },
];
export const SCENE_LIST = SCENE_DEFS.map(d => ({ id: d.id, name: d.name }));
function buildTempWorld(b) {
    const rng = mulberry32(999);
    const temp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        const base = 22 + 4 * (y / H); // 环境竖直梯度
        for (let x = 0; x < W; x++)
            temp[y * W + x] = base + (rng() - 0.5) * 0.6;
    }
    // 背景结构热:杆塔/母线金属日照升温、地面与天空的温差,提供全局配准约束
    const bgData = b.bgMask.getImageData(0, 0, W, H).data;
    const bgF = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++)
        bgF[i] = bgData[i * 4] / 255;
    const bgWarm = boxBlur(bgF, W, H, 3);
    for (let i = 0; i < W * H; i++)
        temp[i] += bgWarm[i] * 2.2;
    // 设备本体发热:金属/瓷件发射率与自热不同,温度随可见光亮度调制——
    // 这样红外图带有设备结构边缘(真实热像仪同样能看到法兰/伞裙轮廓)
    const maskData = b.mask.getImageData(0, 0, W, H).data;
    const visData = b.vis.getImageData(0, 0, W, H).data;
    const maskF = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        if (maskData[i * 4] > 128) {
            maskF[i] = 1;
            const lum = (0.299 * visData[i * 4] + 0.587 * visData[i * 4 + 1] + 0.114 * visData[i * 4 + 2]) / 255;
            temp[i] += 1.2 + 3.2 * lum;
        }
    }
    const warm = boxBlur(maskF, W, H, 6); // 设备整体向环境散热的热晕
    for (let i = 0; i < W * H; i++)
        temp[i] += warm[i] * 1.5;
    // 发热点高斯
    for (const h of b.hots) {
        const r = Math.ceil(h.sigma * 3);
        for (let y = Math.max(0, h.y - r); y < Math.min(H, h.y + r); y++) {
            for (let x = Math.max(0, h.x - r); x < Math.min(W, h.x + r); x++) {
                const d2 = (x - h.x) ** 2 + (y - h.y) ** 2;
                temp[y * W + x] += h.dT * Math.exp(-d2 / (2 * h.sigma * h.sigma));
            }
        }
    }
    return boxBlur(temp, W, H, 2); // 红外光学模糊
}
export function generateSample(id) {
    const def = SCENE_DEFS.find(d => d.id === id);
    const b = def.build();
    const cam = def.cam;
    const tempWorld = buildTempWorld(b);
    // 可见光图加传感器噪声(细节纹理)
    const visImg = b.vis.getImageData(0, 0, W, H);
    const rng = mulberry32(7);
    for (let i = 0; i < visImg.data.length; i += 4) {
        const n = (rng() - 0.5) * 13;
        visImg.data[i] += n;
        visImg.data[i + 1] += n;
        visImg.data[i + 2] += n;
    }
    // 红外相机:畸变 + 仿射 + 深度视差采样世界温度场
    const temp = new Float32Array(IR_W * IR_H);
    const theta = cam.rotDeg * Math.PI / 180;
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const tx = cam.txPx / H, ty = cam.tyPx / H;
    const rng2 = mulberry32(55);
    const sampleTemp = (wx, wy) => {
        const x0 = Math.floor(wx), y0 = Math.floor(wy);
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1)
            return 22;
        const fx = wx - x0, fy = wy - y0;
        const t = (xx, yy) => tempWorld[yy * W + xx];
        return (t(x0, y0) * (1 - fx) + t(x0 + 1, y0) * fx) * (1 - fy) + (t(x0, y0 + 1) * (1 - fx) + t(x0 + 1, y0 + 1) * fx) * fy;
    };
    const sampleDepth = (wx, wy) => {
        const xi = Math.min(Math.max(Math.round(wx), 0), W - 1);
        const yi = Math.min(Math.max(Math.round(wy), 0), H - 1);
        return b.depth[yi * W + xi];
    };
    for (let v = 0; v < IR_H; v++) {
        for (let u = 0; u < IR_W; u++) {
            let cx = (u + 0.5 - IR_W / 2) / IR_H;
            let cy = (v + 0.5 - IR_H / 2) / IR_H;
            const r2 = cx * cx + cy * cy;
            const f = 1 + cam.k1 * r2; // 径向畸变
            cx *= f;
            cy *= f;
            let wx = cam.scale * (cs * cx - sn * cy) + tx; // 仿射
            let wy = cam.scale * (sn * cx + cs * cy) + ty;
            const px = wx * H + W / 2, py = wy * H + H / 2;
            const depth = sampleDepth(px, py);
            const par = cam.parK * (1 / depth - 1); // 视差:近处位移大
            wx += par;
            wy += par * 0.3;
            temp[v * IR_W + u] = sampleTemp(wx * H + W / 2, wy * H + H / 2) + (rng2() - 0.5) * 0.3; // NETD ~0.15°C
        }
    }
    let tMin = Infinity, tMax = -Infinity;
    for (const t of temp) {
        if (t < tMin)
            tMin = t;
        if (t > tMax)
            tMax = t;
    }
    const irGray = new ImageData(IR_W, IR_H);
    const span = Math.max(tMax - tMin, 1e-3);
    for (let i = 0; i < temp.length; i++) {
        const g = Math.round((temp[i] - tMin) / span * 255);
        irGray.data[i * 4] = g;
        irGray.data[i * 4 + 1] = g;
        irGray.data[i * 4 + 2] = g;
        irGray.data[i * 4 + 3] = 255;
    }
    return {
        id: `sample-${id}-${Date.now()}`,
        name: def.name,
        visW: W, visH: H, vis: visImg,
        irW: IR_W, irH: IR_H, irGray,
        temp, tempMin: tMin, tempMax: tMax,
        devices: b.devices,
        suggestedK1: cam.k1,
        truth: { cam, depth: b.depth },
    };
}
//# sourceMappingURL=samples.js.map