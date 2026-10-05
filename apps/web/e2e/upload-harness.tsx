// Browser-only synthetic harness. Bundled by the test runner, never a Next route.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { UploadPanel } from "../src/components/upload-panel";
import { createUploadQueue } from "../src/media/upload-queue";
import {
  createIndexedQueueStore,
  withUploadLock,
} from "../src/media/upload-queue-storage";
import { ApiFailure } from "../src/api/client";
import {
  destination,
  csrf,
  single,
  receipt,
  input,
} from "../test/upload-fixture";
import type { UploadRequest } from "../src/api/upload-contract";

const owner = new URL(location.href).searchParams.get("other")
  ? "00000000-0000-4000-8000-000000000008"
  : "00000000-0000-4000-8000-000000000009";
const store = createIndexedQueueStore(owner, destination.eventId);
let offline = false;
let hold: (() => void) | null = null;
const puts: number[] = [];
let accepted: UploadRequest = input;
const queue = createUploadQueue({
  owner,
  destination,
  store,
  lock: withUploadLock,
  authorize: async () => csrf,
  client: {
    open: async (request) => {
      accepted = request;
      if (offline) throw new ApiFailure("NETWORK_UNAVAILABLE");
      return {
        ...single(),
        required_headers: {
          ...single().required_headers,
          "content-type": request.content_type,
        },
      };
    },
    refresh: async () => ({
      ...single(),
      required_headers: {
        ...single().required_headers,
        "content-type": accepted.content_type,
      },
    }),
    parts: async () => {
      throw new Error("not used");
    },
    complete: async () => {
      if (!puts.length) throw new ApiFailure("UPLOAD_INCOMPLETE");
      return { ...receipt, status: "uploaded" as const };
    },
  },
  fetcher: async (_url, options) => {
    puts.push((options?.body as Blob).size);
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        hold = null;
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      hold = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
    });
    return new Response(null, { status: 200 });
  },
});
export const harness = {
  queue,
  store,
  puts,
  offline(value: boolean) {
    offline = value;
  },
  release() {
    hold?.();
    hold = null;
  },
  async metadata() {
    return store.list();
  },
};
declare global {
  interface Window {
    queueHarness: typeof harness;
  }
}
window.queueHarness = harness;
function App() {
  const [other, setOther] = useState(false);
  return (
    <main className="shell">
      <h1>送信画面の合成試験</h1>
      <button onClick={() => void queue.initialize()}>
        本人確認・読み込み
      </button>
      <button onClick={() => setOther(!other)}>画面切替</button>
      {other ? (
        <p>別の画面（実行中の送信は保持）</p>
      ) : (
        <UploadPanel
          queue={queue}
          eventId={destination.eventId}
          themesEnabled={new URL(location.href).searchParams.has("themes")}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
