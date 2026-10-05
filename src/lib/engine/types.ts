// 电路数据模型与分析结果类型定义

export type CompType = 'R' | 'V' | 'I' | 'wire';

/** 二端元件：参考方向 a → b（电流正方向）。V 型元件 a 端为 + 极。 */
export interface Comp {
  id: string;
  type: CompType;
  name: string;
  a: string; // 正参考端 / 电流流出约定端（见各类型）
  b: string;
  value: number; // R: 欧姆, V: 伏特, I: 安培
  /** 图元位置：沿 a→b 的参数 t 及法向偏移（拖动图形不改连接） */
  t: number;
  offset: number;
}

export interface Node {
  id: string;
  name: string;
  x: number;
  y: number;
  ground: boolean; // 参考地由用户显式设置，全电路至多一个
}

export interface Circuit {
  id: string;
  title: string;
  nodes: Node[];
  comps: Comp[];
  updatedAt: number;
  /** 对照快照（只读基准）：随工程一起存入 IndexedDB；null/缺省表示未拍快照 */
  snapshot?: Snapshot | null;
}

/** 快照中保留的诊断（refs 已在拍照时解析为名字，快照是只读的） */
export interface SnapshotIssue {
  kind: IssueKind;
  code: string;
  message: string;
  detail?: string;
  refNames: string[];
}

export interface SnapshotNode {
  id: string;
  name: string;
  ground: boolean;
  /** 拍照时的节点电位；当时不可解则为 null（不以 NaN 冒充） */
  voltage: number | null;
}

export interface SnapshotBranch {
  compId: string;
  name: string;
  type: CompType;
  value: number;
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  va: number | null;
  vb: number | null;
  v: number | null;
  i: number | null; // 零阻支路电流不唯一时为 null
  absorbed: number | null;
  note?: string;
}

/** 对照快照：某一时刻的电路身份信息与求解摘要（只读基准） */
export interface Snapshot {
  id: string;
  createdAt: number;
  circuitTitle: string;
  ok: boolean; // 拍照时是否求解成功
  issues: SnapshotIssue[]; // 拍照时的诊断（求解失败时完整保留）
  nodes: SnapshotNode[];
  branches: SnapshotBranch[];
  power: { totalAbsorbed: number; relative: number } | null;
}

export type IssueKind = 'error' | 'warning' | 'ok';

/** 诊断信息：每条都可追到具体元件/节点/矩阵行 */
export interface Issue {
  kind: IssueKind;
  code:
    | 'EMPTY'
    | 'NO_GROUND'
    | 'MULTI_GROUND'
    | 'DANGLING'
    | 'BAD_VALUE'
    | 'ISOLATED'
    | 'FLOATING'
    | 'VSOURCE_LOOP'
    | 'REDUNDANT_VLOOP'
    | 'ICUTSET'
    | 'SINGULAR'
    | 'RESIDUAL'
    | 'POWER'
    | 'SHORTED_I'
    | 'CROSSED_NO_JUNCTION';
  message: string;
  detail?: string;
  refs: string[]; // 关联元件 / 节点 / 方程 id
}

export interface VarInfo {
  id: string; // 矩阵变量 id
  label: string; // 显示名，如 V(n2)、I(V1)
  kind: 'node' | 'vsource';
  refId: string; // 对应 net 或 comp id
}

export interface RowInfo {
  id: string;
  kind: 'kcl' | 'vsource';
  /** 该方程主要关联的元件（行溯源） */
  refId?: string;
  label: string;
}

/** 单元格溯源：每个矩阵系数由哪些元件贡献 */
export interface Trace {
  [rowIndex: number]: { [colIndex: number]: { compId: string; weight: number }[] };
}

export interface BranchResult {
  compId: string;
  va: number; // a 端电位
  vb: number;
  v: number; // va - vb
  i: number | null; // 参考方向 a → b；零阻支路/自由变量时为 null
  absorbed: number | null; // 吸收功率（无源符号约定，正=吸收）
  note?: string;
}

export interface NetKcl {
  netId: number;
  nodeIds: string[];
  voltage: number | null;
  residual: number;
  scale: number;
  /** 该超节点上存在电流不唯一的零阻支路时，KCL 无法逐支路核对 */
  indeterminate: boolean;
}

export interface PowerSummary {
  totalAbsorbed: number;
  delivered: { compId: string; name: string; watts: number }[];
  absorbed: { compId: string; name: string; watts: number }[];
  residual: number; // Σ吸收（应≈0）
  relative: number;
}

export interface AnalysisResult {
  ok: boolean;
  issues: Issue[];
  /** 求解成功（允许带 warning）时的变量值 */
  x: number[] | null;
  vars: VarInfo[];
  rows: RowInfo[];
  A: number[][] | null;
  z: number[] | null;
  trace: Trace | null;
  /** 右端项溯源：每行 z 值由哪些电流源贡献 */
  rhsTrace: { [rowIndex: number]: { compId: string; weight: number }[] } | null;
  netOf: { [nodeId: string]: number } | null;
  netNodeIds: string[][] | null;
  groundNet: number | null;
  branches: BranchResult[];
  netKcls: NetKcl[];
  power: PowerSummary | null;
}
