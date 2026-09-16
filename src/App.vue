<script setup lang="ts">
import {
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  watch,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DiaryEditor from "./components/DiaryEditor.vue";
import { type Picture } from "./document";
import { imageUrl } from "./editor/image-view";
import { useSession } from "./session";
import "./style.css";
const session = useSession();
const {
  document,
  generation,
  ready,
  busy,
  dirty,
  error,
  notice,
  status,
  desktop,
  title,
} = session;
const editor = ref<InstanceType<typeof DiaryEditor>>();
const picker = ref<HTMLInputElement>();
const line = ref(1),
  column = ref(1),
  importing = ref(false);
const preview = ref<HTMLDialogElement>(),
  previewSource = ref(""),
  previewName = ref("");
const count = computed(() =>
  document.value.blocks.reduce(
    (sum, b) => sum + (b.type === "line" ? Array.from(b.text).length : 0),
    0,
  ),
);
const imageCount = computed(() =>
  document.value.blocks.reduce(
    (sum, b) => sum + (b.type === "images" ? b.images.length : 0),
    0,
  ),
);
let removeClose: (() => void) | undefined;
let previewVersion = 0;
async function showImage(pic: Picture) {
  closePreview();
  const version = ++previewVersion;
  previewName.value = pic.name;
  preview.value?.showModal();
  try {
    const url = await imageUrl(pic, true);
    if (version !== previewVersion) URL.revokeObjectURL(url);
    else previewSource.value = url;
  } catch (e) {
    closePreview();
    error.value = String(e);
  }
}
function closePreview() {
  previewVersion++;
  if (previewSource.value) URL.revokeObjectURL(previewSource.value);
  previewSource.value = "";
  preview.value?.close();
}
async function importFiles(files: File[]) {
  if (busy.value || importing.value || !files.length) return;
  if (!desktop) {
    error.value = "请在桌面版导入图片。";
    return;
  }
  const insertion = editor.value?.reserveInsertion();
  if (!insertion) return;
  importing.value = true;
  const images: Picture[] = [];
  try {
    for (const file of files) {
      notice.value = `正在处理图片 ${images.length + 1} / ${files.length}…`;
      const pic = await invoke<Picture>(
        "import_image",
        await file.arrayBuffer(),
      );
      images.push({ ...pic, name: file.name });
    }
  } catch (e) {
    error.value = String(e);
    notice.value = "";
  }
  try {
    // Keep successfully imported images visible if a later file fails.
    if (images.length) insertion.insert(images);
    else insertion.cancel();
  } catch (e) {
    insertion.cancel();
    error.value = String(e);
  } finally {
    importing.value = false;
    notice.value = "";
  }
}
function picked(event: Event) {
  const input = event.target as HTMLInputElement;
  void importFiles(Array.from(input.files ?? []));
  input.value = "";
}
function keydown(event: KeyboardEvent) {
  if (
    event.isComposing ||
    !(event.ctrlKey || event.metaKey) ||
    busy.value ||
    importing.value ||
    preview.value?.open
  )
    return;
  const key = event.key.toLowerCase();
  if (!["n", "o", "s"].includes(key) || !desktop) return;
  event.preventDefault();
  if (key === "n") void session.newDocument();
  if (key === "o") void session.openDocument();
  if (key === "s") void session.saveDocument(event.shiftKey);
}
onMounted(async () => {
  await session.initialize();
  await nextTick();
  editor.value?.focus();
  window.addEventListener("keydown", keydown);
  if (desktop) {
    try {
      removeClose = await getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        if (busy.value || importing.value) {
          notice.value = "操作仍在进行，完成后可关闭窗口。";
          return;
        }
        busy.value = true;
        try {
          await session.flush();
          await getCurrentWindow().destroy();
        } catch (e) {
          error.value = `未关闭窗口：${e}`;
        } finally {
          busy.value = false;
        }
      });
    } catch (e) {
      error.value = `无法启用关闭保护：${e}`;
    }
  }
});
watch([title, dirty], () => {
  if (desktop)
    void getCurrentWindow()
      .setTitle(`${dirty.value ? "● " : ""}${title.value} — LineHush`)
      .catch((e) => {
        error.value = String(e);
      });
});
watch(generation, async () => {
  line.value = 1;
  column.value = 1;
  await nextTick();
  editor.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", keydown);
  removeClose?.();
  closePreview();
});
</script>
<template>
  <main class="app">
    <header class="toolbar" aria-label="文件和编辑操作">
      <button
        :disabled="!desktop || busy || importing"
        title="新建 (Ctrl+N)"
        @click="session.newDocument"
      >
        新建
      </button>
      <button
        :disabled="!desktop || busy || importing"
        title="打开 (Ctrl+O)"
        @click="session.openDocument"
      >
        打开
      </button>
      <button
        :disabled="!desktop || busy || importing"
        title="保存 (Ctrl+S)"
        @click="session.saveDocument()"
      >
        保存
      </button>
      <button
        :disabled="!desktop || busy || importing"
        title="另存为 (Ctrl+Shift+S)"
        @click="session.saveDocument(true)"
      >
        另存为
      </button>
      <span class="toolbar-divider" />
      <button
        :disabled="!desktop || busy || importing"
        @mousedown.prevent
        @click="picker?.click()"
      >
        插入图片
      </button>
      <details class="export-menu">
        <summary>导出</summary>
        <div class="menu-items">
          <button
            :disabled="!desktop || busy || importing"
            @click="session.exportDocument(false)"
          >
            纯文本 (.txt)</button
          ><button
            :disabled="!desktop || busy || importing"
            @click="session.exportDocument(true)"
          >
            图文网页 (.html)
          </button>
        </div>
      </details>
      <span class="spacer" />
      <span class="document-name" :title="session.path.value ?? '未命名'"
        >{{ dirty ? "● " : "" }}{{ title }}</span
      >
      <button
        :disabled="busy"
        title="撤销 (Ctrl+Z)"
        @mousedown.prevent
        @click="editor?.undo()"
      >
        撤销
      </button>
      <button
        :disabled="busy"
        title="重做 (Ctrl+Y)"
        @mousedown.prevent
        @click="editor?.redo()"
      >
        重做
      </button>
    </header>
    <div v-if="error" class="error-banner" role="alert">
      <p>{{ error }}</p>
      <button
        @click="
          session
            .flush()
            .then(() => (error = ''))
            .catch(() => {})
        "
      >
        重试保存</button
      ><button aria-label="关闭错误提示" @click="error = ''">×</button>
    </div>
    <div v-if="notice" class="notice-banner" role="status">
      <span>{{ notice }}</span
      ><button aria-label="关闭提示" @click="notice = ''">×</button>
    </div>
    <DiaryEditor
      v-if="ready"
      :key="generation"
      ref="editor"
      :initial="document"
      :disabled="busy"
      @change="session.update"
      @files="importFiles"
      @preview="showImage"
      @selection="
        (l, c) => {
          line = l;
          column = c;
        }
      "
    />
    <div v-else class="loading">正在打开…</div>
    <footer class="statusbar">
      <span>第 {{ line }} 行，第 {{ column }} 列</span
      ><span
        >{{ count }} 字符<span v-if="imageCount">
          · {{ imageCount }} 张图片</span
        ></span
      ><span class="spacer" /><span role="status">{{ status }}</span>
    </footer>
    <input
      ref="picker"
      class="visually-hidden"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
      multiple
      tabindex="-1"
      @change="picked"
    />
    <dialog ref="preview" class="image-preview" @cancel.prevent="closePreview">
      <header>
        <span>{{ previewName }}</span
        ><button autofocus aria-label="关闭原图" @click="closePreview">
          关闭
        </button>
      </header>
      <img v-if="previewSource" :src="previewSource" :alt="previewName" />
      <p v-else>正在读取原图…</p>
    </dialog>
  </main>
</template>
