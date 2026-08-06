mod models;
mod mcp_server;
mod wecom;
mod coding_tools;

/// 安全的 println 宏，在无终端（GUI 应用）环境中不会 panic
macro_rules! safe_println {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let msg = format!($($arg)*);
        let _ = std::io::stdout().write_all(msg.as_bytes());
        let _ = std::io::stdout().write_all(b"\n");
        let _ = std::io::stdout().flush();
    }};
}

use models::AppConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use wecom::{WeComBot, WeComConfig, WeComReply};

// ─── Skill 管理相关结构 ───

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillInfo {
    name: String,
    description: String,
    path: String,
    has_references: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<serde_json::Value>,
}

fn skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nova")
        .join("skills")
}

/// 获取所有已安装的 skill 列表
#[tauri::command]
fn get_skills() -> Vec<SkillInfo> {
    let dir = skills_dir();
    let mut skills = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let description = parse_skill_description(&skill_md);
            let has_references = path.join("references").is_dir();

            // 读取 skill.config.json（如果存在）
            let config_path = path.join("skill.config.json");
            let config = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok());

            skills.push(SkillInfo {
                name,
                description,
                path: path.to_string_lossy().to_string(),
                has_references,
                config,
            });
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// 获取单个 skill 的 SKILL.md 内容
#[tauri::command]
fn get_skill_content(name: String) -> Result<String, String> {
    let skill_md = skills_dir().join(&name).join("SKILL.md");
    std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("读取 skill 失败: {}", e))
}

/// 保存/创建 skill（写入 SKILL.md）并自动同步 symlink 到 kiro
#[tauri::command]
fn save_skill(name: String, content: String) -> Result<(), String> {
    let skill_dir = skills_dir().join(&name);
    std::fs::create_dir_all(&skill_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let skill_md = skill_dir.join("SKILL.md");
    std::fs::write(&skill_md, &content).map_err(|e| format!("写入失败: {}", e))?;

    // 自动在 ~/.kiro/skills/ 下创建 symlink
    let kiro_skills = dirs::home_dir()
        .unwrap_or_default()
        .join(".kiro")
        .join("skills");
    std::fs::create_dir_all(&kiro_skills).map_err(|e| format!("创建 kiro skills 目录失败: {}", e))?;
    let link_path = kiro_skills.join(&name);
    if !link_path.exists() && !link_path.is_symlink() {
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&skill_dir, &link_path);
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(&skill_dir, &link_path);
    }

    Ok(())
}

/// 删除 skill（同时清理 ~/.kiro/skills/ 中的 symlink）
#[tauri::command]
fn delete_skill(name: String) -> Result<(), String> {
    let skill_dir = skills_dir().join(&name);
    if !skill_dir.exists() {
        return Err("skill 不存在".to_string());
    }

    // 先清理 kiro 中的 symlink
    let kiro_link = dirs::home_dir()
        .unwrap_or_default()
        .join(".kiro")
        .join("skills")
        .join(&name);
    if kiro_link.is_symlink() {
        let _ = std::fs::remove_file(&kiro_link);
    }

    std::fs::remove_dir_all(&skill_dir).map_err(|e| format!("删除失败: {}", e))?;
    Ok(())
}

/// 同步 skills 到 ~/.kiro/skills（为每个 skill 创建软链接）
#[tauri::command]
fn sync_skills_to_kiro() -> Result<String, String> {
    let source = skills_dir();
    if !source.exists() {
        std::fs::create_dir_all(&source).map_err(|e| e.to_string())?;
    }

    let kiro_skills = dirs::home_dir()
        .unwrap_or_default()
        .join(".kiro")
        .join("skills");

    // 确保 ~/.kiro/skills 目录存在
    std::fs::create_dir_all(&kiro_skills).map_err(|e| e.to_string())?;

    let mut synced = 0u32;
    let mut skipped = 0u32;

    // 遍历 ~/.nova/skills/ 下的每个 skill 目录
    let entries = std::fs::read_dir(&source).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_name = match path.file_name() {
            Some(n) => n.to_os_string(),
            None => continue,
        };
        let link_path = kiro_skills.join(&skill_name);

        // 如果目标已存在
        if link_path.exists() || link_path.is_symlink() {
            let meta = std::fs::symlink_metadata(&link_path);
            if let Ok(m) = meta {
                if m.file_type().is_symlink() {
                    // 已是 symlink，检查是否指向我们的目录
                    if let Ok(target) = std::fs::read_link(&link_path) {
                        if target == path {
                            skipped += 1;
                            continue;
                        }
                    }
                    // 指向别处，更新
                    std::fs::remove_file(&link_path).map_err(|e| e.to_string())?;
                } else {
                    // 真实目录/文件，跳过不覆盖
                    skipped += 1;
                    continue;
                }
            }
        }

        // 创建软链接
        #[cfg(unix)]
        std::os::unix::fs::symlink(&path, &link_path)
            .map_err(|e| format!("创建软链接失败 {}: {}", skill_name.to_string_lossy(), e))?;

        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&path, &link_path)
            .map_err(|e| format!("创建软链接失败 {}: {}", skill_name.to_string_lossy(), e))?;

        synced += 1;
    }

    // 清理：移除 ~/.kiro/skills 中指向 ~/.nova/skills 下已删除 skill 的无效 symlink
    if let Ok(kiro_entries) = std::fs::read_dir(&kiro_skills) {
        for entry in kiro_entries.flatten() {
            let link = entry.path();
            if let Ok(meta) = std::fs::symlink_metadata(&link) {
                if meta.file_type().is_symlink() {
                    if let Ok(target) = std::fs::read_link(&link) {
                        if target.starts_with(&source) && !target.exists() {
                            let _ = std::fs::remove_file(&link);
                        }
                    }
                }
            }
        }
    }

    Ok(format!("同步完成：新增 {} 个，跳过 {} 个", synced, skipped))
}

/// 启动时从 ~/.kiro/skills 同步到 ~/.nova/skills（反向同步）
/// 只复制 kiro 中非 symlink 的真实 skill 目录
#[tauri::command]
fn sync_kiro_skills_to_app() -> Result<String, String> {
    let app_skills = skills_dir();
    std::fs::create_dir_all(&app_skills).map_err(|e| e.to_string())?;

    let kiro_skills = dirs::home_dir()
        .unwrap_or_default()
        .join(".kiro")
        .join("skills");

    if !kiro_skills.exists() {
        return Ok("~/.kiro/skills 不存在，跳过".to_string());
    }

    let mut synced = 0u32;

    let entries = std::fs::read_dir(&kiro_skills).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // 只处理真实目录（跳过 symlink，那些是我们自己创建的）
        if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
            continue;
        }

        // 检查是否有 SKILL.md
        if !path.join("SKILL.md").exists() {
            continue;
        }

        let skill_name = match path.file_name() {
            Some(n) => n.to_os_string(),
            None => continue,
        };

        let dest = app_skills.join(&skill_name);
        if dest.exists() {
            // 已存在，跳过
            continue;
        }

        // 复制整个目录
        if copy_dir_recursive(&path, &dest).is_ok() {
            synced += 1;
        }
    }

    Ok(format!("从 kiro 同步 {} 个 skill", synced))
}

/// 递归复制目录
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ─── 内置 skill 同步 ───
//
// 目标：应用升级后，包内 skill 的更新（SKILL.md / scripts）能推到用户目录，
// 同时不覆盖用户自己的改动，也绝不触碰凭据与运行时状态。
//
// 判断「用户改过」需要一个基线：manifest 记录每个文件上次同步时的 hash。
//   - 本地缺失            → 复制
//   - 本地 hash == 基线   → 用户没动过，覆盖为包内新版
//   - 本地 hash != 基线   → 用户改过（或首次运行无基线），跳过并把当前 hash 记为新基线
//
// 包内不存在的 skill 目录（用户自建、蒸馏产出）完全不遍历，天然不受影响。

/// 同步基线清单，存于 ~/.nova/skills/.sync-manifest.json
const SKILL_SYNC_MANIFEST: &str = ".sync-manifest.json";

/// 判断相对路径是否为「绝不写入」的凭据 / 运行时状态文件。
///
/// 包内理论上不含凭据（只放 *.example.json），此处是防御性拦截：
/// 万一误把凭据打进包，也不会覆盖用户已有的配置。
fn is_protected_skill_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);

    // 浏览器登录态等运行时产物
    if name.contains("storage_state") {
        return true;
    }
    // 运行时目录
    if rel.contains("/.venv/") || rel.contains("/__pycache__/") || name.ends_with(".pyc") {
        return true;
    }
    // config/ 下的真实配置（*.example.json 是模板，允许同步）
    if rel.contains("config/") && name.ends_with(".json") && !name.ends_with(".example.json") {
        return true;
    }
    false
}

