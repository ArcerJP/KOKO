import {
  queueRecord,
  storageFailure,
  type QueueRecord,
  type QueueStore,
} from "./upload-queue-record";

/** No connection at import/SSR; metadata updates never rewrite the large Blob. */
export function createIndexedQueueStore(
  owner: string,
  eventId: string,
): QueueStore {
  async function transaction<T>(
    mode: IDBTransactionMode,
    action: (tx: IDBTransaction, result: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let db: IDBDatabase | undefined;
      let tx: IDBTransaction | undefined;
      let finished = false;
      let result: T;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        db?.close();
        if (ok) resolve(result);
        else reject(storageFailure());
      };
      const timer = setTimeout(() => {
        try {
          tx?.abort();
        } catch {
          /* already committed */
        }
        finish(false);
      }, 15_000);
      try {
        const open = indexedDB.open("koko-upload-queue", 1);
        open.onerror = () => finish(false);
        open.onblocked = () => finish(false);
        open.onupgradeneeded = () => {
          if (finished) {
            open.transaction?.abort();
            return;
          }
          const entries = open.result.createObjectStore("entries", {
            keyPath: "id",
          });
          entries.createIndex("owner-event", ["owner", "eventId"]);
          open.result.createObjectStore("blobs");
        };
        open.onsuccess = () => {
          db = open.result;
          db.onversionchange = () => db?.close();
          if (finished) {
            db.close();
            return;
          }
          try {
            tx = db.transaction(["entries", "blobs"], mode, {
              durability: "strict",
            });
            tx.oncomplete = () => finish(true);
            tx.onabort = () => finish(false);
            tx.onerror = () => finish(false);
            action(tx, (value) => {
              result = value;
            });
          } catch {
            try {
              tx?.abort();
            } catch {}
            finish(false);
          }
        };
      } catch {
        finish(false);
      }
    });
  }
  function owned(
    tx: IDBTransaction,
    id: string,
    action: (item: QueueRecord) => void,
  ) {
    const read = tx.objectStore("entries").get(id);
    read.onsuccess = () => {
      try {
        action(queueRecord(read.result, owner, eventId));
      } catch {
        tx.abort();
      }
    };
  }
  return {
    list: () =>
      transaction("readonly", (tx, result) => {
        const read = tx
          .objectStore("entries")
          .index("owner-event")
          .getAll([owner, eventId]);
        read.onsuccess = () => {
          try {
            result(
              read.result
                .map((item: unknown) => queueRecord(item, owner, eventId))
                .sort((a, b) => a.createdAt - b.createdAt),
            );
          } catch {
            tx.abort();
          }
        };
      }),
    get: (id) =>
      transaction("readonly", (tx, result) => {
        const read = tx.objectStore("entries").get(id);
        read.onsuccess = () => {
          try {
            result(
              read.result === undefined
                ? null
                : queueRecord(read.result, owner, eventId),
            );
          } catch {
            tx.abort();
          }
        };
      }),
    add: (item, blob) =>
      transaction("readwrite", (tx) => {
        const safe = queueRecord(item, owner, eventId);
        if (
          !(blob instanceof Blob) ||
          blob.size !== safe.request.file_size_bytes
        )
          throw storageFailure();
        tx.objectStore("entries").add(safe);
        // Strip File.name/lastModified; never store credentials or an object URL.
        tx.objectStore("blobs").add(
          blob.slice(0, blob.size, blob.type),
          safe.id,
        );
      }),
    save: (item) =>
      transaction("readwrite", (tx) => {
        const safe = queueRecord(item, owner, eventId);
        owned(tx, safe.id, (existing) => {
          if (JSON.stringify(existing.request) !== JSON.stringify(safe.request))
            throw storageFailure();
          tx.objectStore("entries").put(safe);
          if (safe.phase === "done") tx.objectStore("blobs").delete(safe.id);
        });
      }),
    blob: (id) =>
      transaction("readonly", (tx, result) =>
        owned(tx, id, (item) => {
          const read = tx.objectStore("blobs").get(id);
          read.onsuccess = () => {
            if (
              !(read.result instanceof Blob) ||
              read.result.size !== item.request.file_size_bytes
            ) {
              tx.abort();
              return;
            }
            result(read.result);
          };
        }),
      ),
    remove: (id) =>
      transaction("readwrite", (tx) =>
        owned(tx, id, () => {
          tx.objectStore("entries").delete(id);
          tx.objectStore("blobs").delete(id);
        }),
      ),
  };
}

/** Origin-wide lock includes the API Cookie refresh; no unsafe lease fallback. */
export async function withUploadLock(
  run: () => Promise<void>,
): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks)
    throw storageFailure();
  return navigator.locks.request(
    "koko-upload-queue",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return false;
      await run();
      return true;
    },
  );
}
