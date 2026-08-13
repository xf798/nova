import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const IMAGE_PREVIEW_WINDOW_LABEL = "image-preview";
export const IMAGE_PREVIEW_CHANGE_EVENT = "image-preview-change";

function previewUrl(path: string): string {
  return `index.html?imagePreview=${encodeURIComponent(path)}`;
}

export async function openImagePreviewWindow(path: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(IMAGE_PREVIEW_WINDOW_LABEL);
  if (existing) {
    await existing.emit(IMAGE_PREVIEW_CHANGE_EVENT, path);
    await existing.show();
    await existing.setFocus();
    return;
  }

  const filename = path.split("/").pop() || "图片预览";
  const previewWindow = new WebviewWindow(IMAGE_PREVIEW_WINDOW_LABEL, {
    url: previewUrl(path),
    title: `${filename} - Nova 图片预览`,
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    center: true,
    focus: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("创建图片预览窗口超时")), 10000);
    void previewWindow.once("tauri://created", () => {
      window.clearTimeout(timeout);
      resolve();
    });
    void previewWindow.once("tauri://error", (event) => {
      window.clearTimeout(timeout);
      reject(new Error(String(event.payload || "创建图片预览窗口失败")));
    });
  });
}
