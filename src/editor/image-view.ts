import { NodeSelection } from "@tiptap/pm/state";
import { invoke } from "@tauri-apps/api/core";
import { ImageGroup } from "./schema";
import type { Picture } from "../document";

export async function imageUrl(
  pic: Picture,
  original = false,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_image", {
    path: pic.path,
    original,
  });
  return URL.createObjectURL(new Blob([bytes]));
}
export function imageExtension(preview: (pic: Picture) => void) {
  return ImageGroup.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement("div");
        dom.className = "image-group";
        dom.contentEditable = "false";
        const urls: string[] = [];
        let destroyed = false;
        for (const pic of node.attrs.images as Picture[]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "image-tile";
          button.title = `${pic.name} · 双击查看原图`;
          button.setAttribute("aria-label", `查看图片 ${pic.name}`);
          const scale = Math.min(1, 280 / pic.width, 200 / pic.height);
          button.style.width = `${Math.max(48, Math.round(pic.width * scale))}px`;
          button.style.height = `${Math.max(48, Math.round(pic.height * scale))}px`;
          const img = document.createElement("img");
          img.alt = pic.name;
          img.draggable = false;
          img.loading = "lazy";
          img.decoding = "async";
          button.append(img);
          dom.append(button);
          void imageUrl(pic)
            .then((url) => {
              if (destroyed) {
                URL.revokeObjectURL(url);
                return;
              }
              urls.push(url);
              img.src = url;
            })
            .catch(() => {
              if (!destroyed) {
                button.textContent = "附件缺失或无法读取";
                button.classList.add("image-error");
              }
            });
          button.addEventListener("click", () => {
            const pos = getPos();
            if (pos !== undefined)
              editor.view.dispatch(
                editor.state.tr.setSelection(
                  NodeSelection.create(editor.state.doc, pos),
                ),
              );
          });
          button.addEventListener("dblclick", () => preview(pic));
          button.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              preview(pic);
            }
          });
        }
        return {
          dom,
          stopEvent: (event) => event.type === "dblclick",
          ignoreMutation: () => true,
          destroy: () => {
            destroyed = true;
            urls.forEach(URL.revokeObjectURL);
          },
        };
      };
    },
  });
}
