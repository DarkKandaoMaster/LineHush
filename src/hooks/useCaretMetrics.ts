import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { caretMetrics } from "../core/native";
import { configureCaret } from "../editor/caret";

/**
 * Reads Windows' caret settings (width, blink rate, timeout) for the editors'
 * own caret at start and again whenever the window gets the focus, so a change
 * made in Windows settings applies on coming back.
 */
export function useCaretMetrics() {
  useEffect(() => {
    let active = true;
    const load = () =>
      void caretMetrics().then(
        (metrics) => active && configureCaret({ metrics }),
        (e) => console.error("无法读取系统光标设置：", e),
      );
    load();
    let remove: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => payload && load())
      .then((unlisten) => {
        if (active) remove = unlisten;
        else unlisten();
      }, console.error);
    return () => {
      active = false;
      remove?.();
    };
  }, []);
}
