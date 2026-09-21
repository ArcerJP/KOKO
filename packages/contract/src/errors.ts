/** K-05正本。APIはcode/request_id/retry_after_secondsだけを返し、内部例外を返さない。 */
export const errors = {
  AUTH_REQUIRED: {
    status: 401,
    message: "Googleアカウントでログインしてください。",
    retryable: false,
  },
  FORBIDDEN: {
    status: 403,
    message: "この操作を行う権限がありません。",
    retryable: false,
  },
  CONSENT_REQUIRED: {
    status: 403,
    message: "最新の利用規約を確認し、同意してください。",
    retryable: false,
  },
  ACCOUNT_BANNED: {
    status: 403,
    message: "投稿が制限されています。異議申立てをご利用ください。",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    message: "投稿が見つからないか、公開されていません。",
    retryable: false,
  },
  INVALID_INPUT: {
    status: 400,
    message: "入力内容を確認してください。",
    retryable: false,
  },
  INVALID_CURSOR: {
    status: 400,
    message: "一覧を更新して、もう一度お試しください。",
    retryable: false,
  },
  EVENT_CLOSED: {
    status: 409,
    message: "現在、このイベントへの投稿は受け付けていません。",
    retryable: false,
  },
  PUBLICATION_STOPPED: {
    status: 503,
    message: "運営による確認のため、公開と投稿を一時停止しています。",
    retryable: false,
  },
  THEME_UNAVAILABLE: {
    status: 409,
    message: "このお題は受付を終了しました。お題を選び直してください。",
    retryable: false,
  },
  STATE_CONFLICT: {
    status: 409,
    message: "投稿の状態が変わりました。最新の状態を確認してください。",
    retryable: false,
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "送信内容が変わっています。投稿状態を確認してください。",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: "投稿が集中しています。少し待ってからお試しください。",
    retryable: true,
  },
  UPLOAD_EXPIRED: {
    status: 410,
    message: "アップロードの有効期限が切れました。再送信してください。",
    retryable: true,
  },
  UPLOAD_INCOMPLETE: {
    status: 409,
    message: "アップロードがまだ完了していません。送信を続けてください。",
    retryable: true,
  },
  PROVIDER_LIMIT: {
    status: 413,
    message:
      "保存サービスの制約により送信できません。運営へお問い合わせください。",
    retryable: false,
  },
  UNSUPPORTED_MEDIA: {
    status: 422,
    message: "この形式の変換に失敗しました。原本の保存状況を確認しています。",
    retryable: false,
  },
  VIDEO_TOO_LONG: {
    status: 422,
    message: "動画を4秒以内に処理できませんでした。再処理をお待ちください。",
    retryable: false,
  },
  PROCESSING_HELD: {
    status: 503,
    message: "処理の確認中です。公開せず保留しています。",
    retryable: false,
  },
  CONTENT_BLOCKED: {
    status: 422,
    message: "公開基準により投稿できませんでした。異議申立てをご利用ください。",
    retryable: false,
  },
  LOCAL_STORAGE_UNAVAILABLE: {
    status: 0,
    message:
      "この端末に送信待ちデータを保存できません。空き容量やブラウザ設定を確認してください。",
    retryable: false,
  },
  NETWORK_UNAVAILABLE: {
    status: 0,
    message: "接続を確認して、この画面を開いたままお待ちください。",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "処理に失敗しました。時間をおいてお試しください。",
    retryable: true,
  },
} as const;

export type ErrorCode = keyof typeof errors;
export type ApiErrorCode = Exclude<
  ErrorCode,
  "LOCAL_STORAGE_UNAVAILABLE" | "NETWORK_UNAVAILABLE"
>;

export class ContractError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(errors[code].message);
    this.name = "ContractError";
  }
}
