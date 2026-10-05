import type { Circuit, Comp, CompType, Node } from './engine/types';
import type { AnalysisResult } from './engine/types';
import { analyze } from './engine/analyze';
import { makeComp, makeNode, newCircuit } from './factory';
import { storage } from './storage';
import { diffSnapshot, summarize, type Snapshot, type SnapshotDiff } from './snapshot';

export type Tool = 'select' | 'node' | 'wire' | 'R' | 'V' | 'I';
export type Selection = { kind: 'node' | 'comp'; id: string } | null;
export interface Highlight {
  compIds: string[];
  nodeIds: string[];
}

const DEFAULT_VALUE: Record<CompType, number> = { R: 100, V: 5, I: 1, wire: 0 };

/**
 * 工作台状态。此文件为 .svelte.ts（runes 模块），
 * 只有 $state / $derived 等 rune 可在此顶层使用。
 */
export function createWorkbench() {
  const state = $state({
    circuit: newCircuit() as Circuit,
    tool: 'select' as Tool,
    selection: null as Selection,
    pendingNode: null as string | null,
    highlight: { compIds: [], nodeIds: [] } as Highlight,
    saveState: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
    /** 对照快照（只读基准）；null 表示当前工程没有快照 */
    snapshot: null as Snapshot | null,
    snapshotBusy: false,
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const result = $derived(analyze(state.circuit));
  /** 当前电路与基准快照的逐项对照；无快照时 hasSnapshot=false */
  const snapshotDiff = $derived(diffSnapshot(state.snapshot, state.circuit, result));
  const selectedComp = $derived(
    state.selection?.kind === 'comp'
      ? (state.circuit.comps.find((c) => c.id === state.selection!.id) ?? null)
      : null,
  );
  const selectedNode = $derived(
    state.selection?.kind === 'node'
      ? (state.circuit.nodes.find((n) => n.id === state.selection!.id) ?? null)
      : null,
  );

  function scheduleSave() {
    state.circuit.updatedAt = Date.now();
    state.saveState = 'saving';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 600);
  }

  async function saveNow() {
    try {
      await storage.put(state.circuit);
      localStorage.setItem('dcw:current', state.circuit.id);
      state.saveState = 'saved';
    } catch (e) {
      console.error('保存失败', e);
      state.saveState = 'error';
    }
  }

  function load(circuit: Circuit) {
    state.circuit = circuit;
    state.selection = null;
    state.pendingNode = null;
    state.snapshot = null;
    localStorage.setItem('dcw:current', circuit.id);
    scheduleSave();
    void loadSnapshot(circuit.id);
  }

  /** 防止异步切换工程时旧工程的快照晚到、覆盖新工程的基准 */
  let loadToken = 0;
  async function loadSnapshot(projectId: string) {
    const token = ++loadToken;
    try {
      const snap = await storage.getSnapshot(projectId);
      if (token === loadToken && state.circuit.id === projectId) state.snapshot = snap ?? null;
    } catch (e) {
      console.warn('读取对照快照失败', e);
    }
  }

  /** 保存当前电路与求解摘要为只读基准；当前侧即使无法求解也照存其诊断 */
  async function takeSnapshot() {
    // 先同步完成所有对响应式状态的读取与计算（避免在 await 之后再读代理）
    const projectId = state.circuit.id;
    const circuit: Circuit = JSON.parse(JSON.stringify(state.circuit));
    const summary = summarize(circuit, analyze(circuit));
    const snap: Snapshot = { projectId, createdAt: Date.now(), circuit, summary };
    state.snapshotBusy = true;
    try {
      await storage.putSnapshot(snap);
      state.snapshot = snap;
    } finally {
      state.snapshotBusy = false;
    }
  }

  /** 清除快照：只删除基准，绝不改动当前电路，也不触碰其他工程 */
  async function clearSnapshot() {
    const projectId = state.circuit.id;
    state.snapshot = null;
    try {
      await storage.removeSnapshot(projectId);
    } catch (e) {
      console.warn('清除对照快照失败', e);
    }
  }

  async function createProject(title?: string) {
    load(newCircuit(title));
    await saveNow();
  }

  async function restoreLast(): Promise<boolean> {
    const id = localStorage.getItem('dcw:current');
    if (!id) return false;
    try {
      const c = await storage.get(id);
      if (c) {
        state.circuit = c;
        state.snapshot = null;
        void loadSnapshot(c.id);
        return true;
      }
    } catch (e) {
      console.warn(e);
    }
    return false;
  }

  function addNode(x: number, y: number): Node {
    const n = makeNode(x, y, nextNodeName());
    state.circuit.nodes.push(n);
    state.selection = { kind: 'node', id: n.id };
    scheduleSave();
    return n;
  }

  function connect(aId: string, bId: string): Comp | null {
    if (aId === bId) {
      state.pendingNode = null;
      return null;
    }
    const tool = state.tool;
    const type: CompType =
      tool === 'wire' ? 'wire' : tool === 'R' || tool === 'V' || tool === 'I' ? tool : 'R';
    const c = makeComp(type, aId, bId, DEFAULT_VALUE[type]);
    c.name = nextCompName(type);
    state.circuit.comps.push(c);
    state.pendingNode = null;
    state.selection = { kind: 'comp', id: c.id };
    scheduleSave();
    return c;
  }

  function deleteSelection() {
    if (!state.selection) return;
    if (state.selection.kind === 'comp') {
      state.circuit.comps = state.circuit.comps.filter((c) => c.id !== state.selection!.id);
    } else {
      const id = state.selection.id;
      state.circuit.comps = state.circuit.comps.filter((c) => c.a !== id && c.b !== id);
      state.circuit.nodes = state.circuit.nodes.filter((n) => n.id !== id);
    }
    state.selection = null;
    scheduleSave();
  }

  function setGround(nodeId: string | null) {
    for (const n of state.circuit.nodes) n.ground = n.id === nodeId;
    scheduleSave();
  }

  function flipComp(compId: string) {
    const c = state.circuit.comps.find((x) => x.id === compId);
    if (!c) return;
    [c.a, c.b] = [c.b, c.a]; // 反转电压极性 / 电流参考方向
    c.t = 1 - c.t;
    c.offset = -c.offset;
    scheduleSave();
  }

  function moveNode(nodeId: string, x: number, y: number) {
    const nd = state.circuit.nodes.find((x2) => x2.id === nodeId);
    if (!nd) return;
    nd.x = x;
    nd.y = y;
    scheduleSave();
  }

  /** 元件图形拖动：只改 t/offset（相对 a→b 的位置），绝不改 a/b 连接 */
  function moveComp(compId: string, centerX: number, centerY: number) {
    const c = state.circuit.comps.find((x) => x.id === compId);
    if (!c) return;
    const A = state.circuit.nodes.find((n) => n.id === c.a);
    const B = state.circuit.nodes.find((n) => n.id === c.b);
    if (!A || !B) return;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const ux = dx / L;
    const uy = dy / L;
    const nx = -uy;
    const ny = ux;
    const px = centerX - A.x;
    const py = centerY - A.y;
    c.t = Math.min(0.92, Math.max(0.08, (px * ux + py * uy) / L));
    c.offset = px * nx + py * ny;
    scheduleSave();
  }

  function updateComp(compId: string, patch: Partial<Comp>) {
    const c = state.circuit.comps.find((x) => x.id === compId);
    if (!c) return;
    Object.assign(c, patch);
    scheduleSave();
  }

  function updateNode(nodeId: string, patch: Partial<Node>) {
    const n = state.circuit.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    Object.assign(n, patch);
    scheduleSave();
  }

  function setTitle(title: string) {
    state.circuit.title = title;
    scheduleSave();
  }

  function nextCompName(type: CompType): string {
    let k = 1;
    const taken = new Set(state.circuit.comps.map((c) => c.name));
    const p = type === 'wire' ? 'W' : type;
    while (taken.has(`${p}${k}`)) k++;
    return `${p}${k}`;
  }

  function nextNodeName(): string {
    let k = 1;
    const taken = new Set(state.circuit.nodes.filter((n) => !n.ground).map((n) => n.name));
    while (taken.has(`n${k}`)) k++;
    return `n${k}`;
  }

  return {
    state,
    get circuit(): Circuit {
      return state.circuit;
    },
    get tool(): Tool {
      return state.tool;
    },
    set tool(v: Tool) {
      state.tool = v;
    },
    get selection(): Selection {
      return state.selection;
    },
    set selection(v: Selection) {
      state.selection = v;
    },
    get pendingNode(): string | null {
      return state.pendingNode;
    },
    set pendingNode(v: string | null) {
      state.pendingNode = v;
    },
    get highlight(): Highlight {
      return state.highlight;
    },
    set highlight(v: Highlight) {
      state.highlight = v;
    },
    get saveState() {
      return state.saveState;
    },
    get result(): AnalysisResult {
      return result;
    },
    get snapshot(): Snapshot | null {
      return state.snapshot;
    },
    get snapshotBusy(): boolean {
      return state.snapshotBusy;
    },
    get snapshotDiff(): SnapshotDiff {
      return snapshotDiff;
    },
    get selectedComp() {
      return selectedComp;
    },
    get selectedNode() {
      return selectedNode;
    },
    load,
    createProject,
    restoreLast,
    saveNow,
    scheduleSave,
    addNode,
    connect,
    deleteSelection,
    setGround,
    flipComp,
    moveNode,
    moveComp,
    updateComp,
    updateNode,
    setTitle,
    takeSnapshot,
    clearSnapshot,
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
