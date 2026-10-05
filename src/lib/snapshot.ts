// 对照快照：把某时刻的电路与求解摘要存为只读基准，
// 之后与当前电路逐项（元件 / 接点）对比电位、电流、功率变化。
// 原则：任一侧不可解时保留其诊断、量值记 null，绝不用 NaN 冒充差值。

import type {
  AnalysisResult,
  Circuit,
  CompType,
  Snapshot,
  SnapshotBranch,
} from './engine/types';
import { uid } from './factory';

/** 数值是否“有变化”：相对/绝对混合容差 */
export function differs(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 拍照：从当前电路与求解结果生成只读基准（诊断中的 refs 解析为当时的名字） */
export function buildSnapshot(circuit: Circuit, result: AnalysisResult): Snapshot {
  const nodeName = (id: string) => circuit.nodes.find((n) => n.id === id)?.name ?? id;
  const refName = (id: string) =>
    circuit.comps.find((c) => c.id === id)?.name ?? nodeName(id);

  const voltageOf = (nodeId: string): number | null => {
    if (!result.ok || !result.netOf) return null;
    const net = result.netOf[nodeId];
    if (net === undefined) return null;
    if (net === result.groundNet) return 0;
    return result.netKcls.find((k) => k.netId === net)?.voltage ?? null;
  };

  const branches: SnapshotBranch[] = circuit.comps.map((c) => {
    const br = result.ok ? result.branches.find((b) => b.compId === c.id) : undefined;
    return {
      compId: c.id,
      name: c.name,
      type: c.type,
      value: c.value,
      aId: c.a,
      bId: c.b,
      aName: nodeName(c.a),
      bName: nodeName(c.b),
      va: br?.va ?? null,
      vb: br?.vb ?? null,
      v: br?.v ?? null,
      i: br?.i ?? null,
      absorbed: br?.absorbed ?? null,
      note: br?.note,
    };
  });

  return {
    id: uid('snap'),
    createdAt: Date.now(),
    circuitTitle: circuit.title,
    ok: result.ok,
    issues: result.issues.map((i) => ({
      kind: i.kind,
      code: i.code,
      message: i.message,
      detail: i.detail,
      refNames: i.refs.map(refName),
    })),
    nodes: circuit.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      ground: n.ground,
      voltage: voltageOf(n.id),
    })),
    branches,
    power:
      result.ok && result.power
        ? { totalAbsorbed: result.power.totalAbsorbed, relative: result.power.relative }
        : null,
  };
}

/** 某一侧（基准或当前）的支路量；null 表示该侧不可解 / 对象不存在 */
export interface BranchSide {
  va: number | null;
  vb: number | null;
  v: number | null;
  i: number | null;
  p: number | null;
  note?: string;
}

export type DiffStatus = 'changed' | 'same' | 'added' | 'removed';

export interface CompDiff {
  compId: string;
  name: string; // 当前名（已删除时为基准名）
  type: CompType;
  status: DiffStatus;
  /** 接线或极性变化（a/b 接点与拍照时不同） */
  connChanged: boolean;
  baseValue: number | null;
  curValue: number | null;
  baseEndpoints: string | null; // 形如 "n1→n2"
  curEndpoints: string | null;
  base: BranchSide | null;
  cur: BranchSide | null;
  flags: { value: boolean; v: boolean; i: boolean; p: boolean };
}

export interface NodeDiff {
  nodeId: string;
  name: string;
  status: DiffStatus;
  baseGround: boolean;
  curGround: boolean;
  baseV: number | null;
  curV: number | null;
}

export interface SnapshotDiff {
  baseOk: boolean;
  curOk: boolean;
  comps: CompDiff[];
  nodes: NodeDiff[];
  counts: { changed: number; added: number; removed: number; same: number };
  basePower: number | null; // Σ吸收功率（基准）
  curPower: number | null;
}

const STATUS_ORDER: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, same: 3 };

function sortRows<T extends { status: DiffStatus; name: string }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'zh-CN'),
  );
}