fn sha256_file(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// 收集目录下所有文件的相对路径（跳过运行时目录）
fn collect_rel_files(root: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name == ".venv" || name == "__pycache__" || name == ".git" {
                continue;
            }
            collect_rel_files(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// 同步结果统计（仅用于日志）
struct SkillSyncStats {
    copied: usize,
    updated: usize,
    kept: usize,
    protected: usize,
}

/// 把包内内置 skill 同步到用户目录。
fn sync_bundled_skills(
    bundled_root: &std::path::Path,
    dest_root: &std::path::Path,
    app_version: &str,
) -> SkillSyncStats {
    let mut stats = SkillSyncStats { copied: 0, updated: 0, kept: 0, protected: 0 };

    let manifest_path = dest_root.join(SKILL_SYNC_MANIFEST);

    // 读取旧 manifest
    let old: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    // 同版本已同步过则跳过（首次无 manifest 时仍需建立基线）
    if old.get("lastSyncedAppVersion").and_then(|v| v.as_str()) == Some(app_version) {
        safe_println!("[Nova] Skill 同步: 版本 {} 已同步过，跳过", app_version);
        return stats;
    }

    let old_files = old.get("files").cloned().unwrap_or_else(|| serde_json::json!({}));
    let mut new_files = serde_json::Map::new();

    let skill_dirs = match std::fs::read_dir(bundled_root) {
        Ok(e) => e,
        Err(_) => return stats,
    };

    for entry in skill_dirs.flatten() {
        let src_skill = entry.path();
        if !src_skill.is_dir() {
            continue;
        }
        let skill_name = entry.file_name().to_string_lossy().to_string();
        let dest_skill = dest_root.join(&skill_name);

        // 首次释放：整目录复制
        if !dest_skill.exists() {
            if let Err(e) = copy_dir_recursive(&src_skill, &dest_skill) {
                safe_println!("[Nova] Skill 释放失败 {}: {}", skill_name, e);
                continue;
            }
            let mut rels = Vec::new();
            collect_rel_files(&src_skill, &src_skill, &mut rels);
            for rel in rels {
                let key = format!("{}/{}", skill_name, rel);
                if let Some(h) = sha256_file(&dest_skill.join(&rel)) {
                    new_files.insert(key, serde_json::json!(h));
                }
                stats.copied += 1;
            }
            safe_println!("[Nova] Skill 首次释放: {}", skill_name);
            continue;
        }

        // 已存在：逐文件比对
        let mut rels = Vec::new();
        collect_rel_files(&src_skill, &src_skill, &mut rels);

        for rel in rels {
            let key = format!("{}/{}", skill_name, rel);

            if is_protected_skill_file(&rel) {
                stats.protected += 1;
                continue;
            }

            let src_file = src_skill.join(&rel);
            let dest_file = dest_skill.join(&rel);

            // 本地缺失 → 直接补
            if !dest_file.exists() {
                if let Some(parent) = dest_file.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::copy(&src_file, &dest_file).is_ok() {
                    if let Some(h) = sha256_file(&dest_file) {
                        new_files.insert(key, serde_json::json!(h));
                    }
                    stats.copied += 1;
                    safe_println!("[Nova] Skill 新增文件: {}", rel);
                }
                continue;
            }

            let local_hash = match sha256_file(&dest_file) {
                Some(h) => h,
                None => continue,
            };
            let baseline = old_files.get(&key).and_then(|v| v.as_str());

            if baseline == Some(local_hash.as_str()) {
                // 用户未改动过 → 可安全覆盖
                let src_hash = sha256_file(&src_file);
                if src_hash.as_deref() == Some(local_hash.as_str()) {
                    // 内容本就相同，无需写盘
                    new_files.insert(key, serde_json::json!(local_hash));
                    stats.kept += 1;
                } else if std::fs::copy(&src_file, &dest_file).is_ok() {
                    if let Some(h) = sha256_file(&dest_file) {
                        new_files.insert(key, serde_json::json!(h));
                    }
                    stats.updated += 1;
                    safe_println!("[Nova] Skill 更新文件: {}", rel);
                }
            } else {
                // 用户改过，或首次运行无基线 → 保留本地，并将当前状态记为新基线
                new_files.insert(key, serde_json::json!(local_hash));
                stats.kept += 1;
            }
        }
    }

    // 写回 manifest
    let manifest = serde_json::json!({
        "lastSyncedAppVersion": app_version,
        "updatedAt": chrono_now(),
        "files": new_files,
    });
    if let Ok(json) = serde_json::to_string_pretty(&manifest) {
        let _ = std::fs::write(&manifest_path, json);
    }

    stats
}

/// 简易 ISO8601 时间戳（避免为此引入 chrono 依赖）
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

/// 从 SKILL.md 的 frontmatter 中解析 description
fn parse_skill_description(path: &PathBuf) -> String {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    // 简单解析 YAML frontmatter
    if !content.starts_with("---") {
        return String::new();
    }

    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return String::new();
    }

    let frontmatter = parts[1];
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("description:") {
            return trimmed
                .trim_start_matches("description:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
        }
    }

    String::new()
}

fn data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nova")
}

/// 获取应用配置
#[tauri::command]
fn get_config() -> AppConfig {
    let dir = data_dir();
    let config_path = dir.join("config.json");
    
    // 先尝试从本地配置读取
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            if !config.tchub_token.is_empty() {
                return config;
            }
        }
    }
    
    // 如果本地没有 token，尝试从 ai-develop-team 的 mcp.json 读取
    let mut config = AppConfig::default();
    let mcp_path = "/Users/wangxf/workspace/ai-develop-team/.kiro/settings/mcp.json";
    if let Ok(content) = std::fs::read_to_string(mcp_path) {
        if let Ok(mcp) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(auth) = mcp.pointer("/mcpServers/tchub/headers/Authorization").and_then(|v| v.as_str()) {
                // 格式: "Bearer ${TCH_API_TOKEN}" 或直接 token
                let token = auth.replace("Bearer ", "").replace("${TCH_API_TOKEN}", "");
                if token.is_empty() || token.contains("${") {
                    // 是环境变量引用，从环境变量读取
                    if let Ok(env_token) = std::env::var("TCH_API_TOKEN") {
                        config.tchub_token = env_token;
                    }
                } else {
                    config.tchub_token = token;
                }
            }
        }
    }
    
    // 如果还没有，直接读环境变量
    if config.tchub_token.is_empty() {
        if let Ok(env_token) = std::env::var("TCH_API_TOKEN") {
            config.tchub_token = env_token;
        }
    }
    
    config
}

/// 保存应用配置
#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config_path = dir.join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 聊天历史默认结构
fn default_chat_history() -> serde_json::Value {
    serde_json::json!({
        "activeSessionId": null,
        "sessions": [],
        "deletedSessions": {}
    })
}

/// 通过 create_new 锁文件实现跨 Nova 进程互斥，避免并发读改写覆盖。
struct ChatHistoryLock {
    path: PathBuf,
}

impl Drop for ChatHistoryLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_chat_history_lock(dir: &std::path::Path) -> Result<ChatHistoryLock, String> {
    use std::fs::OpenOptions;
    use std::io::ErrorKind;
    use std::thread;
    use std::time::{Duration, SystemTime};

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("chat-history.lock");

    for _ in 0..500 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(ChatHistoryLock { path }),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                // 上个进程异常退出时清理遗留锁；正常写入远小于 10 秒。
                let is_stale = std::fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .and_then(|modified| SystemTime::now().duration_since(modified).map_err(std::io::Error::other))
                    .map(|age| age > Duration::from_secs(10))
                    .unwrap_or(false);
                if is_stale {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    Err("等待聊天历史写锁超时".to_string())
}

fn session_updated_at(session: &serde_json::Value) -> &str {
    session
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .unwrap_or("")
}

/// 合并磁盘和当前客户端的快照。同 ID 会话保留 updatedAt 更新的一份；不同 ID 全部保留。
fn merge_chat_history(
    existing: &serde_json::Value,
    incoming: &serde_json::Value,
) -> serde_json::Value {
    use std::collections::{HashMap, HashSet};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut sessions: HashMap<String, serde_json::Value> = HashMap::new();
    for session in existing
        .get("sessions")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(id) = session.get("id").and_then(|value| value.as_str()) {
            sessions.insert(id.to_string(), session.clone());
        }
    }

    for session in incoming
        .get("sessions")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        let Some(id) = session.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let should_replace = sessions
            .get(id)
            .map(|saved| session_updated_at(session) >= session_updated_at(saved))
            .unwrap_or(true);
        if should_replace {
            sessions.insert(id.to_string(), session.clone());
        }
    }

    // tombstone 防止另一个仍持有旧快照的客户端把已删除会话重新写回来。
    let mut deleted_sessions = existing
        .get("deletedSessions")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let deleted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    for id in incoming
        .get("deletedSessionIds")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
    {
        deleted_sessions.insert(id.to_string(), serde_json::json!(deleted_at));
    }

    let deleted_ids: HashSet<&str> = deleted_sessions.keys().map(String::as_str).collect();
    sessions.retain(|id, _| !deleted_ids.contains(id.as_str()));

    let mut merged_sessions: Vec<_> = sessions.into_values().collect();
    merged_sessions.sort_by(|left, right| session_updated_at(right).cmp(session_updated_at(left)));

    let active_session_id = incoming
        .get("activeSessionId")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let active_session_id = match active_session_id.as_str() {
        Some(id) if deleted_ids.contains(id) => serde_json::Value::Null,
        _ => active_session_id,
    };

    serde_json::json!({
        "activeSessionId": active_session_id,
        "sessions": merged_sessions,
        "deletedSessions": deleted_sessions
    })
}

/// 读取聊天历史
#[tauri::command]
fn get_chat_history() -> serde_json::Value {
    let file = data_dir().join("chat-history.json");
    if let Ok(content) = std::fs::read_to_string(&file) {
        serde_json::from_str(&content).unwrap_or_else(|_| default_chat_history())
    } else {
        default_chat_history()
    }
}

