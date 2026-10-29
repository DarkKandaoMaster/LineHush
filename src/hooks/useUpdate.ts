import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as native from "../core/native";
import type { UpdateInfo } from "../core/native";
import type { Tabs } from "../core/tabs";

/** 更新对话框的状态：等用户选择、下载中、等各窗口暂存、启动安装程序、失败。 */
export type UpdatePhase =
  | { kind: "idle" }
  /** `percent` 在服务器没给总长度时为 null，只显示已下载的大小。 */
  | { kind: "downloading"; percent: number | null; downloaded: number }
  | { kind: "stashing" }
  | { kind: "installing" }
  | { kind: "failed"; reason: string };

/** 下载 / 暂存 / 安装进行中：按钮、Esc、标题栏 × 都不响应。 */
export const updateBusy = (phase: UpdatePhase) =>
  phase.kind === "downloading" ||
  phase.kind === "stashing" ||
  phase.kind === "installing";

/**
 * 自动更新（src-tauri/src/update.rs）在页面这一侧：
 *
 * - Rust 发现新版本时给最近使用的窗口发 `update-available`，页面经 `takeUpdate` 取说明（只交出
 *   一次）；事件可能早于监听，所以开始监听后也自己取一次。取到后 `waiting` 为 true，由 App 在
 *   没有别的对话框开着时 `present`（不叠两个对话框）。
 * - “立即更新”：`installUpdate` 下载、校验，再请所有窗口暂存修改，然后启动安装程序并退出进程；
 *   进度经 Channel 回来显示在对话框里，失败显示原因与“重试” / “关闭”。
 * - 每个窗口都应答 `flush-requested`：把本窗口所有标签页的修改立刻暂存（`tabs.stashAll`），
 *   再以 `stashFlushed` 答复。
 */
export function useUpdate(tabs: Tabs) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const running = useRef(false);

  useEffect(() => {
    let active = true;
    const removers: (() => void)[] = [];
    const keep = (remove: () => void) => {
      if (active) removers.push(remove);
      else remove();
    };
    // 只交出一次：取到了就记下（StrictMode 的第一次挂载取到的也算数）。
    const take = () =>
      native.takeUpdate().then(
        (found) => {
          if (!found) return;
          setInfo(found);
          setWaiting(true);
        },
        (e) => console.error("无法读取新版本信息：", e),
      );
    void (async () => {
      try {
        keep(
          await getCurrentWindow().listen(native.UPDATE_AVAILABLE, () => void take()),
        );
        keep(
          await listen<{ round: number }>(native.FLUSH_REQUESTED, (event) => {
            void tabs
              .stashAll()
              .then((error) => native.stashFlushed(event.payload.round, error))
              .catch((e) => console.error("无法答复暂存请求：", e));
          }),
        );
      } catch (e) {
        console.error("无法接收更新通知：", e);
      }
      if (active) void take();
    })();
    return () => {
      active = false;
      removers.splice(0).forEach((remove) => remove());
    };
  }, [tabs]);

  /** 弹出对话框（App 在没有别的对话框开着时调用）；焦点在对话框本身。 */
  const present = useCallback(() => {
    const element = dialog.current;
    setWaiting(false);
    if (!element || element.open) return;
    setPhase({ kind: "idle" });
    element.show();
    // show() 会把焦点给“立即更新”；改为对话框本身（见 UpdateDialog）。
    element.focus({ preventScroll: true });
  }, []);

  /** “立即更新” / “重试”。Windows 上成功时进程退出，不会回到这里。 */
  const install = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    let settled = false;
    setPhase({ kind: "downloading", percent: null, downloaded: 0 });
    // 按钮随即变灰，焦点留在对话框上（Esc 仍由 useDialogs 接住）。
    dialog.current?.focus({ preventScroll: true });
    try {
      await native.installUpdate((progress) => {
        if (settled) return;
        if (progress.phase === "downloading")
          setPhase({
            kind: "downloading",
            downloaded: progress.downloaded,
            percent: progress.total
              ? Math.min(100, Math.floor((progress.downloaded * 100) / progress.total))
              : null,
          });
        else setPhase({ kind: progress.phase });
      });
      settled = true;
    } catch (e) {
      settled = true;
      setPhase({ kind: "failed", reason: String(e) });
    } finally {
      running.current = false;
    }
  }, []);

  /** “以后再说” / “关闭”：本次运行不再提示。 */
  const close = useCallback(() => dialog.current?.close("cancel"), []);
  /** 对话框关掉之后（按钮、Esc、标题栏 ×）。 */
  const closed = useCallback(() => {
    if (!running.current) setPhase({ kind: "idle" });
  }, []);

  return { dialog, info, waiting, phase, present, install, close, closed };
}
