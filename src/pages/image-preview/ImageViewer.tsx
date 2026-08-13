import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  calculateFitScale,
  formatImageScale,
  stepImageScale,
  zoomOffsetAroundPoint,
} from "./state";
import type { Point } from "./state";

interface ImageViewerProps {
  path: string;
  onClose: () => void;
  onOpenWindow?: () => void;
  onToggleNativeFullscreen?: () => void;
  nativeFullscreen?: boolean;
}

const ZERO_OFFSET: Point = { x: 0, y: 0 };

function ToolButton({ title, onClick, children }: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 min-w-8 px-2 flex items-center justify-center rounded-lg text-white/80 hover:text-white hover:bg-white/15 transition-colors"
      title={title}
    >
      {children}
    </button>
  );
}

export default function ImageViewer({
  path,
  onClose,
  onOpenWindow,
  onToggleNativeFullscreen,
  nativeFullscreen = false,
}: ImageViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; offset: Point } | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>(ZERO_OFFSET);
  const [fitMode, setFitMode] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const fitImage = useCallback((size = naturalSize) => {
    const viewport = viewportRef.current;
    if (!viewport || size.width <= 0 || size.height <= 0) return;
    setScale(calculateFitScale(
      size.width,
      size.height,
      viewport.clientWidth,
      viewport.clientHeight,
    ));
    setOffset(ZERO_OFFSET);
    setFitMode(true);
  }, [naturalSize]);

  const showActualSize = useCallback(() => {
    setScale(1);
    setOffset(ZERO_OFFSET);
    setFitMode(false);
  }, []);

  const zoom = useCallback((direction: 1 | -1, clientPoint?: Point) => {
    const viewport = viewportRef.current;
    setScale(current => {
      const next = stepImageScale(current, direction);
      if (viewport && clientPoint) {
        const rect = viewport.getBoundingClientRect();
        const pointFromCenter = {
          x: clientPoint.x - rect.left - rect.width / 2,
          y: clientPoint.y - rect.top - rect.height / 2,
        };
        setOffset(previous => zoomOffsetAroundPoint(previous, pointFromCenter, current, next));
      }
      return next;
    });
    setFitMode(false);
  }, []);

  useEffect(() => {
    setNaturalSize({ width: 0, height: 0 });
    setScale(1);
    setOffset(ZERO_OFFSET);
    setFitMode(true);
    setLoadError(false);
  }, [path]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (fitMode) fitImage();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitImage, fitMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [zoom]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom(1);
      } else if (event.key === "-") {
        event.preventDefault();
        zoom(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        fitImage();
      } else if (event.key === "1") {
        event.preventDefault();
        showActualSize();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [fitImage, onClose, showActualSize, zoom]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || naturalSize.width === 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: drag.offset.x + event.clientX - drag.startX,
      y: drag.offset.y + event.clientY - drag.startY,
    });
    setFitMode(false);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleFit = () => {
    if (fitMode) showActualSize();
    else fitImage();
  };

  const filename = path.split("/").pop() || "图片预览";

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#111] text-white select-none">
      <div className="absolute left-4 top-4 z-20 max-w-[40%] px-3 py-1.5 rounded-lg bg-black/45 backdrop-blur-md text-[12px] text-white/70 truncate">
        {filename}
      </div>

      <div
        ref={viewportRef}
        className="absolute inset-0 overflow-hidden touch-none"
        style={{ cursor: dragging ? "grabbing" : naturalSize.width > 0 ? "grab" : "default" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggleFit}
      >
        {!loadError && (
          <img
            key={path}
            src={convertFileSrc(path)}
            alt="预览"
            draggable={false}
            onLoad={(event) => {
              const size = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              setNaturalSize(size);
              fitImage(size);
            }}
            onError={() => setLoadError(true)}
            className="absolute left-1/2 top-1/2 max-w-none max-h-none object-contain shadow-2xl will-change-transform"
            style={{
              width: naturalSize.width > 0 ? naturalSize.width : "auto",
              height: naturalSize.height > 0 ? naturalSize.height : "auto",
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center",
            }}
          />
        )}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
            图片加载失败
          </div>
        )}
      </div>

      <div
        className="absolute z-30 left-1/2 bottom-5 -translate-x-1/2 flex items-center gap-1 p-1 rounded-xl bg-black/60 backdrop-blur-md shadow-xl border border-white/10"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <ToolButton title="缩小 (-)" onClick={() => zoom(-1)}>
          <span className="text-lg leading-none">−</span>
        </ToolButton>
        <button
          type="button"
          onClick={() => fitImage()}
          className="h-8 min-w-[62px] px-2 rounded-lg text-[12px] tabular-nums text-white/85 hover:bg-white/15 transition-colors"
          title="适应窗口 (0)"
        >
          {formatImageScale(scale)}
        </button>
        <ToolButton title="放大 (+)" onClick={() => zoom(1)}>
          <span className="text-lg leading-none">+</span>
        </ToolButton>
        <div className="w-px h-5 bg-white/15 mx-1" />
        <ToolButton title="适应窗口 (0)" onClick={fitImage}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
          </svg>
        </ToolButton>
        <ToolButton title="原始尺寸 (1)" onClick={showActualSize}>1:1</ToolButton>
        {onOpenWindow && (
          <ToolButton title="在独立窗口打开" onClick={onOpenWindow}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3h7v7M21 3l-9 9" /><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            </svg>
          </ToolButton>
        )}
        {onToggleNativeFullscreen && (
          <ToolButton title={nativeFullscreen ? "退出系统全屏" : "系统全屏"} onClick={onToggleNativeFullscreen}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {nativeFullscreen ? (
                <><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" /></>
              ) : (
                <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></>
              )}
            </svg>
          </ToolButton>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-30 w-9 h-9 flex items-center justify-center rounded-full bg-black/45 hover:bg-white/20 backdrop-blur-md transition-colors text-white"
        title="关闭 (Esc)"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