/// 保存聊天历史：加跨进程锁后重新读取并合并，再通过临时文件原子替换。
#[tauri::command]
fn save_chat_history(data: serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::Write;

    let dir = data_dir();
    let _lock = acquire_chat_history_lock(&dir)?;
    let file = dir.join("chat-history.json");
    let existing = std::fs::read_to_string(&file)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(default_chat_history);
    let merged = merge_chat_history(&existing, &data);
    let json = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;

    let temp_file = dir.join(format!("chat-history.{}.tmp", std::process::id()));
    let mut temp = std::fs::File::create(&temp_file).map_err(|e| e.to_string())?;
    temp.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    temp.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&temp_file, &file).map_err(|e| {
        let _ = std::fs::remove_file(&temp_file);
        e.to_string()
    })?;

    Ok(merged)
}

// ─── Split-File Session Storage ───

fn sessions_dir() -> PathBuf {
    data_dir().join("data").join("sessions")
}

fn sessions_index_path() -> PathBuf {
    data_dir().join("data").join("sessions-index.json")
}

/// 首屏消息条数。
///
/// 前端通过 get_session_page_size 读取，避免两侧各写一份而漂移
/// （改造前 sessionStorage.ts / sessionStore.ts / 这里共三份硬编码 50）。
///
/// 取 20 是在两个成本之间取平衡：
/// - 太大（50）：要渲染 574 个块元素、105ms，大部分内容在视口外根本看不到
/// - 太小（10）：常撑不满视口，触发自动补加载 → 多一次 IPC + 全量重渲染，
///   总工作量反而更高（先渲染 10 条再渲染 40 条 > 直接渲染 20 条）
/// 实测 20 条同步渲染 10-60ms，均低于感知阈值，块数也足够撑满一屏。
const SESSION_PAGE_SIZE: usize = 20;

/// 往上翻历史时每次加载的条数。
///
/// 比首屏大：首屏追求尽快出现，翻页时用户已经在等待，一次多给点能少翻几次。
const SESSION_LOAD_MORE_SIZE: usize = 30;

/// 供前端读取分页大小，保证前后端同源
#[tauri::command]
fn get_session_page_size() -> serde_json::Value {
    serde_json::json!({
        "firstPage": SESSION_PAGE_SIZE,
        "loadMore": SESSION_LOAD_MORE_SIZE,
    })
}

// ===== 会话存储布局 =====//
// 一个会话拆成三个文件：
//   {id}.meta.json        会话元信息（title/connectorId/memory/modelId…），不含 messages
//   {id}.messages.jsonl   每行一条已完成的消息，只追加
//   {id}.partial.json     正在流式生成的最后一条消息，可反复重写（单条，KB 级）
//
// 改成追加式是为了解决三件事（旧格式是「整体 JSON 全量重写」）：
//   1. 数据丢失：前端内存只有最近 50 条，全量覆盖会把磁盘上的历史冲掉
//   2. 写放大：一条消息触发 1.2MB 重写，20 轮对话写 72MB（实际内容 200KB）
//   3. 流式崩溃丢内容：全量重写太贵 → 只能靠防抖少写 → 崩溃就丢整段回复
//
// 流式期间只重写 partial（单条），完成后追加进 jsonl，兼顾便宜与可恢复。
//
// 读取仍然读整个 jsonl 再取需要的行：尾部反向读只快 2ms，却要处理
// 「截断首行」「单条消息超过读取窗口」等边界，不划算。JSONL 的收益在写。

fn session_meta_path(session_id: &str) -> PathBuf {
    sessions_dir().join(format!("{}.meta.json", session_id))
}

fn session_jsonl_path(session_id: &str) -> PathBuf {
    sessions_dir().join(format!("{}.messages.jsonl", session_id))
}

fn session_partial_path(session_id: &str) -> PathBuf {
    sessions_dir().join(format!("{}.partial.json", session_id))
}

/// 旧格式：整个会话一个 JSON 文件
fn legacy_session_path(session_id: &str) -> PathBuf {
    sessions_dir().join(format!("{}.json", session_id))
}

/// 统计 jsonl 的消息条数（数换行符，不解析内容）。
///
/// 刻意不把条数存进 meta：存了就得维护一致性，一旦漂移就是难查的 bug。
/// 1MB 文件数换行符只要几十微秒。
fn count_jsonl_lines(path: &std::path::Path) -> usize {
    std::fs::read(path)
        .map(|b| b.iter().filter(|&&c| c == b'\n').count())
        .unwrap_or(0)
}

/// 把旧的整体 JSON 会话拆成 meta + jsonl。
///
/// 已迁移（jsonl 已存在）或无旧文件时直接返回。
/// 迁移成功后把旧文件改名为 .json.bak 保留退路——129 个会话共 8MB，
/// 留着不占空间，出问题能手工恢复。
fn migrate_session_if_needed(session_id: &str) -> Result<(), String> {
    let jsonl = session_jsonl_path(session_id);
    if jsonl.exists() {
        return Ok(());
    }
    let legacy = legacy_session_path(session_id);
    if !legacy.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&legacy).map_err(|e| e.to_string())?;
    let session: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let messages = session
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 每条消息一行
    let mut buf = String::new();
    for m in &messages {
        buf.push_str(&serde_json::to_string(m).map_err(|e| e.to_string())?);
        buf.push('\n');
    }
    atomic_write(&jsonl, buf.as_bytes())?;

    // meta 去掉 messages
    let mut meta = session.clone();
    if let Some(obj) = meta.as_object_mut() {
        obj.remove("messages");
    }
    atomic_write(
        &session_meta_path(session_id),
        serde_json::to_string(&meta).map_err(|e| e.to_string())?.as_bytes(),
    )?;

    // 保留旧文件作为退路
    let _ = std::fs::rename(&legacy, legacy.with_extension("json.bak"));
    println!(
        "[Nova] 会话已迁移为 JSONL: {} ({} 条消息)",
        session_id,
        messages.len()
    );
    Ok(())
}

/// 启动时迁移全部旧格式会话。
///
/// 实测 129 个会话 8MB 共 79ms，同步做完不影响启动体感。
/// 单个会话迁移失败只记日志跳过，不阻断启动——旧文件仍在，下次启动会重试。
fn migrate_all_sessions() {
    let dir = sessions_dir();
    if !dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[Nova] 会话目录读取失败，跳过迁移: {}", e);
            return;
        }
    };
    let mut migrated = 0;
    let mut failed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 只认 {id}.json，排除 sessions-index.json 与各类衍生文件
        if !name.ends_with(".json")
            || name == "sessions-index.json"
            || name.ends_with(".meta.json")
            || name.ends_with(".partial.json")
        {
            continue;
        }
        let session_id = name.trim_end_matches(".json").to_string();
        match migrate_session_if_needed(&session_id) {
            Ok(()) => migrated += 1,
            Err(e) => {
                eprintln!("[Nova] 会话迁移失败 {}: {}", session_id, e);
                failed += 1;
            }
        }
    }
    if migrated > 0 || failed > 0 {
        println!("[Nova] 会话迁移完成: {} 个处理，{} 个失败", migrated, failed);
    }
}


/// Atomic write: write to temp file then rename for crash safety.
fn atomic_write(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
    file.write_all(content).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        e.to_string()
    })?;
    file.sync_all().map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        e.to_string()
    })?;
    std::fs::rename(&temp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        e.to_string()
    })?;
    Ok(())
}

/// 读取 sessions-index.json
#[tauri::command]
fn get_sessions_index() -> serde_json::Value {
    let path = sessions_index_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!([]))
    } else {
        serde_json::json!([])
    }
}

/// 读取单个会话的消息（分页，offset 从尾部计算）
///
/// 只对需要的那几行做 JSON 解析，其余行按字节跳过——这是相对旧格式
/// （必须解析整个对象才能取到 messages 数组）省下的部分。
///
/// 正在流式生成的最后一条消息存在独立的 partial 文件里，读取时补在末尾，
/// 使上次崩溃/退出时未完成的回复不会凭空消失。
#[tauri::command]
fn get_session_messages(
    session_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    migrate_session_if_needed(&session_id)?;

    let jsonl = session_jsonl_path(&session_id);
    let raw = std::fs::read_to_string(&jsonl).unwrap_or_default();
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();

    // partial 里是尚未追加进 jsonl 的最后一条，算进总数
    let partial: Option<serde_json::Value> = std::fs::read_to_string(session_partial_path(&session_id))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let total = lines.len() + if partial.is_some() { 1 } else { 0 };
    let limit = limit.unwrap_or(SESSION_PAGE_SIZE);
    let offset = offset.unwrap_or(0);

    // offset 从尾部算：offset=0 表示最新的 limit 条
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(limit);

    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(end - start);
    let mut partial_included = false;
    for i in start..end {
        if i < lines.len() {
            // 单行损坏不应让整个会话打不开，跳过并记日志
            match serde_json::from_str(lines[i]) {
                Ok(v) => messages.push(v),
                Err(e) => eprintln!("[Nova] 会话 {} 第 {} 行解析失败，跳过: {}", session_id, i + 1, e),
            }
        } else if let Some(p) = &partial {
            messages.push(p.clone());
            partial_included = true;
        }
    }

    let meta: serde_json::Value = std::fs::read_to_string(session_meta_path(&session_id))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(serde_json::Value::Null);

    Ok(serde_json::json!({
        "messages": messages,
        "total": total,
        // 末条是否来自 partial（尚未写入 jsonl）。
        // 前端据此确定「已追加」锚点，否则会把 partial 误认为已落盘而永不追加。
        "partialIncluded": partial_included,
        "memory": meta.get("memory").cloned().unwrap_or(serde_json::Value::Null),
        "modelId": meta.get("modelId").cloned().unwrap_or(serde_json::Value::Null)
    }))
}

