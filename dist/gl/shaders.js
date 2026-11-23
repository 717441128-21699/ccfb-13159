// 所有 GLSL 着色器源码
export const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;
// 边缘提取:Sobel 分方向梯度,输出 R=水平边缘(|gy|) G=垂直边缘(|gx|) B=亮度
// 分方向是为了让延伸结构(长杆/长母线)只在其正交方向提供约束,避免虚假平移不变性
export const FS_EDGE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform int uMono; // 1: 单通道(温度)纹理
float lum(vec2 uv){
  vec3 c = texture(uTex, uv).rgb;
  return uMono == 1 ? c.r : dot(c, vec3(0.299, 0.587, 0.114));
}
void main(){
  // 单通道(温度)用 2 像素核抑制 NETD 噪声
  vec2 tx = uTexel * (uMono == 1 ? 2.0 : 1.0);
  float gx = lum(vUv + vec2(tx.x, 0.0)) - lum(vUv - vec2(tx.x, 0.0));
  float gy = lum(vUv + vec2(0.0, tx.y)) - lum(vUv - vec2(0.0, tx.y));
  float l = lum(vUv);
  // 压缩非线性:热点环等强边饱和,弱结构边相对提升
  float eh = abs(gy) * 2.5; eh = eh / (eh + 0.15);
  float ev = abs(gx) * 2.5; ev = ev / (ev + 0.15);
  vec2 b = smoothstep(0.0, 0.03, vUv) * smoothstep(0.0, 0.03, 1.0 - vUv);
  o = vec4(eh * b.x * b.y, ev * b.x * b.y, l, 1.0);
}
`;
// 公共函数:坐标映射(可见光高归一化 -> 红外 uv),参数显式传入便于候选搜索
export const GLSL_MAP = `
uniform vec2 uVisSize;
uniform vec2 uIrSize;
vec2 undistort(vec2 c, float k1){
  vec2 d = c;
  for(int i = 0; i < 4; i++){ d = c / (1.0 + k1 * dot(d, d)); }
  return d;
}
// cv: 可见光高归一化坐标; t/s/rot: 红外->可见光仿射的逆推参数; k1: 径向畸变
vec2 visToIrUv(vec2 cv, vec2 t, float s, float rot, float k1){
  vec2 p = cv - t;
  float cs = cos(-rot), sn = sin(-rot);
  // 注意 mat2 为列主序:mat2(cs,sn,-sn,cs) 才是 R(-rot)
  p = mat2(cs, sn, -sn, cs) * p / s;
  p = undistort(p, k1);
  return vec2(p.x * uIrSize.y / uIrSize.x + 0.5, p.y + 0.5);
}
vec2 visUvToC(vec2 uv){
  return vec2((uv.x - 0.5) * uVisSize.x / uVisSize.y, uv.y - 0.5);
}
`;
// 全局配准评分:输出纹理每个像素对应一个候选参数,值为边缘归一化相关
// uMode 0: (i,j) = 平移偏移; 1: (i,j) = (缩放偏移, 旋转偏移)
export const FS_SCORE = `#version 300 es
precision highp float;
uniform sampler2D uVisEdge;
uniform sampler2D uIrEdge;
${GLSL_MAP}
uniform float uScale;
uniform float uRot;
uniform float uK1;
uniform vec2 uT;
uniform int uMode;
uniform vec2 uStep;
uniform vec2 uOutSize;
uniform float uLod;  // 边缘金字塔层级:粗搜索用高层(模糊)避免周期性结构误匹配
out vec4 o;
void main(){
  vec2 idx = gl_FragCoord.xy - 0.5;
  vec2 t = uT; float s = uScale; float rot = uRot;
  vec2 ctr = (uOutSize - 1.0) * 0.5;
  if(uMode == 0){ t += (idx - ctr) * uStep; }
  else { s += (idx.x - ctr.x) * uStep.x; rot += (idx.y - ctr.y) * uStep.y; }
  // 结构加权 MI + 分方向 Dice:
  // MI(B 通道亮度)适配非线性强度关系;Dice 按水平/垂直边缘分别计算——
  // 长杆/母线等延伸结构只在正交方向提供约束,杜绝沿轴虚假平移最优。
  float hist[64];
  for(int i = 0; i < 64; i++) hist[i] = 0.0;
  float svH = 0.0, siH = 0.0, sviH = 0.0;
  float svV = 0.0, siV = 0.0, sviV = 0.0;
  float wsum = 0.0;
  float edgeLod = min(uLod + 1.5, 3.0);
  const int N = 20;
  for(int yy = 0; yy < N; yy++){
    for(int xx = 0; xx < N; xx++){
      vec2 uv = (vec2(float(xx), float(yy)) + 0.5) / float(N);
      vec3 ae = textureLod(uVisEdge, uv, edgeLod).rgb;
      float w = smoothstep(0.08, 0.3, ae.r + ae.g) + 0.002;
      vec2 iuv = visToIrUv(visUvToC(uv), t, s, rot, uK1);
      vec3 be = textureLod(uIrEdge, iuv, edgeLod).rgb;
      float gv = textureLod(uVisEdge, uv, uLod).b;
      float gi = textureLod(uIrEdge, iuv, uLod).b;
      int ia = int(clamp(gv, 0.0, 0.999) * 8.0);
      int ib = int(clamp(gi, 0.0, 0.999) * 8.0);
      hist[ia * 8 + ib] += w;
      svH += w * ae.r; siH += w * be.r; sviH += w * ae.r * be.r;
      svV += w * ae.g; siV += w * be.g; sviV += w * ae.g * be.g;
      wsum += w;
    }
  }
  float mi = 0.0;
  for(int i = 0; i < 8; i++){
    for(int j = 0; j < 8; j++){
      float pij = hist[i * 8 + j] / wsum;
      if(pij <= 0.0) continue;
      float pi = 0.0, pj = 0.0;
      for(int k = 0; k < 8; k++){ pi += hist[i * 8 + k]; pj += hist[k * 8 + j]; }
      mi += pij * log(pij * wsum * wsum / (pi * pj));
    }
  }
  float dice = 2.0 * sviH / (svH + siH + 1e-6) + 2.0 * sviV / (svV + siV + 1e-6);
  o = vec4(mi + 1.5 * dice, mi, dice, 1.0); // G/B 通道单独输出 MI/Dice 便于诊断
}
`;
// 局部视差场:每个网格节点在候选位移中做窗口 NCC,输出最佳位移
export const FS_FIELD = `#version 300 es
precision highp float;
uniform sampler2D uVisEdge;
uniform sampler2D uIrEdge;
uniform sampler2D uBaseField;
uniform int uUseBase;
uniform vec2 uGrid;
uniform float uRange;  // 搜索半径(高归一化)
uniform float uStep;   // 步长
uniform float uWin;    // 窗口半宽
uniform float uScale;
uniform float uRot;
uniform float uK1;
uniform vec2 uT;
${GLSL_MAP}
out vec4 o;
void main(){
  vec2 node = gl_FragCoord.xy - 0.5;
  vec2 uv = (node + 0.5) / uGrid;
  vec2 cv0 = visUvToC(uv);
  vec2 base = uUseBase == 1 ? texture(uBaseField, uv).rg : vec2(0.0);
  float best = -2.0;
  vec2 bestD = base;
  for(int iy = -8; iy <= 8; iy++){
    float fy = float(iy) * uStep;
    if(abs(fy) > uRange + 1e-6) continue;
    for(int ix = -8; ix <= 8; ix++){
      float fx = float(ix) * uStep;
      if(abs(fx) > uRange + 1e-6) continue;
      vec2 d = base + vec2(fx, fy);
      float sv = 0.0, si = 0.0, svv = 0.0, sii = 0.0, svi = 0.0;
      for(int wy = 0; wy < 5; wy++){
        for(int wx = 0; wx < 5; wx++){
          vec2 off = (vec2(float(wx), float(wy)) - 2.0) * (uWin * 0.5);
          vec2 cv = cv0 + off;
          vec2 uv2 = vec2(cv.x * uVisSize.y / uVisSize.x + 0.5, cv.y + 0.5);
          // 模糊尺度采样,容忍两模态边缘宽度差;R+G 为总边缘强度
          float ev = dot(textureLod(uVisEdge, uv2, 1.5).rg, vec2(1.0));
          float ei = dot(textureLod(uIrEdge, visToIrUv(cv - d, uT, uScale, uRot, uK1), 1.5).rg, vec2(1.0));
          sv += ev; si += ei; svv += ev * ev; sii += ei * ei; svi += ev * ei;
        }
      }
      float n = 25.0;
      float cov = svi - sv * si / n;
      float den = sqrt(max((svv - sv * sv / n) * (sii - si * si / n), 0.0)) + 1e-6;
      float ncc = cov / den;
      if(ncc > best){ best = ncc; bestD = d; }
    }
  }
  o = vec4(bestD, 0.0, best);
}
`;
// 融合渲染
export const FS_FUSE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uVis;
uniform sampler2D uTemp;    // 归一化温度
uniform sampler2D uField;
uniform sampler2D uPalette;
uniform sampler2D uVisEdge;
uniform sampler2D uIrEdge;
uniform float uFieldScale;
uniform float uT0n;   // 归一化显色起点
uniform float uT1n;   // 归一化显色终点
uniform float uMaxAlpha;
uniform int uView;    // 0 融合 1 可见光 2 红外 3 边缘
uniform float uScale;
uniform float uRot;
uniform float uK1;
uniform vec2 uT;
${GLSL_MAP}
void main(){
  // 统一图像坐标系:uv.y=0 为图像顶行(画布上方),与 CPU 侧一致
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 vis = texture(uVis, uv).rgb;
  vec2 cv = visUvToC(uv);
  vec2 fld = texture(uField, uv).rg * uFieldScale;
  vec2 iuv = visToIrUv(cv - fld, uT, uScale, uRot, uK1);
  float inRange = step(0.0, iuv.x) * step(iuv.x, 1.0) * step(0.0, iuv.y) * step(iuv.y, 1.0);
  float tn = texture(uTemp, iuv).r * inRange;
  vec3 pal = texture(uPalette, vec2(clamp(tn, 0.0, 1.0), 0.5)).rgb;
  if(uView == 1){ o = vec4(vis, 1.0); return; }
  if(uView == 2){ o = vec4(pal, 1.0); return; }
  if(uView == 4){ o = vec4(iuv, 0.0, 1.0); return; } // 调试:输出映射坐标
  if(uView == 3){
    float ev = dot(texture(uVisEdge, uv).rg, vec2(1.0));
    float ei = dot(texture(uIrEdge, iuv).rg, vec2(1.0));
    vec3 c = vis * 0.25 + vec3(0.0, ev, 0.0) + vec3(ei, 0.0, ei);
    o = vec4(c, 1.0); return;
  }
  float alpha = smoothstep(uT0n, uT1n, tn) * uMaxAlpha * inRange;
  float lum = dot(vis, vec3(0.299, 0.587, 0.114));
  // 伪彩用可见光亮度调制:高温醒目,同时保住绝缘子伞裙/螺栓的明暗纹理
  vec3 hot = pal * (0.30 + 1.05 * lum);
  o = vec4(mix(vis, hot, alpha), 1.0);
}
`;
//# sourceMappingURL=shaders.js.map