import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "./core/session";
import { createTabs, displayName, type Tab } from "./core/tabs";
import { useCaretMetrics } from "./hooks/useCaretMetrics";
import { useDialogs } from "./hooks/useDialogs";
import { useImagePreview } from "./hooks/useImagePreview";
import { useSettings } from "./hooks/useSettings";
import { useUnsavedPrompt } from "./hooks/useUnsavedPrompt";
import { useWindowGuards } from "./hooks/useWindowGuards";
import ImagePreviewDialog from "./components/ImagePreviewDialog";
import SettingsDialog from "./components/SettingsDialog";
import TabPane from "./components/TabPane";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import UnsavedDialog from "./components/UnsavedDialog";
import "./App.css";

export default function App() {
  const unsaved = useUnsavedPrompt();
  const settings = useSettings((error) => tabs.report(error));
  // 关窗时按当时的“启动时”设置决定是否询问（见 tabs.closeWindow）；设置还没读完
  // 就关窗时等它读完，不按默认值处理。
  const [tabs] = useState(() =>
    createTabs(unsaved.ask, async () => {
      await settings.loaded;
      return settings.current.current.startup;
    }),
  );
  const { tabs: list, active, ready, error, focus } = useSyncExternalStore(
    tabs.subscribe,
    tabs.getSnapshot,
  );
  const current = list.find((tab) => tab.id === active);
  const currentState = useSessionState(current?.session);
  const preview = useImagePreview();
  const settingsDialog = useRef<HTMLDialogElement>(null);
  // 对话框非模态（标题栏照常可拖、可按），开着时其余部分 inert、盖上遮罩，见 useDialogs。
  const dialogs = useDialogs({
    dialogs: {
      unsaved: unsaved.dialog,
      settings: settingsDialog,
      preview: preview.dialog,
    },
    focus: tabs.focus,
  });
  const dimmed = dialogs.top !== null;

  useWindowGuards(tabs);
  useCaretMetrics();
  useWindowTitle(current, currentState?.dirty ?? false);
  const fileDisabled =
    !currentState || currentState.busy || currentState.importing;
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
          onSettings={() => settingsDialog.current?.show()}
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
            onPreview={preview.show}
          />
        ))}
        {!ready && <div className="loading">正在打开…</div>}
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
