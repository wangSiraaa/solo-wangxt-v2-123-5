import type { Circuit } from './engine/types';
import type { Snapshot } from './snapshot';

const DB_NAME = 'dc-workbench';
const STORE = 'circuits';
const SNAP_STORE = 'snapshots';
const VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      // v2：对照快照独立 store，key 为工程 id（每工程至多一个只读基准）
      if (!db.objectStoreNames.contains(SNAP_STORE)) {
        db.createObjectStore(SNAP_STORE, { keyPath: 'projectId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (stores: Stores) => IDBRequest<T>, stores: string[] = [STORE]): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        // 惰性取 store：事务只覆盖调用方声明的 stores，不能在其中访问未声明的对象库
        const get = (name: string) => (stores.includes(name) ? t.objectStore(name) : null);
        const s: Stores = {
          get circuits() {
            return get(STORE)!;
          },
          get snapshots() {
            return get(SNAP_STORE);
          },
        };
        const req = fn(s);
        req.onsuccess = () => {
          // 事务完成后再关闭连接
          t.oncomplete = () => {
            db.close();
            resolve(req.result);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  );
}

interface Stores {
  circuits: IDBObjectStore;
  snapshots: IDBObjectStore | null;
}

/** 去除 runes 代理，转为可结构化克隆的纯对象 */
function plain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export const storage = {
  async put(circuit: Circuit): Promise<void> {
    // 传入对象可能是 Svelte $state 代理，IndexedDB 结构化克隆无法克隆代理；
    // 先经 JSON 转为纯对象
    const record: Circuit = plain({ ...circuit, updatedAt: Date.now() });
    await tx('readwrite', (s) => s.circuits.put(record));
  },

  async get(id: string): Promise<Circuit | undefined> {
    return tx('readonly', (s) => s.circuits.get(id));
  },

  async list(): Promise<Circuit[]> {
    const all = await tx<Circuit[]>('readonly', (s) => s.circuits.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async remove(id: string): Promise<void> {
    // 删除工程时连同其快照一起清理，不影响其他工程
    await tx(
      'readwrite',
      (s) => {
        if (s.snapshots) void s.snapshots.delete(id);
        return s.circuits.delete(id);
      },
      [STORE, SNAP_STORE],
    );
  },

  // ---------- 对照快照（随工程持久化，重开仍可比较） ----------

  async putSnapshot(snapshot: Snapshot): Promise<void> {
    const record = plain(snapshot);
    await tx('readwrite', (s) => s.snapshots!.put(record), [SNAP_STORE]);
  },

  async getSnapshot(projectId: string): Promise<Snapshot | undefined> {
    return tx('readonly', (s) => s.snapshots!.get(projectId), [SNAP_STORE]);
  },

  async removeSnapshot(projectId: string): Promise<void> {
    await tx('readwrite', (s) => s.snapshots!.delete(projectId), [SNAP_STORE]);
  },
};
