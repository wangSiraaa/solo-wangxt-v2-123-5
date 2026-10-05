// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from './storage';
import type { Circuit } from './engine/types';
import type { Snapshot } from './snapshot';

// 回归：Svelte $state 产生的代理对象无法被 IndexedDB 结构化克隆，
// storage.put 必须先把它转成纯对象。
function proxiedCircuit(id: string): Circuit {
  const raw: Circuit = {
    id,
    title: '代理电路',
    updatedAt: 0,
    nodes: [{ id: 'n1', name: 'n1', x: 0, y: 0, ground: true }],
    comps: [],
  };
  // 模拟 runes $state 的 Proxy 包装（嵌套对象也代理）
  const wrap = <T extends object>(o: T): T =>
    new Proxy(o, {
      get(t, k) {
        const v = Reflect.get(t, k);
        return v && typeof v === 'object' ? wrap(v) : v;
      },
    });
  return wrap(raw);
}

describe('IndexedDB 持久化（代理对象回归）', () => {
  beforeEach(async () => {
    const all = await storage.list();
    for (const c of all) await storage.remove(c.id);
  });

  it('代理化的电路可成功存入并读回', async () => {
    const c = proxiedCircuit('p1');
    await expect(storage.put(c)).resolves.toBeUndefined();
    const back = await storage.get('p1');
    expect(back).toBeTruthy();
    expect(back!.title).toBe('代理电路');
    expect(back!.nodes[0].ground).toBe(true);
  });

  it('list 返回按更新时间倒序的纯对象', async () => {
    await storage.put(proxiedCircuit('a'));
    await new Promise((r) => setTimeout(r, 5));
    await storage.put(proxiedCircuit('b'));
    const list = await storage.list();
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
    // 读回的应是普通对象（不是代理）
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
  });
});

describe('对照快照片久化（snapshots store）', () => {
  beforeEach(async () => {
    const all = await storage.list();
    for (const c of all) await storage.remove(c.id);
  });

  const snap = (projectId: string, ok = true): Snapshot => ({
    projectId,
    createdAt: 7,
    circuit: { id: projectId, title: 't', nodes: [], comps: [], updatedAt: 7 },
    summary: {
      ok,
      issues: ok ? [] : [{ kind: 'error', code: 'NO_GROUND', message: '未设置参考地', refs: [] }],
      nodeVoltage: {},
      branches: {},
    },
  });

  it('快照可存取，且按工程 id 隔离', async () => {
    await storage.putSnapshot(snap('p1'));
    await storage.putSnapshot(snap('p2'));
    expect((await storage.getSnapshot('p1'))!.projectId).toBe('p1');
    expect((await storage.getSnapshot('p2'))!.summary.ok).toBe(true);
    expect(await storage.getSnapshot('nope')).toBeUndefined();
  });

  it('无法求解侧的诊断随快照持久化', async () => {
    await storage.putSnapshot(snap('p1', false));
    const back = await storage.getSnapshot('p1');
    expect(back!.summary.ok).toBe(false);
    expect(back!.summary.issues[0].code).toBe('NO_GROUND');
  });

  it('removeSnapshot 只删指定工程的快照', async () => {
    await storage.putSnapshot(snap('p1'));
    await storage.putSnapshot(snap('p2'));
    await storage.removeSnapshot('p1');
    expect(await storage.getSnapshot('p1')).toBeUndefined();
    expect(await storage.getSnapshot('p2')).not.toBeUndefined();
  });

  it('删除工程时级联删除其快照，不影响其他工程', async () => {
    await storage.put(proxiedCircuit('p1'));
    await storage.put(proxiedCircuit('p2'));
    await storage.putSnapshot(snap('p1'));
    await storage.putSnapshot(snap('p2'));
    await storage.remove('p1');
    expect(await storage.get('p1')).toBeUndefined();
    expect(await storage.getSnapshot('p1')).toBeUndefined();
    expect(await storage.getSnapshot('p2')).not.toBeUndefined();
  });
});
