import { useLayoutEffect } from "react";

/**
 * 把 window.devicePixelRatio 写到 <html> 的 --dpr，供 CSS 画固定物理像素的线
 * （如工具栏下边线 calc(2px / var(--dpr, 1))）。每个窗口各自的 document 各写一份；
 * 拖到缩放比例不同的显示器上时 DPR 会变，照 TitleBar 用 resolution 媒体查询的
 * change 事件重新注册并更新。在绘制前写入，首帧就是对的。
 */
export function useDevicePixelRatio() {
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    let media: MediaQueryList | undefined;
    const update = () => {
      const dpr = window.devicePixelRatio || 1;
      style.setProperty("--dpr", String(dpr));
      media?.removeEventListener("change", update);
      media = matchMedia(`(resolution: ${dpr}dppx)`);
      media.addEventListener("change", update);
    };
    update();
    return () => {
      media?.removeEventListener("change", update);
      style.removeProperty("--dpr");
    };
  }, []);
}
