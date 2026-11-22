// IndexedDB-backed hand-off for "view first" captures. The offscreen
// document that produces the PNG is torn down once a capture finishes,
// which revokes any blob: URLs it created — so the blobs themselves are
// persisted here, where the preview page (same extension origin) can read
// them back after the offscreen document is gone.

const DB_NAME = 'sshot-captures';
const DB_VERSION = 1;
const STORE = 'images';
const CAPTURE_ID_INDEX = 'captureId';
const CREATED_AT_INDEX = 'createdAt';

export const CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key', autoIncrement: true });
      store.createIndex(CAPTURE_ID_INDEX, 'captureId');
      store.createIndex(CREATED_AT_INDEX, 'createdAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = work(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(result?.value);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export function saveCaptureImage({ captureId, order, filename, blob }) {
  return runTransaction('readwrite', (store) => {
    store.add({ captureId, order, filename, blob, createdAt: Date.now() });
  });
}

export function loadCaptureImages(captureId) {
  return runTransaction('readonly', (store) => {
    const holder = { value: [] };
    const request = store.index(CAPTURE_ID_INDEX).getAll(captureId);
    request.onsuccess = () => {
      holder.value = request.result.sort((a, b) => a.order - b.order);
    };
    return holder;
  });
}

export function pruneCaptureImages(maxAgeMs = CAPTURE_RETENTION_MS) {
  return runTransaction('readwrite', (store) => {
    const range = IDBKeyRange.upperBound(Date.now() - maxAgeMs);
    const request = store.index(CREATED_AT_INDEX).openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}
