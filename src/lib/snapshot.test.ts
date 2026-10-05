import { describe, it, expect } from 'vitest';
import { analyze } from './engine/analyze';
import { diffSnapshot, summarize, type Snapshot } from './snapshot';
import type { Circuit, Comp } from './engine/types';

const mk = (
  defs: { type: Comp['type']; a: string; b: string; value?: number; name?: string }[],
  ground = 'g',
  extraNodes: string[] = [],
): Circuit => {
  const ids = new Set<string>([ground, ...extraNodes]);
  defs.forEach((d) => {
    ids.add(d.a);
    ids.add(d.b);
  });
  const pos: Record<string, [number, number]> = {};
  [...ids].forEach((id, i) => (pos[id] = [(i % 4) * 120, Math.floor(i / 4) * 120]));
  return {
    id: 'prj1',
    title: 'snapshot-test',
    updatedAt: 0,
    nodes: [...ids].map((id) => ({ id, name: id, x: pos[id][0], y: pos[id][1], ground: id === ground })),
    comps: defs.map((d, i) => ({
      id: d.name ?? `c${i}`,
      type: d.type,
      name: d.name ?? `${d.type}${i + 1}`,
      a: d.a,
      b: d.b,
      value: d.value ?? (d.type === 'R' ? 100 : 1),
      t: 0.5,
      offset: 0,
    })),
  };
};

const snapOf = (c: Circuit): Snapshot => ({
  projectId: c.id,
  createdAt: 1000,
  circuit: JSON.parse(JSON.stringify(c)),
  summary: summarize(c, analyze(c)),
});

const findComp = (d: ReturnType<typeof diffSnapshot>, id: string) => d.comps.find((x) => x.id === id)!;
const findNode = (d: ReturnType<typeof diffSnapshot>, id: string) => d.nodes.find((x) => x.id === id)!;

