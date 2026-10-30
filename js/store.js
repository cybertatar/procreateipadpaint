// Личная библиотека: хранится в IndexedDB на устройстве, никуда не отправляется.
const DB = 'raskraski';
const STORE = 'mine';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const res = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(res && 'result' in res ? res.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const listMine = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => b.created - a.created);
export const getMine = (id) => tx('readonly', (s) => s.get(id));
export const putMine = (item) => tx('readwrite', (s) => s.put(item));
export const deleteMine = (id) => tx('readwrite', (s) => s.delete(id));
