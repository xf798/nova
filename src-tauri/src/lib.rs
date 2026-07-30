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

/// 读取单个会话的消息（支持分页，offset 从尾部计算）
#[tauri::command]
fn get_session_messages(
    session_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    let file = sessions_dir().join(format!("{}.json", session_id));
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let session: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let messages = session
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let total = messages.len();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    // offset is from the END: offset=0 means most recent `limit` messages
    // slice range: [total - offset - limit .. total - offset]
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(limit);

    let slice = &messages[start..end];

    // Include memory so the frontend can restore session-level summary/extraction state
    let memory = session.get("memory").cloned().unwrap_or(serde_json::Value::Null);
    // Include modelId so the frontend can restore per-session model selection
    // (covers sessions saved before modelId was added to the index)
    let model_id = session.get("modelId").cloned().unwrap_or(serde_json::Value::Null);

    Ok(serde_json::json!({
        "messages": slice,
        "total": total,
        "memory": memory,
        "modelId": model_id
    }))
}

/// 保存单个会话并更新索引
#[tauri::command]
fn save_session(session_id: String, data: serde_json::Value) -> Result<(), String> {
    let dir = sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Write full session file atomically
    let session_file = dir.join(format!("{}.json", session_id));
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    atomic_write(&session_file, json.as_bytes())?;

    // Build index entry from session data
    let index_entry = serde_json::json!({
        "id": data.get("id").cloned().unwrap_or(serde_json::json!(session_id)),
        "title": data.get("title").cloned().unwrap_or(serde_json::Value::Null),
        "connectorId": data.get("connectorId").cloned().unwrap_or(serde_json::Value::Null),
        "connectorSessionId": data.get("connectorSessionId").cloned().unwrap_or(serde_json::Value::Null),
        "modelId": data.get("modelId").cloned().unwrap_or(serde_json::Value::Null),
        "pinned": data.get("pinned").cloned().unwrap_or(serde_json::json!(false)),
        "createdAt": data.get("createdAt").cloned().unwrap_or(serde_json::Value::Null),
        "updatedAt": data.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
    });

    // Lock index file to prevent concurrent read-modify-write races
    let _lock = acquire_chat_history_lock(&dir)?;

    // Atomically update sessions-index.json (read → upsert → write)
    let index_path = sessions_index_path();
    let mut index: Vec<serde_json::Value> = std::fs::read_to_string(&index_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    // Upsert: replace existing entry or prepend (consistent with TS createSession)
    if let Some(pos) = index.iter().position(|e| {
        e.get("id").and_then(|v| v.as_str()) == Some(session_id.as_str())
    }) {
        index[pos] = index_entry;
    } else {
        index.insert(0, index_entry);
    }

    let index_json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    atomic_write(&index_path, index_json.as_bytes())?;

    Ok(())
}

/// 仅更新会话 meta 信息（title/pinned），不覆盖 messages
#[tauri::command]
fn update_session_meta(session_id: String, meta: serde_json::Value) -> Result<(), String> {
    let dir = sessions_dir();
    let session_file = dir.join(format!("{}.json", session_id));

    // 更新 session 文件中的 meta 字段（如果文件存在）
    if session_file.exists() {
        let content = std::fs::read_to_string(&session_file).map_err(|e| e.to_string())?;
        let mut session: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        if let Some(title) = meta.get("title").and_then(|v| v.as_str()) {
            session["title"] = serde_json::json!(title);
        }
        if let Some(pinned) = meta.get("pinned").and_then(|v| v.as_bool()) {
            session["pinned"] = serde_json::json!(pinned);
        }
        if let Some(csid) = meta.get("connectorSessionId") {
            session["connectorSessionId"] = csid.clone();
        }
        if let Some(model_id) = meta.get("modelId") {
            session["modelId"] = model_id.clone();
        }

        let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
        atomic_write(&session_file, json.as_bytes())?;
    }

    // 更新 index
    let _lock = acquire_chat_history_lock(&dir)?;
    let index_path = sessions_index_path();
    let mut index: Vec<serde_json::Value> = std::fs::read_to_string(&index_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    if let Some(entry) = index.iter_mut().find(|e| {
        e.get("id").and_then(|v| v.as_str()) == Some(session_id.as_str())
    }) {
        if let Some(title) = meta.get("title").and_then(|v| v.as_str()) {
            entry["title"] = serde_json::json!(title);
        }
        if let Some(pinned) = meta.get("pinned").and_then(|v| v.as_bool()) {
            entry["pinned"] = serde_json::json!(pinned);
        }
        if let Some(csid) = meta.get("connectorSessionId") {
            entry["connectorSessionId"] = csid.clone();
        }
        if let Some(model_id) = meta.get("modelId") {
            entry["modelId"] = model_id.clone();
        }
    }

    let index_json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    atomic_write(&index_path, index_json.as_bytes())?;

    Ok(())
}

/// 删除单个会话及其索引条目
#[tauri::command]
fn delete_session(session_id: String) -> Result<(), String> {
    // Remove session file
    let session_file = sessions_dir().join(format!("{}.json", session_id));
    if session_file.exists() {
        std::fs::remove_file(&session_file).map_err(|e| e.to_string())?;
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
            save_session,
            update_session_meta,
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
