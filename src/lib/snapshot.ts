import type { AnalysisResult, Circuit, Issue } from './engine/types';

/**
 * 对照快照：把某一时刻的电路与其求解摘要冻结为只读基准。
 * 快照随工程存入 IndexedDB（独立 store，key 为工程 id），
 * 重开工程后仍可与当前电路逐项对照。
 */

export interface SnapshotSummary {
  ok: boolean;
  /** 求解失败时保留诊断（绝不以 NaN 冒充） */
  issues: Issue[];
  /** 每个接点的电位：求解失败或节点无定义电位时为 null */
  nodeVoltage: { [nodeId: string]: number | null };
  /** 每根支路的量：i / absorbed 不唯一（零阻环自由分流）时为 null */
  branches: {
    [compId: string]: { va: number | null; vb: number | null; v: number | null; i: number | null; absorbed: number | null };
  };
}

export interface Snapshot {
  /** 所属工程 id */
  projectId: string;
  createdAt: number;
  /** 冻结时的电路深拷贝（只读基准，编辑当前电路不会改动它） */
  circuit: Circuit;
  /** 冻结时的求解摘要 */
  summary: SnapshotSummary;
}

/** 从分析结果中提取可持久化的求解摘要（丢弃矩阵等大对象） */
export function summarize(circuit: Circuit, result: AnalysisResult): SnapshotSummary {
  const nodeVoltage: { [nodeId: string]: number | null } = {};
  if (result.ok && result.netOf) {
    for (const n of circuit.nodes) {
      const net = result.netOf[n.id];
      const kcl = net === undefined ? undefined : result.netKcls.find((k) => k.netId === net);
      nodeVoltage[n.id] = kcl ? kcl.voltage : null;
    }
  } else {
    for (const n of circuit.nodes) nodeVoltage[n.id] = null;
  }
  const branches: SnapshotSummary['branches'] = {};
  if (result.ok) {
    for (const b of result.branches) {
      branches[b.compId] = {
        va: b.va,
        vb: b.vb,
        v: b.v,
        i: b.i,
        absorbed: b.absorbed,
      };
    }
  }
  return { ok: result.ok, issues: result.issues, nodeVoltage, branches };
}

export type SideStatus = 'ok' | 'unsolved' | 'missing';

export interface NumSide {
  /** 两侧数值都存在时给出 现在−基准；任一侧缺失则为 null（绝不用 NaN 冒充差值） */
  delta: number | null;
  base: number | null;
  now: number | null;
  baseStatus: SideStatus;
  nowStatus: SideStatus;
}

export type DiffStatus = 'same' | 'added' | 'removed' | 'changed';

export interface NodeDiff {
  kind: 'node';
  id: string;
  name: string;
  status: DiffStatus;
  voltage: NumSide;
  ground: { base: boolean; now: boolean };
}

export interface CompDiff {
  kind: 'comp';
  id: string;
  name: string;
  type: Circuit['comps'][number]['type'];
  status: DiffStatus;
  /** 元件参数（Ω/V/A，导线无）的变化 */
  value: NumSide;
  va: NumSide;
  vb: NumSide;
  v: NumSide;
  i: NumSide;
  power: NumSide;
  /** 端点引用的接点 id（删除/新增侧为 null） */
  terminals: {
    a: { base: string | null; now: string | null };
    b: { base: string | null; now: string | null };
  };
}

export interface SnapshotDiff {
  hasSnapshot: boolean;
  baseOk: boolean;
  nowOk: boolean;
  baseIssues: Issue[];
  nowIssues: Issue[];
  nodes: NodeDiff[];
  comps: CompDiff[];
  counts: { added: number; removed: number; changed: number; same: number };
}

/** 数值对照：任一输入为 null/undefined 时 delta 为 null，不产生 NaN */
function num(base: number | null | undefined, now: number | null | undefined): NumSide {
  const b = base ?? null;
  const n = now ?? null;
  let delta: number | null = null;
  if (b !== null && n !== null && Number.isFinite(b) && Number.isFinite(n)) delta = n - b;
  return {
    delta,
    base: b,
    now: n,
    baseStatus: b === null ? 'unsolved' : 'ok',
    nowStatus: n === null ? 'unsolved' : 'ok',
  };
}

const CHANGE_TOL = 1e-9;

