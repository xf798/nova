// ===== 主内容区路由 =====

import ChatView from "../pages/ChatView";
import Tasks from "../pages/Tasks";
import ConnectorsPage from "../pages/Connectors";
import Plugins from "../pages/Plugins";
import Settings from "../pages/Settings";
import { pluginRegistry } from "../plugins";

interface MainContentProps {
  currentPage: string;
}

export default function MainContent({ currentPage }: MainContentProps) {
  const renderOtherPage = () => {
    switch (currentPage) {
      case "chat": return null;
      case "tasks": return <div className="h-full overflow-auto p-8 flex justify-center"><Tasks /></div>;
      case "plugins": return <div className="h-full overflow-auto px-8 pt-8 pb-20 flex justify-center"><Plugins /></div>;
      case "connectors": return <div className="h-full overflow-auto p-8 flex justify-center"><ConnectorsPage /></div>;
      case "settings": return <div className="h-full overflow-auto p-8 flex justify-center"><Settings /></div>;
      default: {
        const pluginSidebarItems = pluginRegistry.getSidebarItems();
        const sidebarItem = pluginSidebarItems.find(item => item.id === currentPage);
        if (sidebarItem) return <div className="h-full overflow-auto p-8 flex justify-center">{sidebarItem.component()}</div>;
        // 直接用 currentPage 作为 pluginId 查找 page 组件
        const pageComponent = pluginRegistry.getPageComponent(currentPage);
        if (pageComponent) return <div className="h-full overflow-auto p-8 flex justify-center">{pageComponent()}</div>;
        if (currentPage.startsWith("plugin:")) {
          const pluginId = currentPage.slice("plugin:".length);
          const prefixedComponent = pluginRegistry.getPageComponent(pluginId);
          if (prefixedComponent) return <div className="h-full overflow-auto p-8 flex justify-center">{prefixedComponent()}</div>;
        }
        return null;
      }
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 全局拖拽 title bar */}
      <div className="h-11 shrink-0" data-tauri-drag-region />
      <div className="flex-1 overflow-hidden">
        {/* ChatView 始终渲染，通过 display:none 隐藏，避免卸载导致 input 草稿丢失 */}
        <div className="h-full" style={{ display: currentPage === "chat" ? undefined : "none" }}>
          <ChatView />
        </div>
        {currentPage !== "chat" && renderOtherPage()}
      </div>
    </div>
  );
}
