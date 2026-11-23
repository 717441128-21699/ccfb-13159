import { irPxToVisPx } from './registration.js';
export function ambientTemp(temp) {
    const sample = [];
    const stride = Math.max(1, Math.floor(temp.length / 5000));
    for (let i = 0; i < temp.length; i += stride)
        sample.push(temp[i]);
    sample.sort((a, b) => a - b);
    return sample[Math.floor(sample.length / 2)];
}
export function detectHotspots(pair, reg, fieldScale = 1) {
    const { irW: W, irH: H, temp } = pair;
    const amb = ambientTemp(temp);
    const thresh = amb + 14;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < temp.length; i++)
        if (temp[i] >= thresh)
            mask[i] = 1;
    const seen = new Uint8Array(W * H);
    const spots = [];
    const sizes = { visW: pair.visW, visH: pair.visH, irW: W, irH: H };
    let id = 0;
    for (let start = 0; start < W * H; start++) {
        if (!mask[start] || seen[start])
            continue;
        // BFS 连通域
        const stack = [start];
        seen[start] = 1;
        const px = [];
        let maxT = -Infinity, sumT = 0, sumX = 0, sumY = 0;
        let minX = W, maxX = 0, minY = H, maxY = 0;
        while (stack.length) {
            const i = stack.pop();
            px.push(i);
            const x = i % W, y = (i / W) | 0;
            const t = temp[i];
            sumT += t;
            sumX += x;
            sumY += y;
            if (t > maxT)
                maxT = t;
            if (x < minX)
                minX = x;
            if (x > maxX)
                maxX = x;
            if (y < minY)
                minY = y;
            if (y > maxY)
                maxY = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H)
                    continue;
                const ni = ny * W + nx;
                if (mask[ni] && !seen[ni]) {
                    seen[ni] = 1;
                    stack.push(ni);
                }
            }
        }
        if (px.length < 6)
            continue; // 滤掉噪点
        // 映射到可见光坐标(包围盒四角 + 质心)
        const corners = [
            irPxToVisPx(minX, minY, reg, sizes, fieldScale),
            irPxToVisPx(maxX, minY, reg, sizes, fieldScale),
            irPxToVisPx(minX, maxY, reg, sizes, fieldScale),
            irPxToVisPx(maxX, maxY, reg, sizes, fieldScale),
        ];
        const cxIr = sumX / px.length, cyIr = sumY / px.length;
        const [cvx, cvy] = irPxToVisPx(cxIr, cyIr, reg, sizes, fieldScale);
        const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
        const bx = Math.min(...xs), by = Math.min(...ys);
        const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
        // 匹配设备部位:优先包含质心的最小框,其次最近框
        let device = '未标注设备', part = '';
        let bestArea = Infinity;
        for (const d of pair.devices) {
            if (cvx >= d.x && cvx <= d.x + d.w && cvy >= d.y && cvy <= d.y + d.h) {
                const area = d.w * d.h;
                if (area < bestArea) {
                    bestArea = area;
                    device = d.device;
                    part = d.part;
                }
            }
        }
        if (bestArea === Infinity && pair.devices.length) {
            let bestD = Infinity;
            for (const d of pair.devices) {
                const dx = Math.max(d.x - cvx, 0, cvx - (d.x + d.w));
                const dy = Math.max(d.y - cvy, 0, cvy - (d.y + d.h));
                const dist = Math.hypot(dx, dy);
                if (dist < bestD && dist < 60) {
                    bestD = dist;
                    device = d.device;
                    part = d.part + '(邻近)';
                }
            }
        }
        const deltaT = maxT - amb;
        const level = deltaT >= 40 || maxT >= 90 ? 3 : deltaT >= 20 ? 2 : 1;
        spots.push({
            id: ++id, maxTemp: maxT, avgTemp: sumT / px.length, areaPx: px.length,
            centroidIr: [cxIr, cyIr], boxVis: [bx, by, bw, bh], centroidVis: [cvx, cvy],
            device, part, deltaT, level: level,
        });
    }
    spots.sort((a, b) => b.maxTemp - a.maxTemp);
    spots.forEach((s, i) => s.id = i + 1);
    return spots;
}
//# sourceMappingURL=hotspots.js.map