/** server pageだけで使用。環境一覧や認証情報をClient propsへ渡さない。 */
export function accountEventId(
  config: Record<string, string | undefined>,
): string | null {
  if (
    config.KOKO_ACCOUNT_UI_ENABLED !== "true" ||
    config.KOKO_API_COOKIE_ENABLED !== "true" ||
    config.KOKO_API_PROXY_ENABLED !== "true"
  )
    return null;
  const id = config.KOKO_EVENT_ID;
  return id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
    ? id
    : null;
}