/// 把 meta 写盘并同步 sessions-index.json
fn write_meta_and_index(session_id: &str, meta: &serde_json::Value) -> Result<(), String> {
    let dir = sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    atomic_write(
        &session_meta_path(session_id),
        serde_json::to_string(meta).map_err(|e| e.to_string())?.as_bytes(),
    )?;

    let index_entry = serde_json::json!({
        "id": meta.get("id").cloned().unwrap_or(serde_json::json!(session_id)),
        "title": meta.get("title").cloned().unwrap_or(serde_json::Value::Null),
        "connectorId": meta.get("connectorId").cloned().unwrap_or(serde_json::Value::Null),
        "connectorSessionId": meta.get("connectorSessionId").cloned().unwrap_or(serde_json::Value::Null),
        "modelId": meta.get("modelId").cloned().unwrap_or(serde_json::Value::Null),
        "pinned": meta.get("pinned").cloned().unwrap_or(serde_json::json!(false)),
        "createdAt": meta.get("createdAt").cloned().unwrap_or(serde_json::Value::Null),
        "updatedAt": meta.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
    });

    // index 是读-改-写，必须加锁防并发覆盖
    let _lock = acquire_chat_history_lock(&dir)?;
    let index_path = sessions_index_path();
    let mut index: Vec<serde_json::Value> = std::fs::read_to_string(&index_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    if let Some(pos) = index
        .iter()
        .position(|e| e.get("id").and_then(|v| v.as_str()) == Some(session_id))
    {
        index[pos] = index_entry;
    } else {
        index.insert(0, index_entry);
    }

    atomic_write(
        &index_path,
        serde_json::to_string(&index).map_err(|e| e.to_string())?.as_bytes(),
    )?;
    Ok(())
}

/// 保存会话元信息（不含消息）
///
/// 与磁盘上已有的 meta 做字段级合并再写回：调用方常常只带 title/pinned，
/// 直接覆盖会把 memory/modelId 等它不关心的字段清掉。
/// meta 文件只有 1KB 级，读一次很便宜。
#[tauri::command]
fn save_session_meta(session_id: String, meta: serde_json::Value) -> Result<(), String> {
    migrate_session_if_needed(&session_id)?;

    let mut merged: serde_json::Value = std::fs::read_to_string(session_meta_path(&session_id))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let (Some(dst), Some(src)) = (merged.as_object_mut(), meta.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    } else {
        merged = meta;
    }

    write_meta_and_index(&session_id, &merged)
}

/// 追加已完成的消息到 jsonl
///
/// 追加是本方案的核心：不读、不合并、不重写，因此
///   - 前端内存只有最近 50 条也不会影响磁盘上的历史
///   - 写入量等于新增内容本身（KB 级）而非整个会话（MB 级）
///   - 与另一个进程并发写时两边的消息都在（旧的全量覆盖会互相冲掉）
#[tauri::command]
fn append_session_messages(
    session_id: String,
    messages: Vec<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<(), String> {
    use std::io::Write;
    migrate_session_if_needed(&session_id)?;
    let dir = sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    if !messages.is_empty() {
        let mut buf = String::new();
        for m in &messages {
            buf.push_str(&serde_json::to_string(m).map_err(|e| e.to_string())?);
            buf.push('\n');
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(session_jsonl_path(&session_id))
            .map_err(|e| e.to_string())?;
        f.write_all(buf.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    if let Some(m) = meta {
        write_meta_and_index(&session_id, &m)?;
    }
    Ok(())
}

/// 全量重写消息（编辑/删除历史消息时用）
///
/// 这是唯一会减少消息的路径，因此截断守卫放在这里：
/// 前端内存只持有最近 50 条，若不加限制，一次误调用就会把磁盘上的
/// 140 条冲成 50 条（已复现的数据丢失路径）。
/// 真实的删除操作显式传 allow_shrink 放行。
#[tauri::command]
fn rewrite_session_messages(
    session_id: String,
    messages: Vec<serde_json::Value>,
    allow_shrink: Option<bool>,
    meta: Option<serde_json::Value>,
) -> Result<(), String> {
    migrate_session_if_needed(&session_id)?;
    let dir = sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let jsonl = session_jsonl_path(&session_id);
    if !allow_shrink.unwrap_or(false) {
        let existing = count_jsonl_lines(&jsonl);
        if messages.len() < existing {
            return Err(format!(
                "拒绝截断式重写：入参 {} 条 < 磁盘 {} 条（session {}）。\
                 请先加载完整消息，或对删除类操作显式传 allowShrink。",
                messages.len(),
                existing,
                session_id
            ));
        }
    }

    let mut buf = String::new();
    for m in &messages {
        buf.push_str(&serde_json::to_string(m).map_err(|e| e.to_string())?);
        buf.push('\n');
    }
    atomic_write(&jsonl, buf.as_bytes())?;
    // 重写意味着最后一条已定稿，partial 不再有效
    let _ = std::fs::remove_file(session_partial_path(&session_id));

    if let Some(m) = meta {
        write_meta_and_index(&session_id, &m)?;
    }
    Ok(())
}

/// 丢弃末尾若干条消息（重试时移除上一轮问答）
///
/// 相比全量 rewrite 的好处：不需要前端持有完整消息。
/// 前端内存只有最近一页，若走 rewrite 就得先把整个会话读进来才能安全重写。
/// 这里按「partial 算最后一条，其余从 jsonl 尾部去掉」精确截断。
#[tauri::command]
fn drop_trailing_session_messages(session_id: String, count: usize) -> Result<(), String> {
    migrate_session_if_needed(&session_id)?;
    if count == 0 {
        return Ok(());
    }
    let mut remaining = count;

    // partial 里的那条是最后一条
    let p = session_partial_path(&session_id);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        remaining -= 1;
    }

    if remaining > 0 {
        let jsonl = session_jsonl_path(&session_id);
        let raw = std::fs::read_to_string(&jsonl).unwrap_or_default();
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        let keep = lines.len().saturating_sub(remaining);
        let mut buf = String::new();
        for l in &lines[..keep] {
            buf.push_str(l);
            buf.push('\n');
        }
        atomic_write(&jsonl, buf.as_bytes())?;
    }
    Ok(())
}

/// 会话搜索。
///
/// 直接扫磁盘上的 jsonl，因此不受「前端只加载了一页」的限制——
/// 原生 ⌘F 只能搜到已渲染的 DOM，165 条的会话里搜不到未加载的那 145 条。
///
/// 只扫 content 字段：timeline 里的 text 事件与 content 是重复存储
/// （改版时的已知取舍），扫 content 即可覆盖全部正文。
///
/// session_id 为 None 时搜索全部会话。
#[tauri::command]
fn search_session_messages(
    query: String,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(serde_json::json!({ "results": [], "truncated": false }));
    }
    let limit = limit.unwrap_or(200);
    let dir = sessions_dir();

    // 待搜索的会话 id 列表
    let ids: Vec<String> = match &session_id {
        Some(id) => vec![id.clone()],
        None => {
            let mut v: Vec<String> = std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.strip_suffix(".messages.jsonl").map(|s| s.to_string())
                })
                .collect();
            // 按最近更新排序，让新会话的命中排在前面
            v.sort_by_key(|id| {
                std::fs::metadata(session_jsonl_path(id))
                    .and_then(|m| m.modified())
                    .ok()
            });
            v.reverse();
            v
        }
    };

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut truncated = false;

    'outer: for id in ids {
        let title = std::fs::read_to_string(session_meta_path(&id))
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|m| m.get("title").and_then(|t| t.as_str()).map(String::from))
            .unwrap_or_else(|| id.clone());

        let raw = match std::fs::read_to_string(session_jsonl_path(&id)) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        let total = lines.len();

        for (idx, line) in lines.iter().enumerate() {
            // 先在原始行上做廉价筛查，避免为不匹配的行付 JSON 解析成本
            if !line.to_lowercase().contains(&q) {
                continue;
            }
            let msg: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let lower = content.to_lowercase();
            let Some(pos) = lower.find(&q) else {
                // 命中出现在 content 之外（如工具标题），不作为正文结果
                continue;
            };

            if results.len() >= limit {
                truncated = true;
                break 'outer;
            }

            results.push(serde_json::json!({
                "sessionId": id,
                "sessionTitle": title,
                // 在该会话中的序号，供前端定位加载
                "messageIndex": idx,
                "totalInSession": total,
                "messageId": msg.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "role": msg.get("role").cloned().unwrap_or(serde_json::Value::Null),
                "timestamp": msg.get("timestamp").cloned().unwrap_or(serde_json::Value::Null),
                "snippet": make_snippet(content, pos, q.len()),
                "matchCount": lower.matches(&q).count(),
            }));
        }
    }

    Ok(serde_json::json!({ "results": results, "truncated": truncated }))
}

