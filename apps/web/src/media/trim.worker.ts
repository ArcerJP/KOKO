import { trimVideo } from "./trim-video";
import type { TrimResult, TrimTarget } from "./trim-policy";

export type TrimRequest = { file: Blob; target: TrimTarget };
export type TrimResponse =
  { type: "progress"; value: number } | { type: "result"; result: TrimResult };

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<TrimRequest>) => void;
  postMessage: (message: TrimResponse) => void;
};
scope.onmessage = ({ data }) => {
  void trimVideo(data.file, data.target, (value) =>
    scope.postMessage({ type: "progress", value }),
  )
    .then((result) => scope.postMessage({ type: "result", result }))
    .catch(() =>
      scope.postMessage({
        type: "result",
        result: {
          status: "fallback",
          target: data.target,
          elapsedMs: 0,
          reason: "worker",
        },
      }),
    );
};
