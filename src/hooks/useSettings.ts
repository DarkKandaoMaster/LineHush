import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readSettings, writeSettings } from "../core/native";
import type { Session } from "../core/session";
import {
  DEFAULT_SETTINGS,
  applySettings,
  normalizeSettings,
  type Settings,
} from "../core/settings";

/** Browser preview only; the desktop app keeps settings in Rust's settings.json. */
const STORAGE_KEY = "linehush-settings";

function readLocal(): unknown {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

/**
 * Settings load once at start and apply as CSS variables on <html>. Changes
 * apply at once and are written about 300 ms later; a failed write shows
 * "保存设置失败：…" in the error banner.
 */
export function useSettings(session: Session) {
  const { desktop } = session;
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const current = useRef(settings);
  /** A change made before loading finished wins over the loaded value. */
  const changed = useRef(false);
  const pending = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    value?: Settings;
  }>({});

  useEffect(() => {
    let active = true;
    const load = desktop ? readSettings() : Promise.resolve(readLocal());
    load.then(
      (value) => {
        if (!active || changed.current) return;
        current.current = normalizeSettings(value);
        setSettings(current.current);
      },
      (e) => console.error("无法读取设置：", e),
    );
    return () => {
      active = false;
    };
  }, [desktop]);

  useLayoutEffect(() => {
    applySettings(document.documentElement.style, settings);
  }, [settings]);

  /** Writes a change that is still waiting for the debounce now. */
  const flush = useCallback(() => {
    const slot = pending.current;
    clearTimeout(slot.timer);
    const value = slot.value;
    slot.value = undefined;
    if (!value) return;
    if (desktop)
      writeSettings(value).catch((e) => session.setError(`保存设置失败：${e}`));
    else
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Browser preview: settings simply do not persist.
      }
  }, [desktop, session]);

  const set = useCallback(
    (next: Settings) => {
      changed.current = true;
      current.current = next;
      setSettings(next);
      const slot = pending.current;
      slot.value = next;
      clearTimeout(slot.timer);
      slot.timer = setTimeout(flush, 300);
    },
    [flush],
  );
  const update = useCallback(
    (partial: Partial<Settings>) =>
      set(normalizeSettings({ ...current.current, ...partial })),
    [set],
  );
  const reset = useCallback(() => set(DEFAULT_SETTINGS), [set]);

  // A change still waiting is written when the window unloads.
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [flush]);

  return { settings, update, reset, flush };
}