/** 对比：基准快照 × 当前电路 × 当前求解结果 */
export function computeDiff(
  snap: Snapshot,
  circuit: Circuit,
  result: AnalysisResult,
): SnapshotDiff {
  const nodeName = (id: string) => circuit.nodes.find((n) => n.id === id)?.name ?? id;

  const curBranch = new Map<string, BranchSide>();
  if (result.ok) {
    for (const b of result.branches) {
      curBranch.set(b.compId, { va: b.va, vb: b.vb, v: b.v, i: b.i, p: b.absorbed, note: b.note });
    }
  }
  const curVoltage = new Map<string, number>();
  if (result.ok && result.netOf) {
    for (const n of circuit.nodes) {
      const net = result.netOf[n.id];
      if (net === undefined) continue;
      const v =
        net === result.groundNet ? 0 : (result.netKcls.find((k) => k.netId === net)?.voltage ?? null);
      if (v !== null) curVoltage.set(n.id, v);
    }
  }

  // ---------- 元件 ----------
  const comps: CompDiff[] = [];
  const curById = new Map(circuit.comps.map((c) => [c.id, c]));
  const snapById = new Map(snap.branches.map((b) => [b.compId, b]));

  for (const sb of snap.branches) {
    const cur = curById.get(sb.compId);
    const base: BranchSide = { va: sb.va, vb: sb.vb, v: sb.v, i: sb.i, p: sb.absorbed, note: sb.note };
    if (!cur) {
      comps.push({
        compId: sb.compId,
        name: sb.name,
        type: sb.type,
        status: 'removed',
        connChanged: false,
        baseValue: sb.value,
        curValue: null,
        baseEndpoints: `${sb.aName}→${sb.bName}`,
        curEndpoints: null,
        base,
        cur: null,
        flags: { value: false, v: false, i: false, p: false },
      });
      continue;
    }
    const side = curBranch.get(sb.compId) ?? { va: null, vb: null, v: null, i: null, p: null };
    const flags = {
      value: differs(sb.value, cur.value),
      v: differs(base.v, side.v),
      i: differs(base.i, side.i),
      p: differs(base.p, side.p),
    };
    const connChanged = cur.a !== sb.aId || cur.b !== sb.bId;
    const changed = connChanged || flags.value || flags.v || flags.i || flags.p;
    comps.push({
      compId: sb.compId,
      name: cur.name,
      type: cur.type,
      status: changed ? 'changed' : 'same',
      connChanged,
      baseValue: sb.value,
      curValue: cur.value,
      baseEndpoints: `${sb.aName}→${sb.bName}`,
      curEndpoints: `${nodeName(cur.a)}→${nodeName(cur.b)}`,
      base,
      cur: side,
      flags,
    });
  }
  for (const c of circuit.comps) {
    if (snapById.has(c.id)) continue;
    comps.push({
      compId: c.id,
      name: c.name,
      type: c.type,
      status: 'added',
      connChanged: false,
      baseValue: null,
      curValue: c.value,
      baseEndpoints: null,
      curEndpoints: `${nodeName(c.a)}→${nodeName(c.b)}`,
      base: null,
      cur: curBranch.get(c.id) ?? { va: null, vb: null, v: null, i: null, p: null },
      flags: { value: false, v: false, i: false, p: false },
    });
  }

  // ---------- 接点 ----------
  const nodes: NodeDiff[] = [];
  const curNodeById = new Map(circuit.nodes.map((n) => [n.id, n]));
  const snapNodeById = new Map(snap.nodes.map((n) => [n.id, n]));
  for (const sn of snap.nodes) {
    const cur = curNodeById.get(sn.id);
    if (!cur) {
      nodes.push({
        nodeId: sn.id,
        name: sn.name,
        status: 'removed',
        baseGround: sn.ground,
        curGround: false,
        baseV: sn.voltage,
        curV: null,
      });
      continue;
    }
    const curV = curVoltage.get(sn.id) ?? null;
    const changed = differs(sn.voltage, curV) || sn.ground !== cur.ground;
    nodes.push({
      nodeId: sn.id,
      name: cur.name,
      status: changed ? 'changed' : 'same',
      baseGround: sn.ground,
      curGround: cur.ground,
      baseV: sn.voltage,
      curV,
    });
  }
  for (const n of circuit.nodes) {
    if (snapNodeById.has(n.id)) continue;
    nodes.push({
      nodeId: n.id,
      name: n.name,
      status: 'added',
      baseGround: false,
      curGround: n.ground,
      baseV: null,
      curV: curVoltage.get(n.id) ?? null,
    });
  }

  const counts = { changed: 0, added: 0, removed: 0, same: 0 };
  for (const r of [...comps, ...nodes]) counts[r.status]++;

  return {
    baseOk: snap.ok,
    curOk: result.ok,
    comps: sortRows(comps),
    nodes: sortRows(nodes),
    counts,
    basePower: snap.power?.totalAbsorbed ?? null,
    curPower: result.ok && result.power ? result.power.totalAbsorbed : null,
  };
}