/** 对照快照电路/摘要与当前电路/分析结果，按接点与元件列出变化 */
export function diffSnapshot(snap: Snapshot | null, current: Circuit, currentResult: AnalysisResult): SnapshotDiff {
  if (!snap) {
    return {
      hasSnapshot: false,
      baseOk: false,
      nowOk: currentResult.ok,
      baseIssues: [],
      nowIssues: currentResult.issues,
      nodes: [],
      comps: [],
      counts: { added: 0, removed: 0, changed: 0, same: 0 },
    };
  }

  const base = snap.circuit;
  const baseSum = snap.summary;
  const nowSum = summarize(current, currentResult);
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const nowNodes = new Map(current.nodes.map((n) => [n.id, n]));
  const baseComps = new Map(base.comps.map((c) => [c.id, c]));
  const nowComps = new Map(current.comps.map((c) => [c.id, c]));

  const nodes: NodeDiff[] = [];
  const comps: CompDiff[] = [];
  const counts = { added: 0, removed: 0, changed: 0, same: 0 };

  const classify = (deltas: (number | null)[], structuralChange: boolean): DiffStatus => {
    if (structuralChange) return 'changed';
    if (deltas.some((d) => d !== null && Math.abs(d) > CHANGE_TOL)) return 'changed';
    return 'same';
  };

  // ---- 接点：先基准顺序（被删除的仍保留在表中），再追加新增接点 ----
  for (const bn of base.nodes) {
    const nn = nowNodes.get(bn.id);
    const voltage = num(baseSum.nodeVoltage[bn.id], nn ? nowSum.nodeVoltage[nn.id] : undefined);
    const removed = !nn;
    if (removed) {
      voltage.nowStatus = 'missing';
    }
    const groundChange = nn ? bn.ground !== nn.ground : bn.ground !== false;
    const status: DiffStatus = removed ? 'removed' : classify([voltage.delta], groundChange);
    counts[status === 'same' ? 'same' : status]++;
    nodes.push({
      kind: 'node',
      id: bn.id,
      name: bn.name || bn.id,
      status,
      voltage,
      ground: { base: bn.ground, now: nn?.ground ?? false },
    });
  }
  for (const nn of current.nodes) {
    if (baseNodes.has(nn.id)) continue;
    const voltage = num(undefined, nowSum.nodeVoltage[nn.id]);
    voltage.baseStatus = 'missing';
    counts.added++;
    nodes.push({
      kind: 'node',
      id: nn.id,
      name: nn.name || nn.id,
      status: 'added',
      voltage,
      ground: { base: false, now: nn.ground },
    });
  }

  // ---- 元件 ----
  for (const bc of base.comps) {
    const nc = nowComps.get(bc.id);
    const bb = baseSum.branches[bc.id];
    const nb = nc ? nowSum.branches[nc.id] : undefined;
    const value = num(bc.type === 'wire' ? null : bc.value, nc ? (nc.type === 'wire' ? null : nc.value) : null);
    const va = num(bb?.va, nb?.va);
    const vb = num(bb?.vb, nb?.vb);
    const v = num(bb?.v, nb?.v);
    const i = num(bb?.i, nb?.i);
    const power = num(bb?.absorbed, nb?.absorbed);
    const removed = !nc;
    if (removed) {
      for (const s of [value, va, vb, v, i, power]) s.nowStatus = 'missing';
    }
    // 连接/类型变化也算 changed（a/b 换接、翻转极性会反映在 v/i 符号上）
    const structural = nc ? bc.type !== nc.type || bc.a !== nc.a || bc.b !== nc.b : true;
    const status: DiffStatus = removed
      ? 'removed'
      : classify([value.delta, va.delta, vb.delta, v.delta, i.delta, power.delta], structural);
    counts[status === 'same' ? 'same' : status]++;
    comps.push({
      kind: 'comp',
      id: bc.id,
      name: bc.name || bc.id,
      type: bc.type,
      status,
      value,
      va,
      vb,
      v,
      i,
      power,
      terminals: { a: { base: bc.a, now: nc?.a ?? null }, b: { base: bc.b, now: nc?.b ?? null } },
    });
  }
  for (const nc of current.comps) {
    if (baseComps.has(nc.id)) continue;
    const nb = nowSum.branches[nc.id];
    const value = num(undefined, nc.type === 'wire' ? null : nc.value);
    const va = num(undefined, nb?.va);
    const vb = num(undefined, nb?.vb);
    const v = num(undefined, nb?.v);
    const i = num(undefined, nb?.i);
    const power = num(undefined, nb?.absorbed);
    for (const s of [value, va, vb, v, i, power]) s.baseStatus = 'missing';
    counts.added++;
    comps.push({
      kind: 'comp',
      id: nc.id,
      name: nc.name || nc.id,
      type: nc.type,
      status: 'added',
      value,
      va,
      vb,
      v,
      i,
      power,
      terminals: { a: { base: null, now: nc.a }, b: { base: null, now: nc.b } },
    });
  }

  return {
    hasSnapshot: true,
    baseOk: baseSum.ok,
    nowOk: currentResult.ok,
    baseIssues: baseSum.issues,
    nowIssues: currentResult.issues,
    nodes,
    comps,
    counts,
  };
}