describe('对照快照明细（diffSnapshot）', () => {
  it('只改一个电阻：本支路与相关支路出现差值，无关符号不为 NaN', () => {
    const base = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 10 },
      { type: 'R', name: 'R1', a: 'p', b: 'g', value: 10 },
      { type: 'R', name: 'R2', a: 'p', b: 'g', value: 10 },
    ]);
    expect(analyze(base).ok).toBe(true);
    const snap = snapOf(base);

    const now: Circuit = JSON.parse(JSON.stringify(base));
    now.comps.find((c) => c.id === 'R1')!.value = 40;

    const d = diffSnapshot(snap, now, analyze(now));
    expect(d.hasSnapshot).toBe(true);
    expect(d.baseOk).toBe(true);
    expect(d.nowOk).toBe(true);

    const r1 = findComp(d, 'R1');
    expect(r1.status).toBe('changed');
    expect(r1.value.delta).toBe(30);
    // 10V/10Ω = 1A → 10V/40Ω = 0.25A
    expect(r1.i.base).toBeCloseTo(1, 9);
    expect(r1.i.now).toBeCloseTo(0.25, 9);
    expect(r1.i.delta).toBeCloseTo(-0.75, 9);
    // P: 10W → 2.5W
    expect(r1.power.delta).toBeCloseTo(-7.5, 9);

    // R2 两端电位仍是 10V，电流/功率不变
    const r2 = findComp(d, 'R2');
    expect(r2.status).toBe('same');
    expect(r2.i.delta).toBeCloseTo(0, 9);

    // 所有 delta 都必须是有限数（不得出现 NaN）
    for (const cd of d.comps) {
      for (const s of [cd.value, cd.v, cd.i, cd.power]) {
        if (s.delta !== null) expect(Number.isNaN(s.delta)).toBe(false);
      }
    }
    expect(JSON.stringify(d)).not.toContain('NaN');

    // 节点 p 电位不变（电压源钳位）
    const p = findNode(d, 'p');
    expect(p.status).toBe('same');
    expect(p.voltage.delta).toBeCloseTo(0, 9);
  });

  it('串联分压：改电阻后中间节点电位差可见', () => {
    const base = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 10 },
      { type: 'R', name: 'R1', a: 'p', b: 'm', value: 5 },
      { type: 'R', name: 'R2', a: 'm', b: 'g', value: 5 },
    ]);
    const snap = snapOf(base);
    const now: Circuit = JSON.parse(JSON.stringify(base));
    now.comps.find((c) => c.id === 'R2')!.value = 15;
    const d = diffSnapshot(snap, now, analyze(now));
    // V(m): 5V → 7.5V
    const m = findNode(d, 'm');
    expect(m.voltage.base).toBeCloseTo(5, 9);
    expect(m.voltage.now).toBeCloseTo(7.5, 9);
    expect(m.voltage.delta).toBeCloseTo(2.5, 9);
    expect(m.status).toBe('changed');
  });

  it('删除元件后：行标记 removed，基准值仍可查看，当前侧留空但无 NaN', () => {
    const base = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 10 },
      { type: 'R', name: 'R1', a: 'p', b: 'g', value: 10 },
    ]);
    const snap = snapOf(base);
    const now: Circuit = JSON.parse(JSON.stringify(base));
    now.comps = now.comps.filter((c) => c.id !== 'R1');
    const d = diffSnapshot(snap, now, analyze(now));

    const r1 = findComp(d, 'R1');
    expect(r1.status).toBe('removed');
    expect(r1.i.base).toBeCloseTo(1, 9);
    expect(r1.power.base).toBeCloseTo(10, 9);
    expect(r1.i.now).toBeNull();
    expect(r1.i.delta).toBeNull(); // 绝不伪造差值
    expect(r1.i.nowStatus).toBe('missing');
    // R1 被移除后只剩电压源（冗余回路），其源电流不再唯一 → 也算变化
    expect(findComp(d, 'V1').status).toBe('changed');
    expect(d.counts.removed).toBe(1);
    expect(JSON.stringify(d)).not.toContain('NaN');
  });

  it('新增元件：行标记 added，基准侧为空', () => {
    const base = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 10 },
      { type: 'R', name: 'R1', a: 'p', b: 'g', value: 10 },
    ]);
    const snap = snapOf(base);
    const now: Circuit = JSON.parse(JSON.stringify(base));
    now.comps.push({ id: 'R2', type: 'R', name: 'R2', a: 'p', b: 'g', value: 10, t: 0.5, offset: 0 });
    const d = diffSnapshot(snap, now, analyze(now));
    const r2 = findComp(d, 'R2');
    expect(r2.status).toBe('added');
    expect(r2.i.base).toBeNull();
    expect(r2.i.now).toBeCloseTo(1, 9);
    expect(r2.i.delta).toBeNull();
    expect(d.counts.added).toBe(1);
  });

  it('当前侧无法求解：保留当前诊断，差值留空，不用 NaN', () => {
    const base = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 12 },
      { type: 'R', name: 'R1', a: 'p', b: 'g', value: 10 },
    ]);
    const snap = snapOf(base);

    // 制造矛盾：并联一个 5V 理想电压源
    const now: Circuit = JSON.parse(JSON.stringify(base));
    now.comps.push({ id: 'V2', type: 'V', name: 'V2', a: 'p', b: 'g', value: 5, t: 0.5, offset: 0 });
    const nowResult = analyze(now);
    expect(nowResult.ok).toBe(false);

    const d = diffSnapshot(snap, now, nowResult);
    expect(d.baseOk).toBe(true);
    expect(d.nowOk).toBe(false);
    expect(d.nowIssues.some((i) => i.code === 'VSOURCE_LOOP')).toBe(true);

    const r1 = findComp(d, 'R1');
    expect(r1.i.base).toBeCloseTo(1.2, 9);
    expect(r1.i.now).toBeNull();
    expect(r1.i.delta).toBeNull();
    expect(r1.power.delta).toBeNull();

    const p = findNode(d, 'p');
    expect(p.voltage.base).toBeCloseTo(12, 9);
    expect(p.voltage.now).toBeNull();
    expect(p.voltage.delta).toBeNull();
    expect(JSON.stringify(d)).not.toContain('NaN');
  });

  it('基准侧无法求解：基准诊断随快照保留，编辑修复后基准值留空、当前有值', () => {
    const bad = mk([
      { type: 'V', name: 'V1', a: 'p', b: 'g', value: 12 },
      { type: 'V', name: 'V2', a: 'p', b: 'g', value: 5 },
      { type: 'R', name: 'R1', a: 'p', b: 'g', value: 10 },
    ]);
    const badResult = analyze(bad);
    expect(badResult.ok).toBe(false);
    const snap = snapOf(bad);
    expect(snap.summary.ok).toBe(false);
    expect(snap.summary.issues.some((i) => i.code === 'VSOURCE_LOOP')).toBe(true);

    // 修复为一致电压源
    const now: Circuit = JSON.parse(JSON.stringify(bad));
    now.comps.find((c) => c.id === 'V2')!.value = 12;
    const d = diffSnapshot(snap, now, analyze(now));
    expect(d.baseOk).toBe(false);
    expect(d.nowOk).toBe(true);
    expect(d.baseIssues.some((i) => i.code === 'VSOURCE_LOOP')).toBe(true);
    const r1 = findComp(d, 'R1');
    expect(r1.i.base).toBeNull();
    expect(r1.i.now).toBeCloseTo(1.2, 9);
    expect(r1.i.delta).toBeNull();
    expect(JSON.stringify(d)).not.toContain('NaN');
  });

  it('无快照时 hasSnapshot=false 且列表为空', () => {
    const c = mk([{ type: 'R', name: 'R1', a: 'g', b: 'x', value: 10 }]);
    const d = diffSnapshot(null, c, analyze(c));
    expect(d.hasSnapshot).toBe(false);
    expect(d.nodes).toEqual([]);
    expect(d.comps).toEqual([]);
  });
});
