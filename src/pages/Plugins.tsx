import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../App";
import { getAvailablePlugins, enablePlugin, disablePlugin } from "../plugins";
import { deleteSkill as deleteSkillGlobal, reloadSkills } from "../core/skills";

/** 弹 toast（复用 App 的 nova-notify 监听） */
function toast(msg: string, type: "info" | "success" | "error" = "info") {
  window.dispatchEvent(new CustomEvent("nova-notify", { detail: { msg, type } }));
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
  has_references: boolean;
}

function Plugins() {
  const { navigateTo } = useAppStore();
  const [, setTick] = useState(0);
  const available = getAvailablePlugins();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  // Skill 预览/编辑
  const [viewingSkill, setViewingSkill] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    setSkillsLoading(true);
    try {
      const list = await invoke<SkillInfo[]>("get_skills");
      setSkills(list);
    } catch {
      setSkills([]);
    }
    setSkillsLoading(false);
  };

  const handleDeleteSkill = async (name: string) => {
    try {
      // 用全局删除：invoke delete_skill + 从 skillRegistry 注销，保证 Settings 等处同步
      await deleteSkillGlobal(name);
      if (viewingSkill === name) {
        setViewingSkill(null);
        setSkillContent("");
        setIsEditing(false);
      }
      await loadSkills();
      // 通知其他页面（Settings 蒸馏产物列表）刷新
      window.dispatchEvent(new CustomEvent("nova-skills-changed"));
      toast(`已删除 skill：${name}`, "success");
    } catch (e: any) {
      toast(`删除失败: ${e?.message || e}`, "error");
    } finally {
      setConfirmingDelete(null);
    }
  };

  const handleViewSkill = async (name: string) => {
    try {
      const content = await invoke<string>("get_skill_content", { name });
      setSkillContent(content);
      setViewingSkill(name);
      setIsEditing(false);
    } catch (e: any) {
      toast(`读取失败: ${e}`, "error");
    }
  };

  const handleSaveSkill = async () => {
    if (!viewingSkill) return;
    setSaving(true);
    try {
      await invoke("save_skill", { name: viewingSkill, content: skillContent });
      setIsEditing(false);
      await loadSkills();
      await reloadSkills();
      window.dispatchEvent(new CustomEvent("nova-skills-changed"));
    } catch (e: any) {
      toast(`保存失败: ${e}`, "error");
    }
    setSaving(false);
  };

  const handleToggle = async (pluginId: string, currentlyEnabled: boolean) => {
    if (currentlyEnabled) {
      await disablePlugin(pluginId);
    } else {
      await enablePlugin(pluginId);
    }
    setTick(t => t + 1);
  };

  return (
    <div className="max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Plugins</h2>
      </div>

      <p className="text-[13px] text-app-text-muted mb-6">
        管理 Nova 插件。启用或禁用插件后，侧边栏和功能会实时更新。
      </p>

      {available.length === 0 ? (
        <div className="text-center py-20 text-app-text-muted">
          <p className="text-base mb-2">暂无可用插件</p>
        </div>
      ) : (
        <div className="space-y-2">
          {available.map(({ plugin: p, enabled }) => {
            const hasSidebar = (p.sidebarItems || []).length > 0;
            const hasSettings = (p.settingsSections || []).length > 0;
            const hasPage = !!p.page || hasSidebar;

            return (
              <div
                key={p.id}
                className="flex items-center justify-between px-4 py-4 rounded-xl border border-app-border hover:border-app-text-muted transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-app-text">{p.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-full font-medium">v{p.version}</span>
                    {hasSidebar && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded-full font-medium">侧边栏</span>
                    )}
                    {hasSettings && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded-full font-medium">设置</span>
                    )}
                  </div>
                  <p className="text-[12px] text-app-text-muted mt-0.5">
                    {p.description || ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 ml-4 shrink-0">
                  {hasPage && enabled && (
                    <button
                      onClick={() => navigateTo(hasSidebar ? (p.sidebarItems![0].id) : p.id)}
                      className="px-2.5 py-1 text-[12px] rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
                    >
                      打开
                    </button>
                  )}
                  <button
                    onClick={() => handleToggle(p.id, enabled)}
                    className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-[#10a37f]' : 'bg-app-border'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`}></span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8" />

      {/* Skills 区块 */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">AI Skills</h2>
          <span className="text-[11px] text-app-text-muted">~/.nova/skills/</span>
        </div>
        <p className="text-[13px] text-app-text-muted mb-4">
          通过对话创建的 AI 技能。Skills 定义了 AI 的专属能力和行为规则。
        </p>

        {skillsLoading ? (
          <div className="text-center py-10 text-app-text-muted text-[13px]">加载中...</div>
        ) : skills.length === 0 ? (
          <div className="text-center py-10 text-app-text-muted">
            <p className="text-base mb-2">暂无 Skills</p>
            <p className="text-[12px]">在对话中让 AI 创建 skill，会自动出现在这里</p>
          </div>
        ) : (
          <div className="space-y-2">
            {skills.map(skill => (
              <div
                key={skill.name}
                className="px-4 py-4 rounded-xl border border-app-border hover:border-app-text-muted transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-app-text">{skill.name}</span>
                      {skill.has_references && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded-full font-medium">有引用</span>
                      )}
                    </div>
                    <p className="text-[12px] text-app-text-muted mt-0.5 line-clamp-2">{skill.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0">
                    <button
                      onClick={() => {
                        if (viewingSkill === skill.name) {
                          setViewingSkill(null);
                          setSkillContent("");
                          setIsEditing(false);
                        } else {
                          handleViewSkill(skill.name);
                        }
                      }}
                      className="px-2.5 py-1 text-[12px] rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
                    >
                      {viewingSkill === skill.name ? "收起" : "查看"}
                    </button>
                    {confirmingDelete === skill.name ? (
                      <>
                        <button
                          onClick={() => handleDeleteSkill(skill.name)}
                          className="px-2.5 py-1 text-[12px] rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                        >
                          确认删除
                        </button>
                        <button
                          onClick={() => setConfirmingDelete(null)}
                          className="px-2.5 py-1 text-[12px] rounded-lg text-app-text-muted hover:bg-app-surface-hover transition-colors"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmingDelete(skill.name)}
                        className="px-2.5 py-1 text-[12px] rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>

                {/* 预览/编辑面板 */}
                {viewingSkill === skill.name && (
                  <div className="mt-3 border-t border-app-border pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-app-text-muted font-medium">SKILL.md</span>
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <>
                            <button
                              onClick={() => { setIsEditing(false); handleViewSkill(skill.name); }}
                              className="px-2 py-0.5 text-[11px] rounded-md text-app-text-muted hover:bg-app-surface-hover transition-colors"
                            >
                              取消
                            </button>
                            <button
                              onClick={handleSaveSkill}
                              disabled={saving}
                              className="px-2 py-0.5 text-[11px] rounded-md bg-[#10a37f] text-white hover:bg-[#0d8c6d] transition-colors disabled:opacity-50"
                            >
                              {saving ? "保存中..." : "保存"}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { navigator.clipboard.writeText(skillContent); }}
                              className="px-2 py-0.5 text-[11px] rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
                            >
                              复制
                            </button>
                            <button
                              onClick={() => setIsEditing(true)}
                              className="px-2 py-0.5 text-[11px] rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
                            >
                              编辑
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {isEditing ? (
                      <textarea
                        value={skillContent}
                        onChange={(e) => setSkillContent(e.target.value)}
                        className="w-full h-[300px] px-3 py-2 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text font-mono resize-y focus:outline-none focus:border-app-text-muted"
                        spellCheck={false}
                      />
                    ) : (
                      <pre className="w-full max-h-[300px] overflow-auto px-3 py-2 rounded-lg bg-app-bg border border-app-border text-[12px] text-app-text-secondary font-mono whitespace-pre-wrap">
                        {skillContent}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部留白 */}
      <div className="h-20" />
    </div>
  );
}

export default Plugins;
