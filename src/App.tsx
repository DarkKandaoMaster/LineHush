import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "./core/session";
import { readSettings } from "./core/native";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Startup,
} from "./core/settings";
import { createTabs, displayName, type Tab } from "./core/tabs";
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
  // 关窗时按当时的“启动时”设置决定是否询问（见 tabs.closeWindow）；设置还没读完
  // 就关窗时直接读一次，不按默认值处理。
  const startup = useRef<Startup | null>(null);
  const [tabs] = useState(() =>
    createTabs(unsaved.ask, () => startup.current ?? readStartup()),
  );
  const { tabs: list, active, ready, error, focus } = useSyncExternalStore(
    tabs.subscribe,
    tabs.getSnapshot,
  );
  const current = list.find((tab) => tab.id === active);
  const currentState = useSessionState(current?.session);
  const preview = useImagePreview();
  const settings = useSettings(tabs);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (settings.loaded) startup.current = settings.settings.startup;
  }, [settings.loaded, settings.settings.startup]);

  useWindowGuards(tabs);
  useWindowTitle(tabs.desktop, current, currentState?.dirty ?? false);
  const fileDisabled =
    !tabs.desktop ||
    !currentState ||
    currentState.busy ||
    currentState.importing;
  return (
    <main className="app">
      <TitleBar
        desktop={tabs.desktop}
        tabs={list}
        active={active}
        onActivate={tabs.activate}
        onClose={(id) => void tabs.closeTab(id)}
        onNew={() => void tabs.newTab()}
      />
      <Toolbar
        session={current?.session}
        fileDisabled={fileDisabled}
        openDisabled={!tabs.desktop}
        onNew={() => void tabs.newTab()}
        onOpen={() => void tabs.openFile()}
        onSettings={() => settingsDialog.current?.showModal()}
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
      <ImagePreviewDialog
        dialogRef={preview.dialog}
        name={preview.name}
        source={preview.source}
        canSave={tabs.desktop}
        onSave={() => void preview.saveOriginal()}
        onClose={preview.close}
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

/** 设置文件里的“启动时”；读不出时为默认值。 */
function readStartup(): Promise<Startup> {
  return readSettings().then(
    (value) => normalizeSettings(value).startup,
    () => DEFAULT_SETTINGS.startup,
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
function useWindowTitle(desktop: boolean, tab: Tab | undefined, dirty: boolean) {
  const title = tab ? `${dirty ? "● " : ""}${displayName(tab)}` : "LineHush";
  useEffect(() => {
    if (desktop)
      void getCurrentWindow().setTitle(title).catch(console.error);
  }, [desktop, title]);
}
