// float32 -> float16 转换(用于上传 R16F/RG16F 纹理,半浮点线性过滤是 WebGL2 核心能力)
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
export function toHalf(val) {
    _f32[0] = val;
    const x = _u32[0];
    const sign = (x >> 16) & 0x8000;
    let e = ((x >> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e <= 0)
        return sign; // 下溢 -> 0(本应用足够)
    if (e >= 31)
        return sign | 0x7bff; // 饱和
    return sign | (e << 10) | (m >> 13);
}
export function float32ToHalf(src) {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++)
        out[i] = toHalf(src[i]);
    return out;
}
//# sourceMappingURL=half.js.map