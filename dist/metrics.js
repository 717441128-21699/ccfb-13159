import { visPxToIrPx } from './registration.js';
export function computeMetrics(pair, reg, fused, t0, t1, fieldScale, regMs, fuseMs) {
    const W = pair.visW, H = pair.visH;
    const sizes = { visW: W, visH: H, irW: pair.irW, irH: pair.irH };
    const vis = pair.vis.data;
    const lumV = new Float32Array(W * H);
    const lumF = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        lumV[i] = 0.299 * vis[i * 4] + 0.587 * vis[i * 4 + 1] + 0.114 * vis[i * 4 + 2];
        lumF[i] = 0.299 * fused[i * 4] + 0.587 * fused[i * 4 + 1] + 0.114 * fused[i * 4 + 2];
    }
    // 每像素叠加 alpha(与着色器 smoothstep 一致)
    const alpha = new Float32Array(W * H);
    const span = Math.max(t1 - t0, 1e-3);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const [ix, iy] = visPxToIrPx(x, y, reg, sizes, fieldScale);
            if (ix < 0 || iy < 0 || ix >= pair.irW - 1 || iy >= pair.irH - 1)
                continue;
            const t = pair.temp[Math.round(iy) * pair.irW + Math.round(ix)];
            let a = (t - t0) / span;
            a = Math.min(Math.max(a, 0), 1);
            alpha[y * W + x] = a * a * (3 - 2 * a);
        }
    }
    // 细节保持:热区(alpha>0.1)内 Sobel 梯度能量比
    let gV = 0, gF = 0;
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            if (alpha[i] <= 0.1)
                continue;
            const gxV = lumV[i + 1] - lumV[i - 1], gyV = lumV[i + W] - lumV[i - W];
            const gxF = lumF[i + 1] - lumF[i - 1], gyF = lumF[i + W] - lumF[i - W];
            gV += Math.hypot(gxV, gyV);
            gF += Math.hypot(gxF, gyF);
        }
    }
    const detail = gV > 0 ? gF / gV : 1;
    // 背景对比度:低温区(alpha<0.05)16px 块内标准差之比
    const B = 16;
    let sV = 0, sF = 0, nb = 0;
    for (let by = 0; by + B <= H; by += B) {
        for (let bx = 0; bx + B <= W; bx += B) {
            let bg = true;
            let mv = 0, mf = 0;
            for (let y = by; y < by + B; y++)
                for (let x = bx; x < bx + B; x++) {
                    const i = y * W + x;
                    if (alpha[i] > 0.05) {
                        bg = false;
                        break;
                    }
                    mv += lumV[i];
                    mf += lumF[i];
                }
            if (!bg)
                continue;
            const n = B * B;
            mv /= n;
            mf /= n;
            let vv = 0, vf = 0;
            for (let y = by; y < by + B; y++)
                for (let x = bx; x < bx + B; x++) {
                    const i = y * W + x;
                    vv += (lumV[i] - mv) ** 2;
                    vf += (lumF[i] - mf) ** 2;
                }
            sV += Math.sqrt(vv / n);
            sF += Math.sqrt(vf / n);
            nb++;
        }
    }
    const bgContrast = sV > 0 && nb > 0 ? sF / sV : 1;
    return { detailRetention: detail, bgContrast, regMs, fuseMs };
}
//# sourceMappingURL=metrics.js.map