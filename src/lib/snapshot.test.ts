// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { analyze } from './engine/analyze';
import type { Circuit, Comp } from './engine/types';
import { buildSnapshot, computeDiff, differs } from './snapshot';
import { createWorkbench } from './store.svelte';
import { storage } from './storage';

/** 分压器：V1(p→g)=10V，R1(p→m)，R2(m→g) */
const divider = (r1 = 2000, r2 = 3000): Circuit => ({
  id: 'div',
  title: '分压器',
  updatedAt: 0,
  nodes: [
    { id: 'g', name: 'GND', x: 0, y: 0, ground: true },
    { id: 'p', name: 'p', x: 0, y: 100, ground: false },
    { id: 'm', name: 'm', x: 100, y: 100, ground: false },
  ],
  comps: [
    { id: 'V1', type: 'V', name: 'V1', a: 'p', b: 'g', value: 10, t: 0.5, offset: 0 },
    { id: 'R1', type: 'R', name: 'R1', a: 'p', b: 'm', value: r1, t: 0.5, offset: 0 },
    { id: 'R2', type: 'R', name: 'R2', a: 'm', b: 'g', value: r2, t: 0.5, offset: 0 },
  ],
});

const compDiff = (d: ReturnType<typeof computeDiff>, id: string) =>
  d.comps.find((c) => c.compId === id)!;
const nodeDiff = (d: ReturnType<typeof computeDiff>, id: string) =>
  d.nodes.find((n) => n.nodeId === id)!;