/// 截取命中位置附近的片段，按字符边界安全切分
fn make_snippet(content: &str, byte_pos: usize, match_len: usize) -> String {
    const BEFORE: usize = 40;
    const AFTER: usize = 80;

    // byte_pos 来自 find，落在字符边界上；向外扩展时需要吸附到边界
    let start = content[..byte_pos]
        .char_indices()
        .rev()
        .nth(BEFORE)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let tail_from = byte_pos + match_len;
    let end = if tail_from >= content.len() {
        content.len()
    } else {
        content[tail_from..]
            .char_indices()
            .nth(AFTER)
            .map(|(i, _)| tail_from + i)
            .unwrap_or(content.len())
    };

    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    // 片段里的换行会破坏单行展示，压成空格
    s.push_str(&content[start..end].replace('\n', " "));
    if end < content.len() {
        s.push('…');
    }
    s
}

/// 写入正在流式生成的最后一条消息
///
/// 单条消息、KB 级，可以高频重写。流式期间不动 jsonl，
/// 避免「为了少写而不写」导致崩溃丢整段回复。
#[tauri::command]
fn write_partial_message(session_id: String, message: serde_json::Value) -> Result<(), String> {
    std::fs::create_dir_all(sessions_dir()).map_err(|e| e.to_string())?;
    atomic_write(
        &session_partial_path(&session_id),
        serde_json::to_string(&message).map_err(|e| e.to_string())?.as_bytes(),
    )
}

/// 清除 partial（消息已追加进 jsonl 或被丢弃）
#[tauri::command]
fn clear_partial_message(session_id: String) -> Result<(), String> {
    let p = session_partial_path(&session_id);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// 删除单个会话及其索引条目
#[tauri::command]
fn delete_session(session_id: String) -> Result<(), String> {
    // 一个会话对应多个文件，逐个清理；.bak 是迁移时留的旧格式退路，一并删掉
    for p in [
        session_jsonl_path(&session_id),
        session_meta_path(&session_id),
        session_partial_path(&session_id),
        legacy_session_path(&session_id),
        legacy_session_path(&session_id).with_extension("json.bak"),
    ] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }

    // Lock index file to prevent concurrent read-modify-write races
    let _lock = acquire_chat_history_lock(&sessions_dir())?;

    // Remove from index atomically
    let index_path = sessions_index_path();
    let mut index: Vec<serde_json::Value> = std::fs::read_to_string(&index_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    index.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(session_id.as_str()));

    let index_json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    atomic_write(&index_path, index_json.as_bytes())?;

    Ok(())
}

/// 迁移旧 chat-history.json 到新的 split-file 格式
#[tauri::command]
fn migrate_chat_history() -> Result<bool, String> {
    let chat_history_file = data_dir().join("chat-history.json");
    let index_path = sessions_index_path();

    // Only migrate if old file exists AND new index does NOT exist
    if !chat_history_file.exists() || index_path.exists() {
        return Ok(false);
    }

    let content = std::fs::read_to_string(&chat_history_file).map_err(|e| e.to_string())?;
    let history: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let sessions = history
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if sessions.is_empty() {
        return Ok(false);
    }

    // Ensure sessions directory exists
    let dir = sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut index: Vec<serde_json::Value> = Vec::new();

    for session in &sessions {
        let id = match session.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };

        // Write full session file
        let session_file = dir.join(format!("{}.json", id));
        let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        atomic_write(&session_file, json.as_bytes())?;

        // Build index entry
        let index_entry = serde_json::json!({
            "id": session.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "title": session.get("title").cloned().unwrap_or(serde_json::Value::Null),
            "connectorId": session.get("connectorId").cloned().unwrap_or(serde_json::Value::Null),
            "connectorSessionId": session.get("connectorSessionId").cloned().unwrap_or(serde_json::Value::Null),
            "createdAt": session.get("createdAt").cloned().unwrap_or(serde_json::Value::Null),
            "updatedAt": session.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
        });
        index.push(index_entry);
    }

    // Write index file atomically
    let index_json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    atomic_write(&index_path, index_json.as_bytes())?;

    // Rename old chat-history.json to .bak (keep as backup, don't delete)
    let backup_path = data_dir().join("chat-history.json.bak");
    let _ = std::fs::rename(&chat_history_file, &backup_path);

    Ok(true)
}

// ─── Plugin Storage ───

fn plugin_data_dir() -> PathBuf {
    data_dir().join("plugin-data")
}

/// 读取插件数据
#[tauri::command]
fn get_plugin_data(plugin_id: String) -> Result<String, String> {
    let file = plugin_data_dir().join(format!("{}.json", plugin_id));
    match std::fs::read_to_string(&file) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/// 保存插件数据
#[tauri::command]
fn save_plugin_data(plugin_id: String, data: String) -> Result<(), String> {
    let dir = plugin_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", plugin_id));
    std::fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(())
}

/// 调试日志（前端调用，输出到 stdout + 写入文件）
#[tauri::command]
fn debug_log(msg: String) {
    let line = format!("[Frontend] {}", msg);
    safe_println!("{}", line);
    // 同时写入文件，release 包也能排查
    let log_dir = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("frontend.log");
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // 简单时间戳格式（不引入 chrono 依赖）
    let ts = format!("{}", secs);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "[{}] {}", ts, msg)
        });
}

