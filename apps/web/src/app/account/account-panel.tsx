"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createAccountProfile } from "../../api/account-profile";
import { createApiClient } from "../../api/client";
import { createBrowserAuthClient } from "../../auth/browser";
import { postApiSession } from "../../auth/session-post";
import { LogoutButton } from "./logout-button";
import { ProfileForm } from "./profile-form";
import { ConsentForm } from "./consent-form";
import type { TermsDocument } from "../../api/terms-document";
import { createEnrollmentController } from "../../api/enrollment-controller";
import { EnrollmentForm } from "./enrollment-form";

export function AccountPanel({
  eventId,
  termsDocument,
  enrollmentEnabled = false,
}: {
  eventId: string;
  termsDocument: TermsDocument | null;
  enrollmentEnabled?: boolean;
}) {
  const [profile] = useState(() => {
    // SSRでは通信を開始しない。実URLは明示操作時にブラウザで確定する。
    const client = () =>
      createApiClient(new URL("/api/", window.location.origin), eventId);
    return createAccountProfile(
      {
        getMe: (signal) => client().getMe(signal),
        updateMe: (input, csrf, signal) =>
          client().updateMe(input, csrf, signal),
        acceptTerms: (input, csrf, signal) =>
          client().acceptTerms(input, csrf, signal),
      },
      (signal) => postApiSession("/auth/api-session", signal),
      termsDocument,
    );
  });
  const [enrollment] = useState(() => {
    const client = () =>
      createApiClient(new URL("/api/", window.location.origin), eventId);
    return createEnrollmentController(
      {
        getEnrollment: (signal) => client().getEnrollment(signal),
        enrollEvent: (input, csrf, signal) =>
          client().enrollEvent(input, csrf, signal),
      },
      (signal) => postApiSession("/auth/api-session", signal),
    );
  });
  const enrollmentState = useSyncExternalStore(
    enrollment.subscribe,
    enrollment.getSnapshot,
    enrollment.getServerSnapshot,
  );
  const state = useSyncExternalStore(
    profile.subscribe,
    profile.getSnapshot,
    profile.getServerSnapshot,
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          // callback内でAuth通信を再入しない。session/JWTも保持しない。
          if (event === "SIGNED_OUT") {
            profile.close();
            enrollment.close();
          } else if (event !== "INITIAL_SESSION") {
            profile.invalidate();
            enrollment.invalidate();
          }
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      profile.close();
      enrollment.close();
    }
    const leave = () => {
      profile.close();
      enrollment.close();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      unsubscribe?.();
      window.removeEventListener("pagehide", leave);
      profile.invalidate();
      enrollment.invalidate();
    };
  }, [profile, enrollment]);
  return (
    <>
      {enrollmentEnabled && (
        <EnrollmentForm
          state={enrollmentState}
          onLoad={() => {
            void enrollment.load().then((ready) => {
              if (ready) void profile.load();
            });
          }}
          onEdit={enrollment.edit}
          onEnroll={() => {
            void enrollment.enroll().then((ready) => {
              if (ready) void profile.load();
            });
          }}
        />
      )}
      <ProfileForm
        state={state}
        onLoad={() => void profile.load()}
        onEdit={profile.edit}
        onSave={() => void profile.save()}
      />
      <ConsentForm
        state={state}
        onCheck={profile.checkConsent}
        onAccept={() => void profile.accept()}
      />
      <LogoutButton
        apiEnabled
        onStart={() => {
          profile.close();
          enrollment.close();
        }}
      />
    </>
  );
}
