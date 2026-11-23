// 共享类型定义

/** 设备/部位标注框(可见光图像坐标,像素) */
export interface DeviceRegion {
  device: string;   // 设备名,如 "1号主变"
  part: string;     // 部位,如 "高压套管接线端子"
  x: number; y: number; w: number; h: number;
}

/** 一对红外+可见光图像 */
export interface ImagePair {
  id: string;
  name: string;
  visW: number; visH: number;
  vis: ImageData;          // 可见光
  irW: number; irH: number;
  irGray: ImageData;       // 红外灰度(显示用)
  temp: Float32Array;      // irW*irH,每像素温度 °C
  tempMin: number; tempMax: number;
  devices: DeviceRegion[];
  suggestedK1: number;     // 出厂标定的畸变系数建议值
  /** 样例真值(仅合成样例有):相机参数 + 深度图,用于验证配准精度 */
  truth?: { cam: { scale: number; rotDeg: number; txPx: number; tyPx: number; k1: number; parK: number }; depth: Float32Array };
}

/** 仿射:把红外相机坐标(高归一化)映射到可见光坐标(高归一化) */
export interface Affine {
  scale: number;   // 红外->可见光 缩放
  rot: number;     // 弧度
  tx: number; ty: number; // 高归一化平移
}

/** 配准结果 */
export interface Registration {
  affine: Affine;
  k1: number;
  gridW: number; gridH: number;
  /** 视差场:每节点 (dx,dy),可见光高归一化坐标下的位移,按可见光 uv 双线性采样 */
  field: Float32Array;
  score: number;
}

export interface Hotspot {
  id: number;
  maxTemp: number;
  avgTemp: number;
  areaPx: number;          // 红外分辨率下的像素数
  centroidIr: [number, number];
  boxVis: [number, number, number, number]; // x,y,w,h 可见光坐标
  centroidVis: [number, number];
  device: string;
  part: string;
  deltaT: number;          // 相对环境温升
  level: 1 | 2 | 3;        // 1 一般 2 严重 3 危急
}

export interface FusionParams {
  t0: number;      // 显色起点 °C
  t1: number;      // 显色终点 °C
  maxAlpha: number;
  palette: 'iron' | 'jet' | 'gray';
  fieldScale: number;
  view: number;    // 0 融合 1 可见光 2 红外 3 边缘
}

export interface Metrics {
  detailRetention: number; // 细节保持率(热区),目标 >= 0.9
  bgContrast: number;      // 低温背景对比度保持率,目标 >= 0.8
  regMs: number;
  fuseMs: number;
}
