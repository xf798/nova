import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ImageViewer from "./ImageViewer";
import { IMAGE_PREVIEW_CHANGE_EVENT } from "./openWindow";

export default function ImagePreviewWindow({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const previewWindow = getCurrentWebviewWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void previewWindow.listen<string>(IMAGE_PREVIEW_CHANGE_EVENT, event => {
      if (!event.payload) return;
      setPath(event.payload);
      const filename = event.payload.split("/").pop() || "图片预览";
      void previewWindow.setTitle(`${filename} - Nova 图片预览`);
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });

    void previewWindow.isFullscreen().then(setFullscreen).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const close = () => {
    void getCurrentWebviewWindow().close();
  };

  const toggleFullscreen = async () => {
    const previewWindow = getCurrentWebviewWindow();
    const next = !fullscreen;
    await previewWindow.setFullscreen(next);
    setFullscreen(next);
  };

  return (
    <ImageViewer
      path={path}
      onClose={close}
      onToggleNativeFullscreen={() => { void toggleFullscreen(); }}
      nativeFullscreen={fullscreen}
    />
  );
}
