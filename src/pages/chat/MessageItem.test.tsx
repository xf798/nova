import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import type { Message } from "../../core/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(),
}));

const MessageItem = (await import("./MessageItem")).default;

const message = (role: Message["role"]): Message => ({
  id: `msg-${role}`,
  role,
  content: `${role} 内容`,
  timestamp: "2026-08-12T10:00:00Z",
});

describe("MessageItem — 单条消息删除入口", () => {
  for (const role of ["user", "assistant", "system"] as const) {
    it(`${role} 消息传入 onDelete 时显示删除按钮`, () => {
      const html = renderToString(React.createElement(MessageItem, {
        message: message(role),
        onImageClick: vi.fn(),
        onDelete: vi.fn(),
      }));
      expect(html).toContain('title="删除"');
    });
  }

  it("未传 onDelete 时不显示删除按钮", () => {
    const html = renderToString(React.createElement(MessageItem, {
      message: message("user"),
      onImageClick: vi.fn(),
    }));
    expect(html).not.toContain('title="删除"');
  });
});


describe("MessageItem — 消息来源", () => {
  it("企微消息显示通道和发送人", () => {
    const html = renderToString(React.createElement(MessageItem, {
      message: { ...message("user"), origin: { channel: "wecom", senderName: "张三" } },
      onImageClick: vi.fn(),
    }));
    expect(html).toContain("企微");
    expect(html).toContain("张三");
  });

  it("桌面消息不显示企微来源", () => {
    const html = renderToString(React.createElement(MessageItem, {
      message: message("assistant"),
      onImageClick: vi.fn(),
    }));
    expect(html).not.toContain("企微");
  });
});