describe('对照快照：拍照与差值', () => {
  it('differs 的容差与 null 语义', () => {
    expect(differs(1, 1 + 1e-12)).toBe(false);
    expect(differs(1, 1.1)).toBe(true);
    expect(differs(null, null)).toBe(false);
    expect(differs(1, null)).toBe(true);
    expect(differs(null, 2)).toBe(true);
  });

  it('快照保存电路身份与求解摘要（电位/电流/功率）', () => {
    const c = divider();
    const snap = buildSnapshot(c, analyze(c));
    expect(snap.ok).toBe(true);
    expect(snap.branches).toHaveLength(3);
    expect(snap.nodes).toHaveLength(3);
    const m = snap.nodes.find((n) => n.id === 'm')!;
    expect(m.voltage).toBeCloseTo(6, 9);
    const r1 = snap.branches.find((b) => b.compId === 'R1')!;
    expect(r1.v).toBeCloseTo(4, 9);
    expect(r1.i).toBeCloseTo(0.002, 9);
    expect(r1.absorbed).toBeCloseTo(0.008, 9);
    expect(r1.aName).toBe('p');
    expect(snap.power!.totalAbsorbed).toBeCloseTo(0, 9);
  });

  it('验收1：只改一个电阻后，相关支路与接点的差值可见', () => {
    const before = divider();
    const snap = buildSnapshot(before, analyze(before));
    const after = divider(1000); // R1: 2k → 1k
    const d = computeDiff(snap, after, analyze(after));

    const r1 = compDiff(d, 'R1');
    expect(r1.status).toBe('changed');
    expect(r1.flags.value).toBe(true);
    expect(r1.baseValue).toBe(2000);
    expect(r1.curValue).toBe(1000);
    // V(R1): 4V → 2.5V；I: 2mA → 2.5mA
    expect(r1.base!.v).toBeCloseTo(4, 9);
    expect(r1.cur!.v).toBeCloseTo(2.5, 9);
    expect(r1.cur!.v! - r1.base!.v!).toBeCloseTo(-1.5, 9);
    expect(r1.cur!.i! - r1.base!.i!).toBeCloseTo(0.0005, 9);

    // 中点电位 6V → 7.5V
    const m = nodeDiff(d, 'm');
    expect(m.status).toBe('changed');
    expect(m.baseV).toBeCloseTo(6, 9);
    expect(m.curV).toBeCloseTo(7.5, 9);

    // 未受影响的量保持 same：参考地电位、源端电压
    expect(nodeDiff(d, 'g').status).toBe('same');
    expect(compDiff(d, 'V1').flags.v).toBe(false);
    expect(d.counts.changed).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain('NaN');
  });

  it('验收2：删除元件后单独标识，基准中的值仍可查看', () => {
    const before = divider();
    const snap = buildSnapshot(before, analyze(before));
    const after = divider();
    after.comps = after.comps.filter((c) => c.id !== 'R2');
    const d = computeDiff(snap, after, analyze(after));

    const r2 = compDiff(d, 'R2');
    expect(r2.status).toBe('removed');
    expect(r2.cur).toBeNull();
    // 基准值完整保留
    expect(r2.base!.v).toBeCloseTo(6, 9);
    expect(r2.base!.i).toBeCloseTo(0.002, 9);
    expect(r2.base!.p).toBeCloseTo(0.012, 9);
    expect(r2.baseValue).toBe(3000);
    expect(d.counts.removed).toBe(1);
  });

  it('新增元件单独标识，只有当前侧有值', () => {
    const before = divider();
    const snap = buildSnapshot(before, analyze(before));
    const after = divider();
    after.comps.push({
      id: 'R3',
      type: 'R',
      name: 'R3',
      a: 'm',
      b: 'g',
      value: 6000,
      t: 0.5,
      offset: 40,
    } as Comp);
    const d = computeDiff(snap, after, analyze(after));
    const r3 = compDiff(d, 'R3');
    expect(r3.status).toBe('added');
    expect(r3.base).toBeNull();
    // 3k ∥ 6k = 2k → Vm 变为 5V，I(R3) = 5/6000
    expect(r3.cur!.i).toBeCloseTo(5 / 6000, 9);
    expect(d.counts.added).toBe(1);
  });

  it('当前侧不可解：保留诊断，当前量值为 null 而非 NaN', () => {
    const before = divider();
    const snap = buildSnapshot(before, analyze(before));
    const after = divider();
    // 再加一个 5V 理想电压源直接并在 p-g 上 → 与 V1=10V 矛盾
    after.comps.push({
      id: 'V2',
      type: 'V',
      name: 'V2',
      a: 'p',
      b: 'g',
      value: 5,
      t: 0.5,
      offset: -60,
    } as Comp);
    const res = analyze(after);
    expect(res.ok).toBe(false);
    const d = computeDiff(snap, after, res);

    expect(d.curOk).toBe(false);
    expect(d.baseOk).toBe(true);
    // 基准值仍在，当前侧全为 null
    const r1 = compDiff(d, 'R1');
    expect(r1.base!.v).toBeCloseTo(4, 9);
    expect(r1.cur!.v).toBeNull();
    expect(r1.cur!.i).toBeNull();
    expect(nodeDiff(d, 'm').curV).toBeNull();
    // 不用 NaN 冒充差值
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);
  });

  it('基准侧不可解：诊断随快照保留，refs 解析为当时名字', () => {
    const bad = divider();
    bad.comps.push({
      id: 'V2',
      type: 'V',
      name: 'V2',
      a: 'p',
      b: 'g',
      value: 5,
      t: 0.5,
      offset: -60,
    } as Comp);
    const snap = buildSnapshot(bad, analyze(bad));
    expect(snap.ok).toBe(false);
    expect(snap.issues.length).toBeGreaterThan(0);
    expect(snap.issues.some((i) => i.code === 'VSOURCE_LOOP')).toBe(true);
    const allRefs = snap.issues.flatMap((i) => i.refNames);
    expect(allRefs).toContain('V1');
    expect(allRefs).toContain('V2');
    // 量值为 null
    expect(snap.branches.find((b) => b.compId === 'R1')!.v).toBeNull();
    expect(snap.nodes.find((n) => n.id === 'm')!.voltage).toBeNull();
    expect(snap.power).toBeNull();

    // 修复后对比：当前侧有值，基准侧为 null
    const fixed = divider();
    const d = computeDiff(snap, fixed, analyze(fixed));
    expect(d.baseOk).toBe(false);
    expect(d.curOk).toBe(true);
    const r1 = compDiff(d, 'R1');
    expect(r1.base!.v).toBeNull();
    expect(r1.cur!.v).toBeCloseTo(4, 9);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);
  });

  it('接线/极性变化被标识', () => {
    const before = divider();
    const snap = buildSnapshot(before, analyze(before));
    const after = divider();
    const r1 = after.comps.find((c) => c.id === 'R1')!;
    [r1.a, r1.b] = [r1.b, r1.a]; // 翻转
    const d = computeDiff(snap, after, analyze(after));
    expect(compDiff(d, 'R1').connChanged).toBe(true);
  });
});

