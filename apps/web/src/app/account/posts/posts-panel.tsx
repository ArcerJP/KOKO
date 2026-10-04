"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createApiClient } from "../../../api/client";
import { createOwnPostsController } from "../../../api/own-posts-controller";
import { createBrowserAuthClient } from "../../../auth/browser";
import { postApiSession } from "../../../auth/session-post";
import { LogoutButton } from "../logout-button";
import { PostsView } from "./posts-view";

export function PostsPanel({
  owner,
  eventId,
}: {
  owner: string;
  eventId: string;
}) {
  const [posts] = useState(() => {
    const client = () =>
      createApiClient(new URL("/api/", window.location.origin), eventId);
    return createOwnPostsController(
      owner,
      eventId,
      {
        getMe: (signal) => client().getMe(signal),
        listOwnPosts: (query, signal) => client().listOwnPosts(query, signal),
        getPostStatus: (id, signal) => client().getPostStatus(id, signal),
      },
      (signal) => postApiSession("/auth/api-session", signal),
    );
  });
  const state = useSyncExternalStore(
    posts.subscribe,
    posts.getSnapshot,
    posts.getServerSnapshot,
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined,
      channel: BroadcastChannel | undefined;
    try {
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          if (
            event === "SIGNED_OUT" ||
            event === "SIGNED_IN" ||
            event === "USER_UPDATED"
          )
            posts.close();
          else if (event !== "INITIAL_SESSION") posts.invalidate();
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
      channel = new BroadcastChannel("koko-upload-stop");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "stop") posts.close();
      };
    } catch {
      posts.close();
    }
    const hide = () => {
      if (document.visibilityState !== "visible") posts.invalidate();
    };
    window.addEventListener("pagehide", posts.close);
    window.addEventListener("koko-upload-stop", posts.close);
    document.addEventListener("visibilitychange", hide);
    return () => {
      unsubscribe?.();
      channel?.close();
      window.removeEventListener("pagehide", posts.close);
      window.removeEventListener("koko-upload-stop", posts.close);
      document.removeEventListener("visibilitychange", hide);
      posts.invalidate();
    };
  }, [posts]);
  return (
    <>
      <PostsView
        state={state}
        onReload={() => void posts.reload()}
        onMore={() => void posts.more()}
        onRefresh={(id) => void posts.refresh(id)}
      />
      <LogoutButton apiEnabled onStart={posts.close} />
    </>
  );
}
