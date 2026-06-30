/**
 * Checks whether the global AI Agent configuration (base URL + API key) is
 * present in the given settings list. The backend masks the API key with the
 * sentinel `"__configured__"`, so we accept that as "set".
 */
export function isAIGlobalConfigured(
  settings: { key: string; value: string }[],
): boolean {
  const get = (key: string) =>
    settings.find((s) => s.key === key)?.value?.trim() ?? "";
  const baseUrl = get("ai_base_url");
  const apiKey = get("ai_api_key");
  // apiKey is "__configured__" when the backend has a stored value, or a
  // literal key the user just typed into the settings form.
  return baseUrl.length > 0 && apiKey.length > 0;
}

/**
 * Checks whether the translation-specific AI configuration is present.
 * When `ai_translate_use_global` is `"true"` (the default), translation
 * reuses the global Agent config; otherwise it needs its own base URL + key.
 */
export function isAITranslateConfigured(
  settings: { key: string; value: string }[],
): boolean {
  const get = (key: string) =>
    settings.find((s) => s.key === key)?.value?.trim() ?? "";
  const useGlobal = get("ai_translate_use_global") !== "false";
  if (useGlobal) return isAIGlobalConfigured(settings);
  const baseUrl = get("ai_translate_base_url");
  const apiKey = get("ai_translate_api_key");
  return baseUrl.length > 0 && apiKey.length > 0;
}