/// 读取全局应用存储
#[tauri::command]
fn get_app_storage() -> Result<String, String> {
    let file = data_dir().join("app-storage.json");
    match std::fs::read_to_string(&file) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/// 保存全局应用存储
#[tauri::command]
fn save_app_storage(data: String) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("app-storage.json");
    std::fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Tasks 文件操作 ───
// Tasks 数据独立存储在 ~/.nova/data/tasks.json，方便 Kiro CLI 直接读写

fn tasks_file_path() -> PathBuf {
    data_dir().join("data").join("tasks.json")
}

/// 读取 tasks JSON 文件
#[tauri::command]
fn read_tasks_file() -> Result<String, String> {
    let file = tasks_file_path();
    match std::fs::read_to_string(&file) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/// 写入 tasks JSON 文件
#[tauri::command]
fn write_tasks_file(data: String) -> Result<(), String> {
    let file = tasks_file_path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Connectors 文件操作 ───
// Connectors 配置独立存储在 ~/.nova/data/connectors.json

fn connectors_file_path() -> PathBuf {
    data_dir().join("data").join("connectors.json")
}

/// 读取 connectors JSON 文件
#[tauri::command]
fn read_connectors_file() -> Result<String, String> {
    let file = connectors_file_path();
    match std::fs::read_to_string(&file) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/// 写入 connectors JSON 文件
#[tauri::command]
fn write_connectors_file(data: String) -> Result<(), String> {
    let file = connectors_file_path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Workspace 文件操作 ───

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// 列出目录内容
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("不是有效目录".to_string());
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件和 node_modules/target
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // 目录在前，文件在后，各自按名称排序
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// 读取文件内容（限制大小）
#[tauri::command]
fn read_file_content(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err("不是有效文件".to_string());
    }

    let max = max_bytes.unwrap_or(100_000); // 默认 100KB
    let content = std::fs::read(&file_path).map_err(|e| e.to_string())?;

    if content.len() > max {
        let truncated = &content[..max];
        match String::from_utf8(truncated.to_vec()) {
            Ok(s) => Ok(format!("{}...\n\n[文件过大，已截断至 {}KB]", s, max / 1024)),
            Err(_) => Err("二进制文件，无法预览".to_string()),
        }
    } else {
        String::from_utf8(content)
            .map_err(|_| "二进制文件，无法预览".to_string())
    }
}

// ─── WeCom Bot Commands ───

#[tauri::command]
async fn start_wecom_bot(
    bot_id: String,
    secret: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<WeComBot>>,
) -> Result<(), String> {
    let config = WeComConfig { bot_id, secret };
    state.start(config, app).await
}

#[tauri::command]
async fn stop_wecom_bot(
    state: tauri::State<'_, Arc<WeComBot>>,
) -> Result<(), String> {
    state.stop().await;
    Ok(())
}

#[tauri::command]
async fn get_wecom_status(
    state: tauri::State<'_, Arc<WeComBot>>,
) -> Result<String, String> {
    let status = state.get_status().await;
    let s = match status {
        wecom::BotStatus::Disconnected => "disconnected",
        wecom::BotStatus::Connecting => "connecting",
        wecom::BotStatus::Connected => "connected",
        wecom::BotStatus::Error(_) => "error",
    };
    Ok(s.to_string())
}

/// 前端初始化完成后调用，触发重发未回复的企微消息
#[tauri::command]
async fn wecom_frontend_ready(app: AppHandle) -> Result<(), String> {
    safe_println!("[WeCom] 前端已就绪，检查 pending 消息...");
    wecom::replay_pending_messages(&app);
    Ok(())
}

#[tauri::command]
async fn reply_wecom_message(
    request_id: String,
    content: String,
    _response_url: Option<String>,
    state: tauri::State<'_, Arc<WeComBot>>,
) -> Result<(), String> {
    // WebSocket 长连接模式：直接通过 WebSocket 发送 aibot_respond_msg + stream 格式回复
    // response_url HTTP API 不适用于 WebSocket 模式（虽然返回 200 OK 但客户端收不到消息）
    let content_preview: String = content.chars().take(200).collect();
    safe_println!("[WeCom] 回复消息: req_id={}, 内容({}字符): {}", request_id, content.len(), content_preview);
    let result = state.send_reply(WeComReply { request_id: request_id.clone(), content }).await;
    // 回复成功后从 pending 队列移除
    if result.is_ok() {
        wecom::remove_pending_message(&request_id);
    }
    result
}

// ─── Screenshot Command ───

/// 将图片文件复制到 ~/.nova/data/images/ 持久化存储，返回新路径
/// 如果文件已在目标目录中则直接返回原路径
#[tauri::command]
async fn persist_image(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let images_dir = data_dir().join("data").join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("创建图片目录失败: {}", e))?;

    // 如果已经在目标目录中，直接返回
    if path.contains("/.nova/data/images/") {
        return Ok(path);
    }

    // 生成唯一文件名
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let filename = format!("img-{}.{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis(), ext);
    let dest = images_dir.join(&filename);

    std::fs::copy(src, &dest)
        .map_err(|e| format!("复制图片失败: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

/// 使用 xcap 截取 Nova 窗口并保存为 PNG
#[tauri::command]
async fn capture_screenshot(path: Option<String>, scale: Option<f64>) -> Result<String, String> {
    use xcap::Window;

    let save_path = path.unwrap_or_else(|| {
        let images_dir = data_dir().join("data").join("images");
        std::fs::create_dir_all(&images_dir).ok();
        format!("{}/screenshot-{}.png", images_dir.display(), std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis())
    });

    // 获取所有窗口，按标题或 app name 查找 Nova
    let windows = Window::all().map_err(|e| format!("获取窗口列表失败: {}", e))?;

    // 打印所有窗口标题/app_name 便于调试权限问题
    for (i, w) in windows.iter().enumerate() {
        let title = w.title().unwrap_or_default();
        let app_name = w.app_name().unwrap_or_default();
        let (w_w, w_h) = (w.width().unwrap_or(0), w.height().unwrap_or(0));
        safe_println!("[Screenshot] window #{} | title={:?} app_name={:?} size={}x{}", i, title, app_name, w_w, w_h);
    }

    // 优先匹配 app_name == Nova 且面积最大的窗口（避免匹配到通知/辅助窗口）
    let mut candidates: Vec<Window> = windows.into_iter().filter(|w| {
        let title = w.title().unwrap_or_default();
        let app_name = w.app_name().unwrap_or_default();
        app_name.eq_ignore_ascii_case("Nova") || title.contains("Nova")
    }).collect();

    // 按面积从大到小排序，优先取主窗口
    candidates.sort_by(|a, b| {
        let a_area = a.width().unwrap_or(0) * a.height().unwrap_or(0);
        let b_area = b.width().unwrap_or(0) * b.height().unwrap_or(0);
        b_area.cmp(&a_area)
    });

    let nova_window = candidates.into_iter().next()
        .ok_or_else(|| "未找到 Nova 窗口，请检查屏幕录制权限".to_string())?;

    let matched_title = nova_window.title().unwrap_or_default();
    let matched_app = nova_window.app_name().unwrap_or_default();
    safe_println!("[Screenshot] 选中窗口: title={:?} app_name={:?}", matched_title, matched_app);

    // 截取窗口
    let image = nova_window.capture_image()
        .map_err(|e| format!("截图失败: {}", e))?;

    // 如果需要缩放
    let final_image = if let Some(s) = scale {
        if (s - 1.0).abs() > 0.01 {
            let (w, h) = (image.width(), image.height());
            let new_w = (w as f64 * s) as u32;
            let new_h = (h as f64 * s) as u32;
            image::imageops::resize(
                &image,
                new_w,
                new_h,
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            image
        }
    } else {
        image
    };

    // 保存为 PNG — 先确保目录存在
    if let Some(parent) = std::path::Path::new(&save_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建截图目录失败: {}", e))?;
    }
    final_image.save(&save_path)
        .map_err(|e| format!("保存截图失败: {}", e))?;

    let file_size = std::fs::metadata(&save_path)
        .map(|m| m.len())
        .unwrap_or(0);

    safe_println!("[Screenshot] xcap 截图已保存: {} ({} bytes)", save_path, file_size);
    Ok(save_path)
}

use tauri::AppHandle;

/// 检测是否有完全磁盘访问权限（尝试读取受 TCC 保护的目录）
#[tauri::command]
fn check_full_disk_access() -> bool {
    // ~/Library/Application Support/com.apple.TCC/TCC.db 是 TCC 保护的文件
    // 只有拥有完全磁盘访问权限才能读取此文件
    let home = dirs::home_dir().unwrap_or_default();
    let tcc_db = home
        .join("Library")
        .join("Application Support")
        .join("com.apple.TCC")
        .join("TCC.db");
    std::fs::metadata(&tcc_db).is_ok()
}

/// 打开系统设置的完全磁盘访问面板
#[tauri::command]
fn open_full_disk_access_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn();
}

/// 启动 Nova MCP Server，返回监听端口号
#[tauri::command]
async fn start_mcp_server_cmd(app_handle: tauri::AppHandle) -> Result<u16, String> {
    mcp_server::start_mcp_server(app_handle).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(WeComBot::new()))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_chat_history,
            save_chat_history,
            get_sessions_index,
            get_session_messages,
            get_session_page_size,
            save_session_meta,
            append_session_messages,
            rewrite_session_messages,
            drop_trailing_session_messages,
            search_session_messages,
            write_partial_message,
            clear_partial_message,
            delete_session,
            migrate_chat_history,
            get_skills,
            get_skill_content,
            save_skill,
            delete_skill,
            sync_skills_to_kiro,
            sync_kiro_skills_to_app,
            get_plugin_data,
            save_plugin_data,
            get_app_storage,
            save_app_storage,
            read_tasks_file,
            write_tasks_file,
            read_connectors_file,
            write_connectors_file,
            list_directory,
            read_file_content,
            start_wecom_bot,
            stop_wecom_bot,
            get_wecom_status,
            reply_wecom_message,
            wecom_frontend_ready,
            capture_screenshot,
            persist_image,
            debug_log,
            check_full_disk_access,
            open_full_disk_access_settings,
            mcp_server::mcp_respond,
            start_mcp_server_cmd,
            coding_tools::tool_file_read,
            coding_tools::tool_file_write,
            coding_tools::tool_file_edit,
            coding_tools::tool_bash,
            coding_tools::tool_glob,
            coding_tools::tool_grep,
        ])
        .setup(|app| {
            // updater 插件仅在桌面平台可用（Cargo.toml 中已按 target 限定依赖）
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // 确保数据目录存在
            let dir = data_dir();
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::create_dir_all(dir.join("data"));
            let _ = std::fs::create_dir_all(dir.join("data").join("sessions"));
            safe_println!("[Nova] ═══ 后端初始化开始 ═══");
            safe_println!("[Nova] Data dir: {:?}", dir);
            safe_println!("[Nova] PID: {}", std::process::id());

            // 一次性迁移：整体 JSON 会话 → meta.json + messages.jsonl
            // 实测 129 个会话 8MB 共 79ms，同步执行不影响启动体感
            migrate_all_sessions();

            // 一次性迁移：从 app-storage.json 中的 task.tasks 迁移到独立文件
            let tasks_file = tasks_file_path();
            if !tasks_file.exists() {
                let storage_file = dir.join("app-storage.json");
                if let Ok(content) = std::fs::read_to_string(&storage_file) {
                    if let Ok(storage) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(tasks_data) = storage.get("task").and_then(|t| t.get("tasks")) {
                            if let Ok(tasks_json) = serde_json::to_string_pretty(tasks_data) {
                                let _ = std::fs::write(&tasks_file, &tasks_json);
                                safe_println!("[Nova] ✅ Tasks 数据已迁移到 {:?}", tasks_file);
                            }
                        }
                    }
                }
            }

            // 同步内置 skill 到 ~/.nova/skills/
            // 文件级同步：补新增、覆盖用户未改动的、保留用户改过的、不碰凭据
            let skills_dest = skills_dir();
            let _ = std::fs::create_dir_all(&skills_dest);
            safe_println!("[Nova] Skills dir: {:?}", skills_dest);
            if let Ok(resource_path) = app.path().resource_dir() {
                let bundled_skills = resource_path.join("resources").join("skills");
                safe_println!("[Nova] Bundled skills path: {:?} (exists={})", bundled_skills, bundled_skills.exists());
                if bundled_skills.exists() {
                    let app_version = app.package_info().version.to_string();
                    let stats = sync_bundled_skills(&bundled_skills, &skills_dest, &app_version);
                    safe_println!(
                        "[Nova] Skill 同步完成 (v{}): 新增 {} / 更新 {} / 保留 {} / 受保护 {}",
                        app_version, stats.copied, stats.updated, stats.kept, stats.protected
                    );
                }
            }

            // 如果已有配置，打印一下
            let config_path = dir.join("config.json");
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(_config) = serde_json::from_str::<AppConfig>(&content) {
                    safe_println!("[Nova] Config loaded from {:?}", config_path);
                }
            } else {
                safe_println!("[Nova] 无本地配置文件，将使用默认配置");
            }

            safe_println!("[Nova] ═══ 后端初始化完成 ═══");
            Ok(())
        })

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod skill_sync_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "nova-skill-sync-test-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(path: &std::path::Path, content: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn read(path: &std::path::Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    // ─── 分类规则 ───

    #[test]
    fn protected_covers_credentials_and_runtime_state() {
        // 凭据：config/ 下的非 example json
        assert!(is_protected_skill_file("code-deploy/config/sso_config.json"));
        assert!(is_protected_skill_file("code-deploy/config/jenkins_config.json"));
        assert!(is_protected_skill_file("code-deploy/config/gerrit_config.json"));
        // 登录态
        assert!(is_protected_skill_file("code-deploy/config/storage_state.json"));
        assert!(is_protected_skill_file("code-deploy/config/arca_storage_state.json"));
        // 运行时目录
        assert!(is_protected_skill_file("x/.venv/lib/foo.py"));
        assert!(is_protected_skill_file("x/__pycache__/a.pyc"));
        assert!(is_protected_skill_file("x/scripts/a.pyc"));
    }

    #[test]
    fn protected_excludes_code_and_templates() {
        // 代码类必须可同步
        assert!(!is_protected_skill_file("code-deploy/SKILL.md"));
        assert!(!is_protected_skill_file("code-deploy/scripts/arca_release.py"));
        assert!(!is_protected_skill_file("nova-tasks/scripts/tasks.sh"));
        // 模板必须可同步
        assert!(!is_protected_skill_file("code-deploy/config/sso_config.example.json"));
        assert!(!is_protected_skill_file("code-deploy/config/gerrit_config.example.json"));
        // 非 config 目录下的 json（如 tchub 的 schema）可同步
        assert!(!is_protected_skill_file("tchub/skill.config.json"));
    }

    // ─── 首次释放 ───

    #[test]
    fn first_install_copies_everything_and_records_baseline() {
        let root = tmpdir("first");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        write(&bundled.join("demo/scripts/run.sh"), "echo v1");

        let stats = sync_bundled_skills(&bundled, &dest, "1.0.0");

        assert_eq!(read(&dest.join("demo/SKILL.md")), "v1");
        assert_eq!(read(&dest.join("demo/scripts/run.sh")), "echo v1");
        assert_eq!(stats.copied, 2);

        // manifest 已建立
        let m: serde_json::Value =
            serde_json::from_str(&read(&dest.join(SKILL_SYNC_MANIFEST))).unwrap();
        assert_eq!(m["lastSyncedAppVersion"], "1.0.0");
        assert!(m["files"]["demo/SKILL.md"].is_string());
    }

    // ─── 三态核心行为 ───

    #[test]
    fn unmodified_file_gets_updated() {
        let root = tmpdir("unmod");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        // 第一次：释放 v1，建立基线
        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");
        assert_eq!(read(&dest.join("demo/SKILL.md")), "v1");

        // 包内升级到 v2，用户未改动过本地
        write(&bundled.join("demo/SKILL.md"), "v2");
        let stats = sync_bundled_skills(&bundled, &dest, "1.0.1");

        assert_eq!(read(&dest.join("demo/SKILL.md")), "v2", "未改动的文件应被更新");
        assert_eq!(stats.updated, 1);
    }

    #[test]
    fn user_modified_file_is_preserved() {
        let root = tmpdir("usermod");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 用户改了本地
        write(&dest.join("demo/SKILL.md"), "用户自己的版本");

        // 包内也升级了
        write(&bundled.join("demo/SKILL.md"), "v2");
        let stats = sync_bundled_skills(&bundled, &dest, "1.0.1");

        assert_eq!(
            read(&dest.join("demo/SKILL.md")),
            "用户自己的版本",
            "用户改过的文件不能被覆盖"
        );
        assert_eq!(stats.kept, 1);
        assert_eq!(stats.updated, 0);
    }

    #[test]
    fn missing_file_is_added() {
        let root = tmpdir("missing");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 新版本新增了一个脚本
        write(&bundled.join("demo/scripts/new.sh"), "echo new");
        let stats = sync_bundled_skills(&bundled, &dest, "1.0.1");

        assert_eq!(read(&dest.join("demo/scripts/new.sh")), "echo new");
        assert!(stats.copied >= 1);
    }

    // ─── 安全性 ───

    #[test]
    fn credentials_are_never_overwritten() {
        let root = tmpdir("cred");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 用户填了真实凭据
        write(&dest.join("demo/config/sso_config.json"), r#"{"password":"real"}"#);
        // 假设包内误打进了一份凭据
        write(&bundled.join("demo/config/sso_config.json"), r#"{"password":"FROM_BUNDLE"}"#);

        sync_bundled_skills(&bundled, &dest, "1.0.2");

        assert_eq!(
            read(&dest.join("demo/config/sso_config.json")),
            r#"{"password":"real"}"#,
            "用户凭据绝不能被包内内容覆盖"
        );
    }

    #[test]
    fn user_own_skills_are_untouched() {
        let root = tmpdir("ownskill");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        // 用户自建 / 蒸馏产出的 skill，包内不存在
        write(&dest.join("my-own-skill/SKILL.md"), "我自己写的");
        write(&dest.join("my-own-skill/scripts/x.sh"), "mine");

        sync_bundled_skills(&bundled, &dest, "1.0.0");

        assert_eq!(read(&dest.join("my-own-skill/SKILL.md")), "我自己写的");
        assert_eq!(read(&dest.join("my-own-skill/scripts/x.sh")), "mine");
    }

    #[test]
    fn extra_user_files_inside_bundled_skill_are_kept() {
        let root = tmpdir("extra");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 用户在内置 skill 目录里加了自己的脚本
        write(&dest.join("demo/scripts/my_helper.sh"), "mine");

        write(&bundled.join("demo/SKILL.md"), "v2");
        sync_bundled_skills(&bundled, &dest, "1.0.1");

        assert_eq!(
            read(&dest.join("demo/scripts/my_helper.sh")),
            "mine",
            "包内没有的用户文件不应被删除"
        );
    }

    // ─── 迁移与幂等 ───

    #[test]
    fn migration_without_manifest_does_not_clobber() {
        let root = tmpdir("migrate");
        let bundled = root.join("bundled");
        let dest = root.join("dest");

        // 模拟老用户：已有 skill 目录但没有 manifest，且内容比包内新
        write(&dest.join("demo/SKILL.md"), "用户目录的新版本");
        write(&bundled.join("demo/SKILL.md"), "包内的旧版本");
        assert!(!dest.join(SKILL_SYNC_MANIFEST).exists());

        let stats = sync_bundled_skills(&bundled, &dest, "1.0.0");

        assert_eq!(
            read(&dest.join("demo/SKILL.md")),
            "用户目录的新版本",
            "首次运行无基线时不得覆盖本地内容"
        );
        assert_eq!(stats.kept, 1);
        // 且已把当前状态记为基线
        let m: serde_json::Value =
            serde_json::from_str(&read(&dest.join(SKILL_SYNC_MANIFEST))).unwrap();
        assert!(m["files"]["demo/SKILL.md"].is_string());
    }

    #[test]
    fn same_version_is_skipped() {
        let root = tmpdir("samever");
        let bundled = root.join("bundled");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        write(&bundled.join("demo/SKILL.md"), "v1");
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 同版本再次同步：即使包内变了也不应处理
        write(&bundled.join("demo/SKILL.md"), "v2");
        let stats = sync_bundled_skills(&bundled, &dest, "1.0.0");

        assert_eq!(stats.copied, 0);
        assert_eq!(stats.updated, 0);
        assert_eq!(read(&dest.join("demo/SKILL.md")), "v1", "同版本应整体跳过");
    }

    #[test]
    fn baseline_advances_so_next_release_can_update() {
        let root = tmpdir("advance");
        let bundled = root.join("bundled");
        let dest = root.join("dest");

        // 老用户迁移：无 manifest，本地内容被记为基线
        write(&dest.join("demo/SKILL.md"), "local");
        write(&bundled.join("demo/SKILL.md"), "local"); // 回灌后包内 == 本地
        sync_bundled_skills(&bundled, &dest, "1.0.0");

        // 下个版本包内升级，用户期间没动过 → 应该能更新
        write(&bundled.join("demo/SKILL.md"), "v2");
        let stats = sync_bundled_skills(&bundled, &dest, "1.0.1");

        assert_eq!(read(&dest.join("demo/SKILL.md")), "v2");
        assert_eq!(stats.updated, 1);
    }
}

#[cfg(test)]
mod session_store_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn tmpdir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "nova-session-test-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn msg(i: usize) -> serde_json::Value {
        serde_json::json!({ "id": format!("msg-{}", i), "role": "user", "content": format!("内容 {}", i) })
    }

    /// 写一个 jsonl 文件
    fn write_jsonl(path: &Path, n: usize) {
        let mut buf = String::new();
        for i in 0..n {
            buf.push_str(&serde_json::to_string(&msg(i)).unwrap());
            buf.push('\n');
        }
        fs::write(path, buf).unwrap();
    }

    // ===== count_jsonl_lines =====

    #[test]
    fn count_lines_counts_messages() {
        let d = tmpdir("count");
        let f = d.join("m.jsonl");
        write_jsonl(&f, 7);
        assert_eq!(count_jsonl_lines(&f), 7);
    }

    #[test]
    fn count_lines_is_zero_for_missing_file() {
        let d = tmpdir("count-missing");
        assert_eq!(count_jsonl_lines(&d.join("nope.jsonl")), 0);
    }

    #[test]
    fn count_lines_is_zero_for_empty_file() {
        let d = tmpdir("count-empty");
        let f = d.join("m.jsonl");
        fs::write(&f, "").unwrap();
        assert_eq!(count_jsonl_lines(&f), 0);
    }

    // ===== 截断守卫（rewrite_session_messages 内的判定）=====

    fn guard_rejects(incoming: usize, existing: usize, allow_shrink: bool) -> bool {
        !allow_shrink && incoming < existing
    }

    #[test]
    fn guard_rejects_truncating_rewrite() {
        // 已复现的丢数据场景：磁盘 140 条，内存只加载 50 条后追加 1 条
        assert!(guard_rejects(51, 140, false));
    }

    #[test]
    fn guard_allows_growth() {
        assert!(!guard_rejects(141, 140, false));
    }

    #[test]
    fn guard_allows_equal_count() {
        // 改某条消息内容但条数不变
        assert!(!guard_rejects(140, 140, false));
    }

    #[test]
    fn guard_allows_shrink_when_explicitly_permitted() {
        // 删除消息 / 重试时移除末尾两条
        assert!(!guard_rejects(10, 140, true));
    }

    #[test]
    fn guard_allows_first_write_of_new_session() {
        assert!(!guard_rejects(1, 0, false));
    }

    // ===== 追加语义 =====
    //
    // append 的核心价值：不读旧内容也不重写，因此内存里只有分页数据
    // 也不会影响磁盘上的历史。这里直接验证文件层面的行为。

    fn append_lines(path: &Path, msgs: &[serde_json::Value]) {
        use std::io::Write;
        let mut buf = String::new();
        for m in msgs {
            buf.push_str(&serde_json::to_string(m).unwrap());
            buf.push('\n');
        }
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(buf.as_bytes()).unwrap();
    }

    #[test]
    fn append_preserves_existing_history() {
        let d = tmpdir("append");
        let f = d.join("m.jsonl");
        write_jsonl(&f, 140);
        // 模拟前端只持有最近 50 条的情况下追加 1 条
        append_lines(&f, &[msg(999)]);
        assert_eq!(count_jsonl_lines(&f), 141, "追加不应影响已有历史");
    }

    #[test]
    fn append_to_missing_file_creates_it() {
        let d = tmpdir("append-new");
        let f = d.join("m.jsonl");
        append_lines(&f, &[msg(0)]);
        assert_eq!(count_jsonl_lines(&f), 1);
    }

    #[test]
    fn appended_lines_are_individually_parseable() {
        let d = tmpdir("append-parse");
        let f = d.join("m.jsonl");
        append_lines(&f, &[msg(0), msg(1)]);
        let raw = fs::read_to_string(&f).unwrap();
        let parsed: Vec<serde_json::Value> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1]["id"], "msg-1");
    }

    #[test]
    fn message_content_with_newlines_stays_on_one_line() {
        // 消息正文常含换行（代码块），序列化后必须转义成 \n 而非真实换行，
        // 否则一条消息会被切成多行，jsonl 结构就坏了
        let d = tmpdir("append-newline");
        let f = d.join("m.jsonl");
        let m = serde_json::json!({ "id": "x", "content": "第一行\n第二行\n```ts\nconst a=1;\n```" });
        append_lines(&f, &[m.clone()]);
        assert_eq!(count_jsonl_lines(&f), 1, "含换行的消息仍应只占一行");
        let raw = fs::read_to_string(&f).unwrap();
        let back: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(back["content"], m["content"], "往返后正文必须一致");
    }

    // ===== 分页切片 =====

    /// 复刻 get_session_messages 的切片计算（offset 从尾部算）
    fn slice_range(total: usize, offset: usize, limit: usize) -> (usize, usize) {
        let end = total.saturating_sub(offset);
        let start = end.saturating_sub(limit);
        (start, end)
    }

    #[test]
    fn first_page_takes_most_recent() {
        assert_eq!(slice_range(140, 0, 50), (90, 140));
    }

    #[test]
    fn second_page_walks_backwards() {
        assert_eq!(slice_range(140, 50, 50), (40, 90));
    }

    #[test]
    fn last_page_clamps_at_zero() {
        assert_eq!(slice_range(140, 120, 50), (0, 20));
    }

    #[test]
    fn slice_is_empty_when_offset_exceeds_total() {
        let (s, e) = slice_range(10, 99, 50);
        assert_eq!((s, e), (0, 0));
    }

    #[test]
    fn slice_handles_fewer_messages_than_page() {
        assert_eq!(slice_range(3, 0, 50), (0, 3));
    }

    // ===== 迁移 =====

    #[test]
    fn migration_splits_legacy_into_meta_and_jsonl() {
        let d = tmpdir("migrate");
        let legacy = d.join("s1.json");
        let session = serde_json::json!({
            "id": "s1",
            "title": "旧会话",
            "modelId": "gpt-4",
            "memory": { "summary": "摘要" },
            "messages": [msg(0), msg(1), msg(2)]
        });
        fs::write(&legacy, serde_json::to_string(&session).unwrap()).unwrap();

        // 复刻 migrate_session_if_needed 的核心逻辑（不依赖 data_dir）
        let content = fs::read_to_string(&legacy).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let msgs = parsed["messages"].as_array().unwrap().clone();
        let mut buf = String::new();
        for m in &msgs {
            buf.push_str(&serde_json::to_string(m).unwrap());
            buf.push('\n');
        }
        let jsonl = d.join("s1.messages.jsonl");
        fs::write(&jsonl, &buf).unwrap();
        let mut meta = parsed.clone();
        meta.as_object_mut().unwrap().remove("messages");
        let meta_path = d.join("s1.meta.json");
        fs::write(&meta_path, serde_json::to_string(&meta).unwrap()).unwrap();

        assert_eq!(count_jsonl_lines(&jsonl), 3, "消息应逐行写入 jsonl");
        let meta_back: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta_back["title"], "旧会话");
        assert_eq!(meta_back["modelId"], "gpt-4");
        assert_eq!(meta_back["memory"]["summary"], "摘要");
        assert!(meta_back.get("messages").is_none(), "meta 里不该再有 messages");
    }

    #[test]
    fn migration_of_empty_session_yields_empty_jsonl() {
        let d = tmpdir("migrate-empty");
        let jsonl = d.join("s.messages.jsonl");
        fs::write(&jsonl, "").unwrap();
        assert_eq!(count_jsonl_lines(&jsonl), 0);
    }

    // ===== meta 合并 =====

    #[test]
    fn meta_merge_keeps_fields_not_in_patch() {
        // save_session_meta 做字段级合并：只带 title 的调用不该清掉 memory
        let existing = serde_json::json!({ "title": "旧", "memory": { "s": 1 }, "modelId": "m1" });
        let patch = serde_json::json!({ "title": "新" });

        let mut merged = existing.clone();
        for (k, v) in patch.as_object().unwrap() {
            merged.as_object_mut().unwrap().insert(k.clone(), v.clone());
        }

        assert_eq!(merged["title"], "新");
        assert_eq!(merged["memory"]["s"], 1, "未在 patch 中的字段必须保留");
        assert_eq!(merged["modelId"], "m1");
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    // ===== make_snippet =====
    //
    // 片段要在命中处前后取上下文，且必须落在字符边界上——
    // 中文一个字 3 字节，按字节切会切出乱码。

    #[test]
    fn snippet_keeps_match_in_context() {
        let c = "前面的内容，这里有关键词，后面还有内容";
        let pos = c.find("关键词").unwrap();
        let s = make_snippet(c, pos, "关键词".len());
        assert!(s.contains("关键词"));
    }

    #[test]
    fn snippet_does_not_split_multibyte_chars() {
        // 长中文串，命中在中间，两侧都需要截断
        let c = "中".repeat(200) + "关键词" + &"文".repeat(200);
        let pos = c.find("关键词").unwrap();
        let s = make_snippet(&c, pos, "关键词".len());
        // 能正常转回字符串即说明没切坏字符边界
        assert!(s.contains("关键词"));
        assert!(s.starts_with('…'));
        assert!(s.ends_with('…'));
    }

    #[test]
    fn snippet_marks_truncation_only_when_truncated() {
        let c = "短内容关键词结尾";
        let pos = c.find("关键词").unwrap();
        let s = make_snippet(c, pos, "关键词".len());
        assert!(!s.starts_with('…'), "开头未截断不该加省略号");
        assert!(!s.ends_with('…'), "结尾未截断不该加省略号");
    }

    #[test]
    fn snippet_flattens_newlines() {
        let c = "第一行\n第二行关键词\n第三行";
        let pos = c.find("关键词").unwrap();
        let s = make_snippet(c, pos, "关键词".len());
        assert!(!s.contains('\n'), "换行会破坏单行展示，应压成空格");
    }

    #[test]
    fn snippet_handles_match_at_start() {
        let c = "关键词在最开头";
        let s = make_snippet(c, 0, "关键词".len());
        assert!(s.starts_with("关键词"));
        assert!(!s.starts_with('…'));
    }

    #[test]
    fn snippet_handles_match_at_end() {
        let c = "结尾才是关键词";
        let pos = c.find("关键词").unwrap();
        let s = make_snippet(c, pos, "关键词".len());
        assert!(s.ends_with("关键词"));
        assert!(!s.ends_with('…'));
    }

    // ===== 匹配语义 =====

    #[test]
    fn query_is_case_insensitive() {
        let content = "使用 RehypeHighlight 做高亮";
        assert!(content.to_lowercase().contains(&"rehypehighlight".to_lowercase()));
        assert!(content.to_lowercase().contains(&"REHYPEHIGHLIGHT".to_lowercase()));
    }

    #[test]
    fn empty_query_matches_nothing() {
        // 空查询直接短路，避免把全部消息当命中返回
        let q = "   ".trim().to_lowercase();
        assert!(q.is_empty());
    }
}
