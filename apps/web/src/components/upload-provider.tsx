"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApiClient } from "../api/client";
import { createUploadClient } from "../api/upload-client";
import { uploadAuthorizer } from "../api/upload-identity";
import { createBrowserAuthClient } from "../auth/browser";
import { postApiSession } from "../auth/session-post";
import { createUploadQueue, type UploadQueue } from "../media/upload-queue";
import {
  createIndexedQueueStore,
  withUploadLock,
} from "../media/upload-queue-storage";

type Config = { eventId: string; r2AccountId: string; termsVersion: string };
const Context = createContext<{
  owner: string | null;
  queue: UploadQueue | null;
  activate: (owner: string) => Promise<void>;
} | null>(null);
export const useUploadQueue = () => useContext(Context);

/** Root layout owns active work. Page navigation must not dispose the queue. */
export function UploadProvider({
  config,
  children,
}: {
  config: Config;
  children: ReactNode;
}) {
  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const [queueOwner, setQueueOwner] = useState<string | null>(null);
  const current = useRef<{ owner: string; queue: UploadQueue } | null>(null);
  const activating = useRef(false);
  useEffect(() => {
    // Merely visiting the non-sending capture lab must not start Auth/queue work.
    if (!queue) return;
    const stop = () => queue.stop();
    let channel: BroadcastChannel | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      channel = new BroadcastChannel("koko-upload-stop");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "stop") stop();
      };
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          if (event !== "INITIAL_SESSION") stop();
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      stop();
    }
    window.addEventListener("koko-upload-stop", stop);
    window.addEventListener("pagehide", stop);
    return () => {
      stop();
      unsubscribe?.();
      channel?.close();
      window.removeEventListener("koko-upload-stop", stop);
      window.removeEventListener("pagehide", stop);
    };
  }, [queue]);

  async function activate(owner: string) {
    if (activating.current) return;
    activating.current = true;
    try {
      if (current.current?.owner !== owner) {
        current.current?.queue.stop();
        await current.current?.queue.settled();
        const base = new URL("/api/", window.location.origin);
        const me = createApiClient(base, config.eventId);
        const next = createUploadQueue({
          owner,
          destination: config,
          store: createIndexedQueueStore(owner, config.eventId),
          client: createUploadClient(base, config),
          authorize: uploadAuthorizer(
            owner,
            config.eventId,
            config.termsVersion,
            (signal) => postApiSession("/auth/api-session", signal),
            (signal) => me.getMe(signal),
          ),
          lock: withUploadLock,
        });
        current.current = { owner, queue: next };
        setQueueOwner(owner);
        setQueue(next);
      }
      await current.current.queue.initialize();
    } finally {
      activating.current = false;
    }
  }
  return (
    <Context.Provider value={{ owner: queueOwner, queue, activate }}>
      {children}
    </Context.Provider>
  );
}