describe('对照快照：随工程持久化（IndexedDB）', () => {
  beforeEach(async () => {
    const all = await storage.list();
    for (const c of all) await storage.remove(c.id);
    localStorage.clear();
  });

  function buildWbCircuit(wb: ReturnType<typeof createWorkbench>) {
    const g = wb.addNode(0, 0);
    const p = wb.addNode(0, 100);
    wb.setGround(g.id);
    wb.tool = 'V';
    const v = wb.connect(p.id, g.id)!;
    wb.updateComp(v.id, { value: 10 });
    wb.tool = 'R';
    const r = wb.connect(p.id, g.id)!;
    wb.updateComp(r.id, { value: 100 });
    return { g, p, v, r };
  }

  it('快照随工程存入 IndexedDB，重开（重新载入）后仍可比较', async () => {
    const wb = createWorkbench();
    buildWbCircuit(wb);
    wb.takeSnapshot();
    await wb.saveNow();

    const back = await storage.get(wb.circuit.id);
    expect(back?.snapshot).toBeTruthy();
    expect(back!.snapshot!.ok).toBe(true);
    expect(back!.snapshot!.branches).toHaveLength(2);

    // 模拟重开：新工作台载入同一记录
    const wb2 = createWorkbench();
    wb2.load(back!);
    expect(wb2.snapshot).toBeTruthy();
    expect(wb2.snapshotDiff).toBeTruthy();
    expect(wb2.snapshotDiff!.counts.changed).toBe(0);

    // 重开后继续编辑：改电阻 → 差值出现
    const rComp = wb2.circuit.comps.find((c) => c.type === 'R')!;
    wb2.updateComp(rComp.id, { value: 50 });
    const row = wb2.snapshotDiff!.comps.find((c) => c.compId === rComp.id)!;
    expect(row.status).toBe('changed');
    expect(row.base!.i).toBeCloseTo(0.1, 9);
    expect(row.cur!.i).toBeCloseTo(0.2, 9);
  });

  it('验收3：清除快照不改变当前电路，也不影响其他工程', async () => {
    // 另一个工程：自带快照，直接入库
    const other = divider();
    other.id = 'other-prj';
    other.snapshot = buildSnapshot(other, analyze(other));
    await storage.put(other);
    const otherBefore = JSON.stringify(await storage.get('other-prj'));

    const wb = createWorkbench();
    buildWbCircuit(wb);
    wb.takeSnapshot();
    await wb.saveNow();
    expect(wb.snapshot).toBeTruthy();

    const nodesBefore = JSON.stringify(wb.circuit.nodes);
    const compsBefore = JSON.stringify(wb.circuit.comps);
    wb.clearSnapshot();
    await wb.saveNow();

    // 当前电路不变
    expect(wb.snapshot).toBeNull();
    expect(wb.snapshotDiff).toBeNull();
    expect(JSON.stringify(wb.circuit.nodes)).toBe(nodesBefore);
    expect(JSON.stringify(wb.circuit.comps)).toBe(compsBefore);
    // 库里的记录也不含快照了，但电路内容不变
    const back = await storage.get(wb.circuit.id);
    expect(back!.snapshot ?? null).toBeNull();
    expect(back!.comps).toHaveLength(2);
    // 其他工程原样
    expect(JSON.stringify(await storage.get('other-prj'))).toBe(otherBefore);
  });

  it('拍快照本身不改动电路连接与参数', () => {
    const wb = createWorkbench();
    buildWbCircuit(wb);
    const before = JSON.stringify({
      nodes: wb.circuit.nodes,
      comps: wb.circuit.comps,
    });
    wb.takeSnapshot();
    expect(
      JSON.stringify({ nodes: wb.circuit.nodes, comps: wb.circuit.comps }),
    ).toBe(before);
  });
});
