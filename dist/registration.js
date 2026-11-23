// 配准:GPU 评分搜索 + CPU 编排;坐标变换的 CPU 实现(与着色器一致,供热点映射/温度读取/指标计算)
import { GRID_W, GRID_H } from './gl/engine.js';
export function defaultRegistration(pair) {
    return {
        affine: { scale: 0.92, rot: 0, tx: 0, ty: 0 },
        k1: pair.suggestedK1,
        gridW: GRID_W, gridH: GRID_H,
        field: new Float32Array(GRID_W * GRID_H * 2),
        score: 0,
    };
}
/** 自动配准:全局仿射(平移/缩放/旋转)多候选精化 + 局部视差场两轮 */
export function autoRegister(engine, pair, reg) {
    const H = pair.visH;
    const k1 = reg.k1;
    // 先验(出厂标定):候选评分减去偏离先验的二次罚项——近先验几乎不罚,远先验重罚
    const prior = { ...reg.affine };
    const penalty = (scale, rot, tx, ty) => {
        const dtx = (tx - prior.tx) * H, dty = (ty - prior.ty) * H;
        const ds = scale - prior.scale, dr = (rot - prior.rot) * 180 / Math.PI;
        return 0.0002 * (dtx * dtx + dty * dty) + 20 * ds * ds + 0.01 * dr * dr;
    };
    const bestOf = (data, w, h, paramsOf) => {
        let bi = 0, bv = -Infinity;
        for (let i = 0; i < w * h; i++) {
            const ix = i % w, iy = Math.floor(i / w);
            const v = data[i * 4] - penalty(...paramsOf(ix, iy));
            if (v > bv) {
                bv = v;
                bi = i;
            }
        }
        return [bi % w, Math.floor(bi / w), bv];
    };
    const cands = [];
    const s0 = reg.affine.scale;
    for (const s of [s0 - 0.12, s0 - 0.06, s0, s0 + 0.06, s0 + 0.12]) {
        for (const rDeg of [-2.5, 0, 2.5]) {
            const r = rDeg * Math.PI / 180;
            const data = engine.scoreSlice(0, [reg.affine.tx, reg.affine.ty], s, r, k1, [6 / H, 6 / H], 21, 21, 3);
            const [ix, iy, v] = bestOf(data, 21, 21, (ix, iy) => [s, r,
                reg.affine.tx + (ix - 10) * 6 / H, reg.affine.ty + (iy - 10) * 6 / H]);
            cands.push({
                scale: s, rot: r,
                tx: reg.affine.tx + (ix - 10) * 6 / H,
                ty: reg.affine.ty + (iy - 10) * 6 / H,
                score: v,
            });
        }
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands.slice(0, 3);
    // 阶段2-4: 每个候选分别精化,坐标下降两轮(平移 <-> 缩放/旋转 交替收敛),取最终分最高者
    let best = { scale: s0, rot: 0, tx: 0, ty: 0, score: -Infinity };
    for (const c of top) {
        let { scale, rot, tx, ty } = c;
        let v = -Infinity;
        for (let round = 0; round < 2; round++) {
            for (const [stepPx, n, lod] of [[2, 25, 1.5], [0.6, 21, 0]]) {
                const data = engine.scoreSlice(0, [tx, ty], scale, rot, k1, [stepPx / H, stepPx / H], n, n, lod);
                const [ix, iy] = bestOf(data, n, n, (ix, iy) => [scale, rot,
                    tx + (ix - (n - 1) / 2) * stepPx / H, ty + (iy - (n - 1) / 2) * stepPx / H]);
                tx += (ix - (n - 1) / 2) * stepPx / H;
                ty += (iy - (n - 1) / 2) * stepPx / H;
            }
            for (const [sStep, rStepDeg, n] of [[0.02, 0.6, 11], [0.006, 0.2, 11]]) {
                const data = engine.scoreSlice(1, [tx, ty], scale, rot, k1, [sStep, rStepDeg * Math.PI / 180], n, n, 0);
                const [ix, iy] = bestOf(data, n, n, (ix, iy) => [
                    scale + (ix - (n - 1) / 2) * sStep, rot + (iy - (n - 1) / 2) * rStepDeg * Math.PI / 180, tx, ty
                ]);
                scale += (ix - (n - 1) / 2) * sStep;
                rot += (iy - (n - 1) / 2) * rStepDeg * Math.PI / 180;
            }
            const n = 21, stepPx = 0.5;
            const data = engine.scoreSlice(0, [tx, ty], scale, rot, k1, [stepPx / H, stepPx / H], n, n, 0);
            const [ix, iy, vv] = bestOf(data, n, n, (ix, iy) => [scale, rot,
                tx + (ix - (n - 1) / 2) * stepPx / H, ty + (iy - (n - 1) / 2) * stepPx / H]);
            tx += (ix - (n - 1) / 2) * stepPx / H;
            ty += (iy - (n - 1) / 2) * stepPx / H;
            v = vv;
        }
        if (v > best.score)
            best = { scale, rot, tx, ty, score: v };
    }
    reg.affine = { scale: best.scale, rot: best.rot, tx: best.tx, ty: best.ty };
    // 阶段5: 视差场(处理远近设备视差)—— 小范围两轮;仿准已较准,场只补视差
    engine.clearField();
    engine.computeField(reg, false, 4 / H, 1 / H, 24 / H);
    engine.computeField(reg, true, 1.2 / H, 0.3 / H, 24 / H);
    // 场纹理第 0 行即图像顶行(与 CPU 约定一致),直接拷贝
    // 3x3 平滑(视差来自深度,空间上分段光滑)+ NCC 置信度门控(无纹理区衰减到 0)
    const raw = engine.readField();
    const smoothed = new Float32Array(GRID_W * GRID_H * 2);
    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let sx = 0, sy = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = gx + dx, ny = gy + dy;
                    if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H)
                        continue;
                    sx += raw[(ny * GRID_W + nx) * 4];
                    sy += raw[(ny * GRID_W + nx) * 4 + 1];
                    cnt++;
                }
            }
            smoothed[(gy * GRID_W + gx) * 2] = sx / cnt;
            smoothed[(gy * GRID_W + gx) * 2 + 1] = sy / cnt;
        }
    }
    const field = new Float32Array(GRID_W * GRID_H * 2);
    for (let i = 0; i < GRID_W * GRID_H; i++) {
        const conf = raw[i * 4 + 3];
        let g = (conf - 0.1) / 0.25;
        g = Math.min(Math.max(g, 0), 1);
        g = g * g * (3 - 2 * g);
        field[i * 2] = smoothed[i * 2] * g;
        field[i * 2 + 1] = smoothed[i * 2 + 1] * g;
    }
    reg.field = field;
    reg.score = best.score;
    engine.uploadField(field); // GPU 侧使用同一份门控后的场
}
// ---------- CPU 坐标变换(与 GLSL 一致) ----------
function undistort(x, y, k1) {
    let dx = x, dy = y;
    for (let i = 0; i < 4; i++) {
        const f = 1 + k1 * (dx * dx + dy * dy);
        dx = x / f;
        dy = y / f;
    }
    return [dx, dy];
}
function distort(x, y, k1) {
    const f = 1 + k1 * (x * x + y * y);
    return [x * f, y * f];
}
/** 视差场双线性采样,输入可见光 uv(0..1, 顶行优先),返回高归一化位移 */
export function sampleField(reg, u, v) {
    const gx = Math.min(Math.max(u, 0), 1) * reg.gridW - 0.5;
    const gy = Math.min(Math.max(v, 0), 1) * reg.gridH - 0.5;
    const x0 = Math.max(0, Math.floor(gx)), y0 = Math.max(0, Math.floor(gy));
    const x1 = Math.min(reg.gridW - 1, x0 + 1), y1 = Math.min(reg.gridH - 1, y0 + 1);
    const fx = Math.min(Math.max(gx - x0, 0), 1), fy = Math.min(Math.max(gy - y0, 0), 1);
    const g = (x, y, c) => reg.field[(y * reg.gridW + x) * 2 + c];
    const dx = (g(x0, y0, 0) * (1 - fx) + g(x1, y0, 0) * fx) * (1 - fy) + (g(x0, y1, 0) * (1 - fx) + g(x1, y1, 0) * fx) * fy;
    const dy = (g(x0, y0, 1) * (1 - fx) + g(x1, y0, 1) * fx) * (1 - fy) + (g(x0, y1, 1) * (1 - fx) + g(x1, y1, 1) * fx) * fy;
    return [dx, dy];
}
/** 可见光像素 -> 红外像素坐标(可越界,调用方判断) */
export function visPxToIrPx(x, y, reg, s, fieldScale = 1) {
    const u = x / s.visW, v = y / s.visH;
    let cx = (u - 0.5) * s.visW / s.visH, cy = v - 0.5;
    const [fx, fy] = sampleField(reg, u, v);
    cx -= fx * fieldScale;
    cy -= fy * fieldScale;
    const a = reg.affine;
    let px = cx - a.tx, py = cy - a.ty;
    const cs = Math.cos(-a.rot), sn = Math.sin(-a.rot);
    const rx = (cs * px - sn * py) / a.scale;
    const ry = (sn * px + cs * py) / a.scale;
    const [dx, dy] = undistort(rx, ry, reg.k1);
    return [(dx * s.irH / s.irW + 0.5) * s.irW, (dy + 0.5) * s.irH];
}
/** 红外像素 -> 可见光像素(不动点迭代求逆) */
export function irPxToVisPx(ix, iy, reg, s, fieldScale = 1) {
    const a = reg.affine;
    let cx = (ix / s.irW - 0.5) * s.irW / s.irH, cy = iy / s.irH - 0.5;
    const [dx, dy] = distort(cx, cy, reg.k1);
    const cs = Math.cos(a.rot), sn = Math.sin(a.rot);
    const bx = a.scale * (cs * dx - sn * dy) + a.tx;
    const by = a.scale * (sn * dx + cs * dy) + a.ty;
    let vx = bx, vy = by;
    for (let i = 0; i < 3; i++) {
        const u = (vx * s.visH / s.visW + 0.5), v = vy + 0.5;
        const [fx, fy] = sampleField(reg, u, v);
        vx = bx + fx * fieldScale;
        vy = by + fy * fieldScale;
    }
    return [(vx * s.visH / s.visW + 0.5) * s.visW, (vy + 0.5) * s.visH];
}
/** 读取可见光图像某点对应的温度(双线性),超出红外视场返回 null */
export function tempAtVis(pair, reg, x, y, fieldScale = 1) {
    const s = { visW: pair.visW, visH: pair.visH, irW: pair.irW, irH: pair.irH };
    const [ix, iy] = visPxToIrPx(x, y, reg, s, fieldScale);
    if (ix < 0 || iy < 0 || ix > pair.irW - 1 || iy > pair.irH - 1)
        return null;
    const x0 = Math.floor(ix), y0 = Math.floor(iy);
    const x1 = Math.min(pair.irW - 1, x0 + 1), y1 = Math.min(pair.irH - 1, y0 + 1);
    const fx = ix - x0, fy = iy - y0;
    const t = (xx, yy) => pair.temp[yy * pair.irW + xx];
    return (t(x0, y0) * (1 - fx) + t(x1, y0) * fx) * (1 - fy) + (t(x0, y1) * (1 - fx) + t(x1, y1) * fx) * fy;
}
//# sourceMappingURL=registration.js.map