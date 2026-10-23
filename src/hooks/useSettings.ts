import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SETTINGS_CHANGED, readSettings, writeSettings } from "../core/native";
import { LAYOUT_CHANGED, configureCaret } from "../editor/caret";
import {
  DEFAULT_SETTINGS,
  applySettings,
  normalizeSettings,
  type Settings,
} from "../core/settings";

/**
 * Settings load once at start and apply as CSS variables on <html>. Changes
 * apply at once and are written about 300 ms later; a failed write shows
 * "保存设置失败：…" through `report` (the current tab's error banner). Rust tells
 * every window when settings were written (`settings-changed`): they apply
 * here without being written again, unless this window has a change of its own
 * still waiting to be written.
 *
 * `loaded` resolves once `current` holds the settings in use, not the defaults
 * shown before the file is read: read (or unreadable), or changed first.
 */
export function useSettings(report: (error: string) => void) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const current = useRef(settings);
  const [ready] = useState(() => {
    let done = () => {};
    const loaded = new Promise<void>((resolve) => (done = resolve));
    return { loaded, done, known: false };
  });
  const reportRef = useRef(report);
  reportRef.current = report;
  const pending = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    value?: Settings;
  }>({});

  /** Shows `next`; once known, the file's value no longer replaces it. */
  const show = useCallback(
    (next: Settings) => {
      ready.known = true;
      ready.done();
      if (JSON.stringify(next) === JSON.stringify(current.current)) return;
      current.current = next;
      setSettings(next);
    },
    [ready],
  );

  useEffect(() => {
    let active = true;
    readSettings()
      .then(
        (value) => {
          // A change made before loading finished wins over the loaded value.
          if (active && !ready.known) show(normalizeSettings(value));
        },
        (e) => console.error("无法读取设置：", e),
      )
      .finally(() => {
        if (active) ready.done();
      });
    return () => {
      active = false;
    };
  }, [ready, show]);

  // Settings written by any window (this one included) apply to all of them.
  useEffect(() => {
    let active = true;
    let remove: (() => void) | undefined;
    listen<unknown>(SETTINGS_CHANGED, (event) => {
      if (!pending.current.value) show(normalizeSettings(event.payload));
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
  }, [show]);

  useLayoutEffect(() => {
    applySettings(document.documentElement.style, settings);
    // 光标粗细 and 选区边角 are not CSS: the drawn caret and selection read them
    // (redrawn only when one changed).
    configureCaret({ width: settings.caretWidth, corners: settings.selectionCorners });
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
    if (value)
      writeSettings(value).catch((e) => reportRef.current(`保存设置失败：${e}`));
  }, []);

  const set = useCallback(
    (next: Settings) => {
      show(next);
      const slot = pending.current;
      slot.value = next;
      clearTimeout(slot.timer);
      slot.timer = setTimeout(flush, 300);
    },
    [flush, show],
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

  return { settings, current, loaded: ready.loaded, update, reset, flush };
}
