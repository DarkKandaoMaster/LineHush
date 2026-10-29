import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "./core/session";
import { createTabs, displayName, type Tab } from "./core/tabs";
import { useCaretMetrics } from "./hooks/useCaretMetrics";
import { useContextMenu } from "./hooks/useContextMenu";
import { useDevicePixelRatio } from "./hooks/useDevicePixelRatio";
import { useDialogs } from "./hooks/useDialogs";
import { useImagePreview } from "./hooks/useImagePreview";
import { useSettings } from "./hooks/useSettings";
import { useUnsavedPrompt } from "./hooks/useUnsavedPrompt";
import { updateBusy, useUpdate } from "./hooks/useUpdate";
import { useWindowGuards } from "./hooks/useWindowGuards";
import { useZoom } from "./hooks/useZoom";
import ContextMenu from "./components/ContextMenu";
import ImagePreviewDialog from "./components/ImagePreviewDialog";
import SettingsDialog, { openSettings } from "./components/SettingsDialog";
import TabPane from "./components/TabPane";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import UnsavedDialog from "./components/UnsavedDialog";
import UpdateDialog from "./components/UpdateDialog";
import "./App.css";

export default function App() {
  const unsaved = useUnsavedPrompt();
  const settings = useSettings((error) => tabs.report(error));
  // 关窗时按当时的“启动时”设置决定是否询问（见 tabs.closeWindow）；设置还没读完
  // 就关窗时等它读完，不按默认值处理。
  const [tabs] = useState(() =>
    createTabs(
      unsaved.ask,
      async () => {
        await settings.loaded;
        return settings.current.current.startup;
      },
      () => settings.current.current.defaultFileName,
    ),
  );
  const { tabs: list, active, ready, error, focus } = useSyncExternalStore(
    tabs.subscribe,
    tabs.getSnapshot,
  );
  const current = list.find((tab) => tab.id === active);
  const currentState = useSessionState(current?.session);
  const preview = useImagePreview();
  const settingsDialog = useRef<HTMLDialogElement>(null);
  // 发现新版本（Rust 启动后检查一次）与“立即更新”，以及各窗口安装前的暂存。
  const update = useUpdate(tabs);
  // 对话框非模态（标题栏照常可拖、可按），开着时其余部分 inert、盖上遮罩，见 useDialogs。
  const dialogs = useDialogs({
    dialogs: {
      unsaved: unsaved.dialog,
      update: update.dialog,
      settings: settingsDialog,
      preview: preview.dialog,
    },
    focus: tabs.focus,
    updateBusy: updateBusy(update.phase),
  });
  const dimmed = dialogs.top !== null;
  // 有别的对话框开着时，新版本提示等它关掉再弹，不叠两个对话框。
  const { waiting: updateWaiting, present: presentUpdate } = update;
  useEffect(() => {
    if (updateWaiting && dialogs.top === null) presentUpdate();
  }, [updateWaiting, dialogs.top, presentUpdate]);

  useWindowGuards(tabs);
  useCaretMetrics();
  // 编辑区与标签页的右键菜单（代替 WebView2 自带的）。
  const contextMenu = useContextMenu(tabs);
  // 正文缩放：每个窗口一个值，状态栏显示百分比。
  const zoom = useZoom();
  useWindowTitle(current, currentState?.dirty ?? false);
  // 根元素的 --dpr（屏幕缩放比例），供 CSS 画固定物理像素的分隔线；不依赖其他 hook，放在最后。
  useDevicePixelRatio();
  // 保存 / 另存为 / 导出按钮只在弹着对话框或长操作时变灰（locked），已命名文件的 Ctrl+S 不算。
  const fileDisabled =
    !currentState || currentState.locked || currentState.importing;
  return (
    <main className="app">
      <TitleBar
        tabs={list}
        active={active}
        onActivate={tabs.activate}
        onClose={(id) => void tabs.closeTab(id)}
        onNew={() => void tabs.newTab()}
        dimmed={dimmed && (dialogs.top === "preview" ? "dark" : "light")}
        onCloseWindow={dialogs.closeWindow}
      />
      <div className="app-body" inert={dimmed}>
        <Toolbar
          session={current?.session}
          fileDisabled={fileDisabled}
          settings={settings.settings}
          onNew={() => void tabs.newTab()}
          onOpen={() => void tabs.openFile()}
          onSettings={() => openSettings(settingsDialog.current)}
        />
        {error && !list.length && (
          <div className="error-banner" role="alert">
            <p>{error}</p>
          </div>
        )}
        {list.map((tab) => (
          <TabPane
            key={tab.id}
            tab={tab}
            hidden={tab.id !== active}
            focus={focus}
            zoom={zoom}
            onPreview={preview.show}
          />
        ))}
        {!ready && <div className="loading">正在打开…</div>}
        {contextMenu.menu && (
          <ContextMenu
            key={contextMenu.menu.serial}
            menu={contextMenu.menu}
            onRun={contextMenu.run}
            onClose={contextMenu.close}
          />
        )}
      </div>
      {dimmed && (
        <div
          className={`dialog-mask${dialogs.top === "preview" ? " dark" : ""}`}
          aria-hidden="true"
          onClick={dialogs.mask}
        />
      )}
      <ImagePreviewDialog
        dialogRef={preview.dialog}
        name={preview.name}
        source={preview.source}
        onSave={() => void preview.saveOriginal()}
        onClose={preview.close}
        onClosed={preview.closed}
        onLoad={() => dialogs.reveal("preview")}
      />
      <UnsavedDialog
        dialogRef={unsaved.dialog}
        name={unsaved.name}
        onClose={unsaved.closed}
      />
      <UpdateDialog
        dialogRef={update.dialog}
        info={update.info}
        phase={update.phase}
        onInstall={() => void update.install()}
        onDismiss={update.close}
        onClosed={update.closed}
      />
      <SettingsDialog
        dialogRef={settingsDialog}
        settings={settings.settings}
        onChange={settings.update}
        onReset={settings.reset}
        onClose={() => {
          settings.flush();
          tabs.focus();
        }}
      />
    </main>
  );
}

const noSubscription = () => () => {};
const noSnapshot = () => undefined;
/** The snapshot of a session that may not exist yet (before the tabs load). */
function useSessionState(session: Session | undefined) {
  return useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? noSnapshot,
  );
}

/**
 * Window title: the current tab's name; "● " marks unsaved changes. The title bar
 * is drawn by the page (TitleBar) without it; the taskbar still shows it.
 */
function useWindowTitle(tab: Tab | undefined, dirty: boolean) {
  const title = tab ? `${dirty ? "● " : ""}${displayName(tab)}` : "LineHush";
  useEffect(() => {
    void getCurrentWindow().setTitle(title).catch(console.error);
  }, [title]);
}
