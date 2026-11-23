import { VS_QUAD, FS_EDGE, FS_SCORE, FS_FIELD, FS_FUSE } from './shaders.js';
import { float32ToHalf } from './half.js';
export const GRID_W = 24, GRID_H = 18;
function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
}
export function makePalette(name) {
    const out = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r = 0, g = 0, b = 0;
        if (name === 'iron') {
            r = Math.min(1, t * 2.2);
            g = Math.max(0, Math.min(1, (t - 0.33) * 2.4));
            b = Math.max(0, Math.min(1, (t - 0.7) * 3.2));
            if (t > 0.92) {
                g = Math.min(1, g + (t - 0.92) * 6);
                b = Math.min(1, b + (t - 0.92) * 6);
            }
        }
        else if (name === 'jet') {
            r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
            g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
            b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
        }
        else {
            r = g = b = t;
        }
        out[i * 4] = r * 255;
        out[i * 4 + 1] = g * 255;
        out[i * 4 + 2] = b * 255;
        out[i * 4 + 3] = 255;
    }
    return out;
}
export class Engine {
    canvas;
    gl;
    progs = {};
    uni = new Map();
    quad;
    canvasW = 0;
    canvasH = 0;
    visTex;
    tempTex; // 鲁棒归一化(边缘/配准用)
    tempFullTex; // 全量程归一化(融合叠加用)
    paletteTex;
    visEdge;
    irEdge;
    fieldA;
    fieldB;
    scoreT;
    pairW = 0;
    pairH = 0;
    irW = 0;
    irH = 0;
    /** 温度纹理归一化范围(鲁棒分位数,防止发热点把动态范围吃光) */
    tNormMin = 0;
    tNormMax = 1;
    /** 全量程范围(融合叠加的温度映射) */
    tFullMin = 0;
    tFullMax = 1;
    constructor(canvas) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
        if (!gl)
            throw new Error('需要 WebGL2 支持');
        if (!gl.getExtension('EXT_color_buffer_float'))
            throw new Error('需要 EXT_color_buffer_float 支持');
        this.gl = gl;
        this.progs.edge = this.link(VS_QUAD, FS_EDGE);
        this.progs.score = this.link(VS_QUAD, FS_SCORE);
        this.progs.field = this.link(VS_QUAD, FS_FIELD);
        this.progs.fuse = this.link(VS_QUAD, FS_FUSE);
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.paletteTex = this.makeTex(256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        this.setPalette('iron');
    }
    link(vs, fs) {
        const gl = this.gl;
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
            throw new Error('link: ' + gl.getProgramInfoLog(p));
        return p;
    }
    u(prog, name) {
        let m = this.uni.get(prog);
        if (!m) {
            m = new Map();
            this.uni.set(prog, m);
        }
        if (!m.has(name))
            m.set(name, this.gl.getUniformLocation(prog, name));
        return m.get(name);
    }
    makeTex(w, h, internal, format, type, filter) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }
    makeTarget(w, h, internal, format, type, mips = false) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
        gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('FBO 不完整');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fbo, w, h };
    }
    setPalette(name) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, makePalette(name));
    }
    loadPair(pair) {
        const gl = this.gl;
        this.pairW = pair.visW;
        this.pairH = pair.visH;
        this.irW = pair.irW;
        this.irH = pair.irH;
        if (this.canvas.width !== pair.visW || this.canvas.height !== pair.visH) {
            this.canvas.width = pair.visW;
            this.canvas.height = pair.visH;
        }
        // 不上传翻转:着色器内部统一使用图像坐标系(v=0 为顶行),与 CPU/生成器约定一致
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        this.visTex = this.makeTex(pair.visW, pair.visH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, this.visTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pair.visW, pair.visH, gl.RGBA, gl.UNSIGNED_BYTE, pair.vis);
        // 配准边缘用 p2/p98 鲁棒范围:否则热点峰值会把设备结构温差压进噪声
        const sorted = Float32Array.from(pair.temp);
        sorted.sort();
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        this.tNormMin = q(0.02);
        this.tNormMax = Math.max(q(0.98), this.tNormMin + 1);
        this.tFullMin = pair.tempMin;
        this.tFullMax = Math.max(pair.tempMax, pair.tempMin + 1);
        const uploadTemp = (lo, hi) => {
            const norm = new Float32Array(pair.temp.length);
            const span = hi - lo;
            for (let i = 0; i < pair.temp.length; i++) {
                norm[i] = Math.min(Math.max((pair.temp[i] - lo) / span, 0), 1);
            }
            const tex = this.makeTex(pair.irW, pair.irH, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pair.irW, pair.irH, gl.RED, gl.HALF_FLOAT, float32ToHalf(norm));
            return tex;
        };
        this.tempTex = uploadTemp(this.tNormMin, this.tNormMax);
        this.tempFullTex = uploadTemp(this.tFullMin, this.tFullMax);
        this.visEdge = this.makeTarget(pair.visW, pair.visH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, true);
        this.irEdge = this.makeTarget(pair.irW, pair.irH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, true);
        this.fieldA = this.makeTarget(GRID_W, GRID_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
        this.fieldB = this.makeTarget(GRID_W, GRID_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
        this.scoreT = this.makeTarget(64, 64, gl.RGBA32F, gl.RGBA, gl.FLOAT);
        this.runEdge(this.visTex, this.visEdge, 0);
        this.runEdge(this.tempTex, this.irEdge, 1);
        this.clearField();
    }
    clearField() {
        const gl = this.gl;
        for (const f of [this.fieldA, this.fieldB]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    runEdge(src, dst, mono) {
        const gl = this.gl, p = this.progs.edge;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.useProgram(p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(this.u(p, 'uTex'), 0);
        gl.uniform2f(this.u(p, 'uTexel'), 1 / dst.w, 1 / dst.h);
        gl.uniform1i(this.u(p, 'uMono'), mono);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, dst.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
    }
    /** 全局参数搜索:在 scoreT 上渲染 outW×outH 个候选并读回;lod 控制边缘图金字塔层级(粗->细) */
    scoreSlice(mode, t, scale, rot, k1, step, outW, outH, lod) {
        const gl = this.gl, p = this.progs.score;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scoreT.fbo);
        gl.viewport(0, 0, outW, outH);
        gl.useProgram(p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.visEdge.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.irEdge.tex);
        gl.uniform1i(this.u(p, 'uVisEdge'), 0);
        gl.uniform1i(this.u(p, 'uIrEdge'), 1);
        gl.uniform2f(this.u(p, 'uVisSize'), this.pairW, this.pairH);
        gl.uniform2f(this.u(p, 'uIrSize'), this.irW, this.irH);
        gl.uniform1i(this.u(p, 'uMode'), mode);
        gl.uniform2f(this.u(p, 'uT'), t[0], t[1]);
        gl.uniform1f(this.u(p, 'uScale'), scale);
        gl.uniform1f(this.u(p, 'uRot'), rot);
        gl.uniform1f(this.u(p, 'uK1'), k1);
        gl.uniform2f(this.u(p, 'uStep'), step[0], step[1]);
        gl.uniform2f(this.u(p, 'uOutSize'), outW, outH);
        gl.uniform1f(this.u(p, 'uLod'), lod);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const out = new Float32Array(outW * outH * 4);
        gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.FLOAT, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        return out;
    }
    /** 视差场计算(可基于上一轮的场迭代细化) */
    computeField(reg, useBase, range, step, win) {
        const gl = this.gl, p = this.progs.field;
        const src = this.fieldA, dst = this.fieldB;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, GRID_W, GRID_H);
        gl.useProgram(p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.visEdge.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.irEdge.tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform1i(this.u(p, 'uVisEdge'), 0);
        gl.uniform1i(this.u(p, 'uIrEdge'), 1);
        gl.uniform1i(this.u(p, 'uBaseField'), 2);
        gl.uniform1i(this.u(p, 'uUseBase'), useBase ? 1 : 0);
        gl.uniform2f(this.u(p, 'uGrid'), GRID_W, GRID_H);
        gl.uniform2f(this.u(p, 'uVisSize'), this.pairW, this.pairH);
        gl.uniform2f(this.u(p, 'uIrSize'), this.irW, this.irH);
        gl.uniform2f(this.u(p, 'uT'), reg.affine.tx, reg.affine.ty);
        gl.uniform1f(this.u(p, 'uScale'), reg.affine.scale);
        gl.uniform1f(this.u(p, 'uRot'), reg.affine.rot);
        gl.uniform1f(this.u(p, 'uK1'), reg.k1);
        gl.uniform1f(this.u(p, 'uRange'), range);
        gl.uniform1f(this.u(p, 'uStep'), step);
        gl.uniform1f(this.u(p, 'uWin'), win);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // 交换:结果始终留在 fieldA
        const t = this.fieldA;
        this.fieldA = this.fieldB;
        this.fieldB = t;
        gl.activeTexture(gl.TEXTURE0);
    }
    readField() {
        const gl = this.gl;
        const out = new Float32Array(GRID_W * GRID_H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldA.fbo);
        gl.readPixels(0, 0, GRID_W, GRID_H, gl.RGBA, gl.FLOAT, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return out;
    }
    /** 把 CPU 侧处理过的视差场写回 GPU(融合渲染使用) */
    uploadField(field) {
        const gl = this.gl;
        const rgba = new Float32Array(GRID_W * GRID_H * 4);
        for (let i = 0; i < GRID_W * GRID_H; i++) {
            rgba[i * 4] = field[i * 2];
            rgba[i * 4 + 1] = field[i * 2 + 1];
        }
        const half = float32ToHalf(rgba);
        gl.bindTexture(gl.TEXTURE_2D, this.fieldA.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID_W, GRID_H, gl.RGBA, gl.HALF_FLOAT, half);
    }
    /** 融合渲染到画布 */
    render(reg, params) {
        const gl = this.gl, p = this.progs.fuse;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(p);
        const bind = (unit, tex, name) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(this.u(p, name), unit);
        };
        bind(0, this.visTex, 'uVis');
        bind(1, this.tempFullTex, 'uTemp');
        bind(2, this.fieldA.tex, 'uField');
        bind(3, this.paletteTex, 'uPalette');
        bind(4, this.visEdge.tex, 'uVisEdge');
        bind(5, this.irEdge.tex, 'uIrEdge');
        gl.uniform2f(this.u(p, 'uVisSize'), this.pairW, this.pairH);
        gl.uniform2f(this.u(p, 'uIrSize'), this.irW, this.irH);
        gl.uniform2f(this.u(p, 'uT'), reg.affine.tx, reg.affine.ty);
        gl.uniform1f(this.u(p, 'uScale'), reg.affine.scale);
        gl.uniform1f(this.u(p, 'uRot'), reg.affine.rot);
        gl.uniform1f(this.u(p, 'uK1'), reg.k1);
        gl.uniform1f(this.u(p, 'uFieldScale'), params.fieldScale);
        const span = this.tFullMax - this.tFullMin;
        gl.uniform1f(this.u(p, 'uT0n'), (params.t0 - this.tFullMin) / span);
        gl.uniform1f(this.u(p, 'uT1n'), (params.t1 - this.tFullMin) / span);
        gl.uniform1f(this.u(p, 'uMaxAlpha'), params.maxAlpha);
        gl.uniform1i(this.u(p, 'uView'), params.view);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0);
    }
    /** 读回画布像素(已翻转为顶行优先) */
    readCanvas() {
        const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
        const raw = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const out = new Uint8Array(w * h * 4);
        const row = w * 4;
        for (let y = 0; y < h; y++)
            out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        return out;
    }
}
//# sourceMappingURL=engine.js.map