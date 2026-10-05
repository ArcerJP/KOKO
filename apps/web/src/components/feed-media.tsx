"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { PublicPost } from "../api/feed-contract";
import { createScopedHlsLoader } from "./feed-hls-loader";

export function FeedMedia({
  post,
  active,
  large = false,
  play = true,
  sound = false,
}: {
  post: PublicPost;
  active: boolean;
  large?: boolean;
  play?: boolean;
  sound?: boolean;
}) {
  return post.media.kind === "photo" ? (
    <FeedPhoto
      key={`${post.id}:${large}`}
      post={post}
      large={large}
      active={active}
    />
  ) : (
    <FeedVideo
      key={post.id}
      post={post}
      active={active}
      play={play}
      sound={sound}
    />
  );
}
function FeedPhoto({
  post,
  large,
  active,
}: {
  post: PublicPost;
  large: boolean;
  active: boolean;
}) {
  const [fallback, setFallback] = useState(false),
    [failed, setFailed] = useState(false);
  if (!active || failed || post.media.kind !== "photo")
    return (
      <p role="status">
        {failed ? "画像を取得できませんでした。" : "公開状態を確認中"}
      </p>
    );
  const media = post.media;
  return (
    <Image
      unoptimized
      src={
        large
          ? fallback
            ? media.jpg_1600
            : media.webp_1600
          : fallback
            ? media.jpg_600
            : media.webp_600
      }
      alt={`${post.display_name}さんの投稿写真`}
      width={large ? 1600 : 600}
      height={large ? 1600 : 600}
      sizes={large ? "100vw" : "33vw"}
      loading="lazy"
      onError={() => (fallback ? setFailed(true) : setFallback(true))}
    />
  );
}

function FeedVideo({
  post,
  active,
  play,
  sound,
}: {
  post: PublicPost;
  active: boolean;
  play: boolean;
  sound: boolean;
}) {
  const element = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false),
    [muted, setMuted] = useState(true);
  const media = post.media.kind === "video" ? post.media : null;
  const hlsUrl = media?.hls_url;
  useEffect(() => {
    const video = element.current;
    if (!video || !active || !hlsUrl) return;
    let cancelled = false,
      hls: Hls | undefined;
    const clear = () => {
      video.pause();
      video.muted = true;
      video.removeAttribute("src");
      video.load();
      hls?.destroy();
    };
    const stop = () => {
      if (!cancelled) {
        setFailed(true);
        clear();
      }
    };
    const ready = () => {
      if (
        !Number.isFinite(video.duration) ||
        video.duration > 4 ||
        video.duration <= 0
      )
        stop();
    };
    const start = () => {
      if (play && !cancelled)
        void video.play().catch(() => {
          /* Autoplay policy: keep controls available after a user gesture. */
        });
    };
    video.muted = true;
    video.addEventListener("error", stop);
    video.addEventListener("loadedmetadata", ready);
    video.addEventListener("canplay", start);
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.load();
      start();
    } else
      void import("hls.js")
        .then(({ default: HlsClass }) => {
          if (cancelled) return;
          if (!HlsClass.isSupported()) {
            stop();
            return;
          }
          const policy = {
            default: {
              maxTimeToFirstByteMs: 10000,
              maxLoadTimeMs: 10000,
              timeoutRetry: null,
              errorRetry: null,
            },
          };
          hls = new HlsClass({
            loader: createScopedHlsLoader(
              location.origin,
              post.event_id,
              post.id,
            ),
            autoStartLoad: play,
            enableWorker: false,
            capLevelToPlayerSize: true,
            maxBufferLength: 4,
            maxMaxBufferLength: 4,
            backBufferLength: 0,
            maxBufferSize: 16 * 1024 * 1024,
            manifestLoadPolicy: policy,
            playlistLoadPolicy: policy,
            fragLoadPolicy: policy,
            keyLoadPolicy: policy,
          });
          hls.on(HlsClass.Events.ERROR, stop);
          hls.on(HlsClass.Events.MANIFEST_PARSED, start);
          hls.attachMedia(video);
          hls.loadSource(hlsUrl);
        })
        .catch(stop);
    return () => {
      cancelled = true;
      video.removeEventListener("error", stop);
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("canplay", start);
      clear();
    };
  }, [active, hlsUrl, play, post.event_id, post.id]);
  if (!media) return null;
  if (failed)
    return (
      <p role="status">
        動画を再生できませんでした。再読み込みか、対応する端末で確認してください。
      </p>
    );
  return (
    <>
      {active ? (
        <video
          ref={element}
          poster={media.thumbnail_url}
          muted={muted || !sound || !play}
          onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
          playsInline
          loop
          preload={play ? "auto" : "metadata"}
          aria-label={`${post.display_name}さんの投稿動画`}
        />
      ) : (
        <Image
          unoptimized
          src={media.thumbnail_url}
          alt={`${post.display_name}さんの動画サムネイル`}
          width={600}
          height={600}
          sizes="33vw"
          loading="lazy"
        />
      )}
      {sound && active && play ? (
        <button
          type="button"
          onClick={() => {
            const video = element.current;
            if (!video) return;
            const next = !video.muted;
            video.muted = next;
            setMuted(next);
            void video.play().catch(() => {});
          }}
        >
          {muted ? "タップして音を出す" : "音を消す"}
        </button>
      ) : null}
    </>
  );
}
