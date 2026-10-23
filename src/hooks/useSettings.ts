import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SETTINGS_CHANGED, readSettings, writeSettings } from "../core/native";
import { LAYOUT_CHANGED } from "../editor/caret";
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
 * "保存设置失败：…" through `report` (the current tab's error banner). Rust tells
 * every window when settings were written (`settings-changed`): they apply
 * here without being written again, unless this window has a change of its own
 * still waiting to be written.
 */
export function useSettings({
  desktop,
  report,
}: {
  desktop: boolean;
  report: (error: string) => void;
}) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /** `settings` 已是读到的（或用户改过的）值，不再只是读取前的默认值。 */
  const [loaded, setLoaded] = useState(false);
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
    load
      .then(
        (value) => {
          if (!active || changed.current) return;
          current.current = normalizeSettings(value);
          setSettings(current.current);
        },
        (e) => console.error("无法读取设置：", e),
      )
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [desktop]);

  // Settings written by any window (this one included) apply to all of them.
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let remove: (() => void) | undefined;
    listen<unknown>(SETTINGS_CHANGED, (event) => {
      if (pending.current.value) return;
      const next = normalizeSettings(event.payload);
      changed.current = true;
      setLoaded(true);
      if (JSON.stringify(next) === JSON.stringify(current.current)) return;
      current.current = next;
      setSettings(next);
    }).then(
      (unlisten) => {
        if (active) remove = unlisten;
        else unlisten();
      },
      (e) => console.error("无法接收设置修改：", e),
    );
    return () => {
      active = false;
      remove?.();
    };
  }, [desktop]);

  useLayoutEffect(() => {
    applySettings(document.documentElement.style, settings);
    // The font can change where lines wrap without resizing the editor; the
    // drawn caret and selection are placed again (src/editor/caret.ts).
    window.dispatchEvent(new Event(LAYOUT_CHANGED));
  }, [settings]);

  /** Writes a change that is still waiting for the debounce now. */
  const flush = useCallback(() => {
    const slot = pending.current;
    clearTimeout(slot.timer);
    const value = slot.value;
    slot.value = undefined;
    if (!value) return;
    if (desktop)
      writeSettings(value).catch((e) => report(`保存设置失败：${e}`));
    else
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Browser preview: settings simply do not persist.
      }
  }, [desktop, report]);

  const set = useCallback(
    (next: Settings) => {
      changed.current = true;
      setLoaded(true);
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

  return { settings, loaded, update, reset, flush };
}
