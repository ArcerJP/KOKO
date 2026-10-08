import { errors, type ErrorCode } from "@koko/contract";
import { ApiFailure } from "../api/client";
import {
  completion,
  receipt,
  ticket,
  uploadRequest,
  type UploadDestination,
  type UploadRequest,
  type UploadTicket,
} from "../api/upload-contract";
import type { createUploadClient } from "../api/upload-client";
import { transferOriginal } from "./upload-transfer";
import {
  queueRecord,
  storageFailure,
  type QueueRecord,
  type QueueStore,
} from "./upload-queue-record";

type Dependencies = {
  owner: string;
  destination: UploadDestination;
  store: QueueStore;
  client: ReturnType<typeof createUploadClient>;
  authorize: (signal: AbortSignal) => Promise<string>;
  lock: (run: () => Promise<void>) => Promise<boolean>;
  fetcher?: typeof fetch;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
export type QueueSnapshot = {
  ready: boolean;
  busy: boolean;
  items: readonly QueueRecord[];
  message: string;
};
const initial: QueueSnapshot = {
  ready: false,
  busy: false,
  items: [],
  message: "本人確認後に、この端末の送信待ちを読み込みます。",
};
function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
const errorCode = (error: unknown): ErrorCode =>
  error instanceof ApiFailure ? error.code : "INTERNAL_ERROR";

/** UI-independent queue. Only enqueue/resume starts writes; init never replays work. */
export function createUploadQueue(deps: Dependencies) {
  const scope = { ...deps.destination };
  const now = deps.now ?? Date.now;
  let state = initial;
  let lifetime = new AbortController();
  let running: Promise<void> | null = null;
  let adding = false;
  const admitted = new Set<string>();
  const subscribers = new Set<() => void>();
  const publish = (update: Partial<QueueSnapshot>) => {
    state = { ...state, ...update };
    subscribers.forEach((listener) => listener());
  };
  const items = async (signal: AbortSignal) => {
    const values = await deps.store.list();
    signal.throwIfAborted();
    publish({ items: values });
  };
  async function authorized<T>(
    signal: AbortSignal,
    action: (csrf: string, bounded: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15_000);
    const bounded = AbortSignal.any([signal, deadline.signal]);
    try {
      const csrf = await deps.authorize(bounded);
      bounded.throwIfAborted();
      const result = await action(csrf, bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.signal.aborted) throw new ApiFailure("NETWORK_UNAVAILABLE");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function attempt(original: QueueRecord, signal: AbortSignal) {
    let item = queueRecord(original, deps.owner, scope.eventId);
    const save = async (update: Partial<QueueRecord>) => {
      signal.throwIfAborted();
      const next = queueRecord(
        { ...item, ...update },
        deps.owner,
        scope.eventId,
      );
      await deps.store.save(next);
      signal.throwIfAborted();
      item = next;
      await items(signal);
    };
    const recoverMultipart = async () => {
      const previous = item.session;
      if (previous?.mode !== "multipart")
        throw new ApiFailure("INTERNAL_ERROR");
      const result = await authorized(signal, (csrf, bounded) =>
        deps.client.recover(previous.uploadId, csrf, bounded),
      );
      const current = ticket(result.ticket, scope, now());
      if (
        result.previous_upload_id !== previous.uploadId ||
        current.post_id !== previous.postId ||
        current.mode !== "multipart" ||
        current.part_size_bytes !== previous.partSize
      )
        throw new ApiFailure("INTERNAL_ERROR");
      if (current.upload_id !== previous.uploadId) {
        // Preserve request, owner and original Blob; never reuse another generation's ETags.
        // Durable save must succeed before issuing any new part or completion request.
        await save({
          phase: "transferring",
          session: { ...previous, uploadId: current.upload_id },
          checkpoint: null,
          manifest: null,
          error: null,
        });
      }
      return current;
    };
    const finish = async () => {
      const session = item.session!;
      const manifest = item.manifest ?? { upload_id: session.uploadId };
      const result = await authorized(signal, (csrf, bounded) =>
        deps.client.complete(session.postId, manifest, csrf, bounded),
      );
      receipt(result, session.postId, scope.eventId);
      await save({
        phase: "done",
        manifest,
        checkpoint: null,
        error: null,
        nextAttemptAt: 0,
      });
    };
    // Local completion intent is not evidence that DB prepare has happened.
    // Probe recovery first so a vanished, still-unprepared generation is not frozen.
    if (item.phase === "completing") {
      const oldId = item.session!.uploadId;
      if (item.session?.mode === "multipart") {
        try {
          await recoverMultipart();
        } catch (error) {
          // A completed session is closed to recovery. Reconcile its immutable
          // completion receipt without retransmitting any bytes.
          if (!(error instanceof ApiFailure) || error.code !== "STATE_CONFLICT")
            throw error;
        }
      }
      if (item.session!.uploadId === oldId) {
        await finish();
        return;
      }
    }
    // Single PUT may have succeeded before a timeout or page exit. Reconcile first.
    if (item.session?.mode === "single") {
      try {
        await finish();
        return;
      } catch (error) {
        if (
          !(error instanceof ApiFailure) ||
          error.code !== "UPLOAD_INCOMPLETE"
        )
          throw error;
      }
    }
    const session: UploadTicket = ticket(
      await authorized(signal, (csrf, bounded) =>
        item.session
          ? item.session.mode === "multipart"
            ? deps.client
                .recover(item.session.uploadId, csrf, bounded)
                .then((result) => {
                  if (result.previous_upload_id !== item.session!.uploadId)
                    throw new ApiFailure("INTERNAL_ERROR");
                  return result.ticket;
                })
            : deps.client.refresh(item.session.uploadId, csrf, bounded)
          : deps.client.open(item.request, csrf, bounded),
      ),
      scope,
      now(),
    );
    if (
      item.session &&
      (session.post_id !== item.session.postId ||
        (session.upload_id !== item.session.uploadId &&
          item.session.mode !== "multipart") ||
        session.mode !== item.session.mode ||
        (session.part_size_bytes ?? null) !== item.session.partSize)
    )
      throw new ApiFailure("INTERNAL_ERROR");
    await save({
      phase: "transferring",
      ...(item.session && session.upload_id !== item.session.uploadId
        ? { checkpoint: null, manifest: null }
        : {}),
      session: {
        postId: session.post_id,
        uploadId: session.upload_id,
        mode: session.mode,
        partSize: session.part_size_bytes ?? null,
      },
      error: null,
    });
    const blob = await deps.store.blob(item.id);
    signal.throwIfAborted();
    const manifest = await transferOriginal(
      blob,
      item.request,
      session,
      scope,
      {
        signal,
        ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
        checkpoint: item.checkpoint,
        signParts: (numbers) =>
          authorized(signal, (csrf, bounded) =>
            deps.client.parts(session.upload_id, numbers, csrf, bounded),
          ),
        onPart: async (part, identity) =>
          save({
            checkpoint: {
              parts: [...(item.checkpoint?.parts ?? []), part],
              identity,
            },
          }),
      },
    );
    if (session.mode === "multipart") {
      const before = item.session!.uploadId;
      await recoverMultipart();
      if (item.session!.uploadId !== before)
        throw new ApiFailure("UPLOAD_INCOMPLETE");
    }
    await save({ phase: "completing", manifest: completion(manifest) });
    await finish();
  }
  async function drain() {
    if (running || !state.ready) return running;
    const signal = lifetime.signal;
    publish({ busy: true });
    running = (async () => {
      try {
        const locked = await deps.lock(async () => {
          for (;;) {
            signal.throwIfAborted();
            const next = (await deps.store.list()).find(
              (item) =>
                admitted.has(item.id) &&
                item.phase !== "done" &&
                !item.paused &&
                item.failures <= 3,
            );
            if (!next) break;
            if (next.nextAttemptAt > now())
              await (deps.wait ?? wait)(next.nextAttemptAt - now(), signal);
            signal.throwIfAborted();
            try {
              await attempt(next, signal);
            } catch (error) {
              signal.throwIfAborted();
              const code = errorCode(error);
              if (code === "LOCAL_STORAGE_UNAVAILABLE") throw error;
              // Reload latest checkpoint, not the pre-attempt copy.
              const current = await deps.store.get(next.id);
              if (!current) throw storageFailure();
              const failures = current.failures + 1;
              const retry = errors[code].retryable && failures <= 3;
              const delay =
                (code === "RATE_LIMITED" ? 60_000 : 1000) * 2 ** (failures - 1);
              await deps.store.save({
                ...current,
                failures,
                error: code,
                paused: !retry,
                nextAttemptAt: retry ? now() + delay : 0,
              });
              signal.throwIfAborted();
              // Auth/consent failures stop the whole owner queue, not just one item.
              if (
                [
                  "AUTH_REQUIRED",
                  "FORBIDDEN",
                  "CONSENT_REQUIRED",
                  "ACCOUNT_BANNED",
                ].includes(code)
              ) {
                lifetime.abort();
                publish({ ...initial, message: errors[code].message });
                break;
              }
              publish({
                message: retry
                  ? `通信を再確認します（自動再試行 ${failures}/3）。`
                  : errors[code].message,
              });
              await items(signal);
            }
          }
        });
        signal.throwIfAborted();
        await items(signal);
        if (!locked)
          publish({
            message:
              "別のタブで送信中です。完了後に読み込み・再開してください。",
          });
      } catch (error) {
        if (!signal.aborted)
          publish({ ready: false, message: errors[errorCode(error)].message });
      } finally {
        running = null;
        if (!signal.aborted) publish({ busy: false });
      }
    })();
    await running;
  }
  return {
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    async initialize() {
      if (running || adding) return;
      lifetime.abort();
      lifetime = new AbortController();
      admitted.clear();
      const signal = lifetime.signal;
      publish({
        ...initial,
        message: "本人と端末内の保存状態を確認しています…",
      });
      try {
        // Identity preparation refreshes a shared Cookie too. Never race it
        // against another tab's identity check + control request.
        const locked = await deps.lock(async () => {
          await authorized(signal, async () => undefined);
          await items(signal);
        });
        signal.throwIfAborted();
        if (!locked) {
          publish({
            message: "別のタブで送信中です。完了後に本人確認してください。",
          });
          return;
        }
        publish({
          ready: true,
          message:
            "送信待ちを読み込みました。復帰した項目は「再開」してください。",
        });
      } catch (error) {
        if (!signal.aborted)
          publish({ message: errors[errorCode(error)].message });
      }
    },
    async enqueue(blob: Blob, input: UploadRequest): Promise<boolean> {
      if (!state.ready || adding) return false;
      adding = true;
      const signal = lifetime.signal;
      const slow = setTimeout(() => {
        if (!signal.aborted)
          publish({
            message:
              "端末への保存に時間がかかっています。まだ受付は完了していません。画面を閉じずにお待ちください。",
          });
      }, 3000);
      try {
        const request = uploadRequest(input);
        if (!(blob instanceof Blob) || blob.size !== request.file_size_bytes)
          throw new ApiFailure("INVALID_INPUT");
        const existing = await deps.store.get(request.client_request_id);
        if (existing) {
          if (JSON.stringify(existing.request) !== JSON.stringify(request))
            throw new ApiFailure("IDEMPOTENCY_CONFLICT");
        } else
          await deps.store.add(
            {
              version: 1,
              id: request.client_request_id,
              owner: deps.owner,
              eventId: scope.eventId,
              request,
              createdAt: now(),
              phase: "queued",
              session: null,
              checkpoint: null,
              manifest: null,
              failures: 0,
              nextAttemptAt: 0,
              paused: false,
              error: null,
            },
            blob,
          );
        signal.throwIfAborted();
        await items(signal);
        publish({
          message:
            "端末に保存して受け付けました。サーバーへの送信・公開はまだ完了していません。",
        });
        admitted.add(request.client_request_id);
        // The previous drain may already have observed an empty queue while this
        // add was committing. Schedule once more after it settles, not just now.
        if (running) {
          void running.then(() => {
            if (!signal.aborted && state.ready) void drain();
          });
        } else void drain();
        return true;
      } catch (error) {
        if (!signal.aborted)
          publish({ message: errors[errorCode(error)].message });
        return false;
      } finally {
        clearTimeout(slow);
        adding = false;
      }
    },
    async resume(id: string) {
      if (!state.ready || running) return;
      const signal = lifetime.signal;
      try {
        const locked = await deps.lock(async () => {
          signal.throwIfAborted();
          const item = await deps.store.get(id);
          if (!item || item.phase === "done") return;
          await deps.store.save({
            ...item,
            paused: false,
            failures: 0,
            nextAttemptAt: 0,
            error: null,
          });
          admitted.add(id);
        });
        signal.throwIfAborted();
        if (locked) await drain();
        else publish({ message: "別のタブで送信中です。" });
      } catch (error) {
        if (!signal.aborted)
          publish({ message: errors[errorCode(error)].message });
      }
    },
    async remove(id: string) {
      if (!state.ready || running) return;
      const signal = lifetime.signal;
      try {
        const locked = await deps.lock(async () => {
          signal.throwIfAborted();
          await deps.store.remove(id);
        });
        signal.throwIfAborted();
        await items(signal);
        publish({
          message: locked
            ? "この端末の保存分を削除しました。サーバー上の投稿は削除していません。"
            : "別のタブで送信中です。",
        });
      } catch (error) {
        if (!signal.aborted)
          publish({ message: errors[errorCode(error)].message });
      }
    },
    stop() {
      lifetime.abort();
      admitted.clear();
      publish({
        ...initial,
        message:
          "送信を停止しました。再開には本人確認が必要です。端末内の保存分は残ります。",
      });
    },
    settled: () => running ?? Promise.resolve(),
  };
}
export type UploadQueue = ReturnType<typeof createUploadQueue>;
