// ===== Nova Coding Tools =====
//
// 提供文件读写、代码编辑、命令执行、文件搜索等核心代码开发能力。
// 由前端 ToolRegistry 通过 Tauri invoke 调用。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

// ─── 安全层 ───

/// 系统保护路径（禁止写入）
const PROTECTED_PATHS: &[&str] = &[
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library/System",
    "/private/var",
    "/private/etc",
];

/// 危险命令模式（禁止执行）
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf ~/",
    "mkfs",
    "dd if=",
    "> /dev/sda",
    "> /dev/disk",
    "chmod -R 777 /",
    ":(){ :|:& };:",
    "fork bomb",
];

/// 默认排除的目录（glob/grep 搜索时跳过）
const DEFAULT_EXCLUDE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".DS_Store",
];

/// macOS 上受 TCC 保护的家目录一级子目录。
///
/// 只要 read_dir 碰一下，系统就弹一次「"nova" 想访问你的"下载"文件夹」，
/// 一轮全盘搜索能连弹五六个框，而且 dev 版是 adhoc 签名、重新编译后 CDHash 变化，
/// 之前点过的「允许」会失效，于是每次重启都重弹。
///
/// 这些目录里几乎不会有要搜的工程代码，宽范围搜索时直接跳过。
/// 只按「home 的直接子目录」判定，不按目录名匹配——否则工程里正常的
/// Documents/ 或 Library/ 子目录会被误伤。
const HOME_PROTECTED_SUBDIRS: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Music",
    "Movies",
    "Library",
    "Public",
    ".Trash",
];

/// 验证路径安全性（写操作）
fn validate_write_path(path: &Path) -> Result<(), String> {
    // 解析绝对路径
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        return Err("路径必须是绝对路径".to_string());
    };

    // 检查系统保护路径
    let path_str = resolved.to_string_lossy();
    for protected in PROTECTED_PATHS {
        if path_str.starts_with(protected) {
            return Err(format!("拒绝写入系统保护路径: {}", resolved.display()));
        }
    }

    Ok(())
}

/// 验证命令安全性
fn validate_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    for pattern in DANGEROUS_PATTERNS {
        if lower.contains(pattern) {
            return Err(format!("拒绝执行危险命令，包含: '{}'", pattern));
        }
    }
    Ok(())
}

/// 判断路径是否应被排除（搜索时）
fn should_exclude(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_string_lossy();
            if DEFAULT_EXCLUDE_DIRS.iter().any(|d| *d == name_str.as_ref()) {
                return true;
            }
        }
    }
    false
}

/// 判断某个条目是否是 home 下受 TCC 保护的一级子目录。
///
/// `guard_home` 仅在「搜索根就是家目录」时给出 Some：调用方显式指定了
/// 具体路径就说明他知道自己在搜哪儿，不该替他跳过。
fn is_home_protected(path: &Path, guard_home: Option<&Path>) -> bool {
    let Some(home) = guard_home else { return false };
    if path.parent() != Some(home) {
        return false;
    }
    match path.file_name() {
        Some(name) => {
            let name = name.to_string_lossy();
            HOME_PROTECTED_SUBDIRS.iter().any(|d| *d == name.as_ref())
        }
        None => false,
    }
}

/// 宽范围搜索时是否跳过隐藏目录。
///
/// `~/Library`、`~/.Trash` 之外还有 `~/.cache`、`~/.npm` 这类体量巨大又无搜索价值的目录，
/// 而且 iCloud/相册的实体数据藏在隐藏路径下，一并跳过能同时省掉弹框和无谓遍历。
fn is_hidden_dir(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

/// 宽范围搜索（未显式指定 path）时应跳过的目录
fn should_skip_dir(path: &Path, guard_home: Option<&Path>) -> bool {
    guard_home.is_some() && (is_hidden_dir(path) || is_home_protected(path, guard_home))
}

// ─── 输出结构 ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
    pub duration_ms: u64,
}

// ─── Commands ───

/// 读取文件内容，支持行范围
#[tauri::command]
pub async fn tool_file_read(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if !file_path.is_file() {
        return Err(format!("路径不是文件: {}", path));
    }

    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    let start = offset.unwrap_or(0).min(total_lines);
    let end = limit
        .map(|l| (start + l).min(total_lines))
        .unwrap_or(total_lines);

    // 带行号输出
    let mut result = String::new();
    for (i, line) in lines[start..end].iter().enumerate() {
        let line_num = start + i + 1; // 1-indexed
        result.push_str(&format!("{:>4} | {}\n", line_num, line));
    }

    // 附加文件信息
    if start > 0 || end < total_lines {
        result.push_str(&format!(
            "\n[显示第 {}-{} 行，共 {} 行]",
            start + 1,
            end,
            total_lines
        ));
    } else {
        result.push_str(&format!("\n[共 {} 行]", total_lines));
    }

    Ok(result)
}

/// 创建或覆盖写入文件
#[tauri::command]
pub async fn tool_file_write(path: String, content: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    validate_write_path(file_path)?;

    // 自动创建父目录
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let is_new = !file_path.exists();
    let line_count = content.lines().count();

    std::fs::write(file_path, &content)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    let action = if is_new { "Created" } else { "Updated" };
    Ok(format!(
        "{} {} ({} lines, {} bytes)",
        action,
        path,
        line_count,
        content.len()
    ))
}

/// 精准编辑：search-replace
#[tauri::command]
pub async fn tool_file_edit(
    path: String,
    old_str: String,
    new_str: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    let file_path = Path::new(&path);
    validate_write_path(file_path)?;

    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    // 计算匹配数量
    let match_count = content.matches(&old_str).count();

    if match_count == 0 {
        // 返回文件的部分内容帮助 AI 定位
        let preview_lines: Vec<&str> = content.lines().take(50).collect();
        return Err(format!(
            "未找到匹配的文本。文件前 50 行：\n{}",
            preview_lines.join("\n")
        ));
    }

    if match_count > 1 && !replace_all.unwrap_or(false) {
        // 找到所有匹配的行号
        let mut locations = Vec::new();
        let mut search_start = 0;
        while let Some(pos) = content[search_start..].find(&old_str) {
            let abs_pos = search_start + pos;
            let line_num = content[..abs_pos].lines().count();
            locations.push(line_num);
            search_start = abs_pos + old_str.len();
        }
        return Err(format!(
            "找到 {} 处匹配（行 {:?}），old_str 不唯一。请提供更多上下文使其唯一，或传 replace_all: true 批量替换。",
            match_count, locations
        ));
    }

    // 执行替换
    let new_content = if replace_all.unwrap_or(false) {
        content.replace(&old_str, &new_str)
    } else {
        content.replacen(&old_str, &new_str, 1)
    };

    std::fs::write(file_path, &new_content)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    let replaced_count = if replace_all.unwrap_or(false) { match_count } else { 1 };
    Ok(format!(
        "Edited {} ({} replacement{})",
        path,
        replaced_count,
        if replaced_count > 1 { "s" } else { "" }
    ))
}

/// 执行 shell 命令
#[tauri::command]
pub async fn tool_bash(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<BashOutput, String> {
    validate_command(&command)?;

    let timeout_duration = Duration::from_millis(timeout_ms.unwrap_or(30_000).min(300_000));
    let work_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .to_string_lossy()
            .to_string()
    });

    let start = std::time::Instant::now();

    let mut child = TokioCommand::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动命令失败: {}", e))?;

    // 取出 stdout/stderr handles
    let mut stdout_handle = child.stdout.take().unwrap();
    let mut stderr_handle = child.stderr.take().unwrap();

    // 并行读取 stdout/stderr + 等待进程退出（带超时）
    let exec_future = async {
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();

        let (stdout_res, stderr_res, status) = tokio::join!(
            async { tokio::io::AsyncReadExt::read_to_end(&mut stdout_handle, &mut stdout_buf).await },
            async { tokio::io::AsyncReadExt::read_to_end(&mut stderr_handle, &mut stderr_buf).await },
            child.wait(),
        );

        stdout_res.map_err(|e| format!("读取 stdout 失败: {}", e))?;
        stderr_res.map_err(|e| format!("读取 stderr 失败: {}", e))?;
        let status = status.map_err(|e| format!("等待进程失败: {}", e))?;

        Ok::<_, String>((stdout_buf, stderr_buf, status))
    };

    let result = timeout(timeout_duration, exec_future).await;

    let duration_ms = start.elapsed().as_millis() as u64;
    const MAX_OUTPUT_CHARS: usize = 50_000;

    match result {
        Ok(Ok((stdout_buf, stderr_buf, status))) => {
            let mut stdout = String::from_utf8_lossy(&stdout_buf).to_string();
            let mut stderr = String::from_utf8_lossy(&stderr_buf).to_string();
            let mut truncated = false;

            if stdout.len() > MAX_OUTPUT_CHARS {
                stdout.truncate(MAX_OUTPUT_CHARS);
                stdout.push_str("\n\n[... stdout 已截断]");
                truncated = true;
            }
            if stderr.len() > MAX_OUTPUT_CHARS {
                stderr.truncate(MAX_OUTPUT_CHARS);
                stderr.push_str("\n\n[... stderr 已截断]");
                truncated = true;
            }

            Ok(BashOutput {
                stdout,
                stderr,
                exit_code: status.code().unwrap_or(-1),
                truncated,
                duration_ms,
            })
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // 超时 — child 已经 drop，tokio 会自动 kill
            Err(format!(
                "命令超时 ({}ms)，已终止。命令: {}",
                timeout_duration.as_millis(),
                command
            ))
        }
    }
}

/// 文件名模式搜索（glob）
#[tauri::command]
pub async fn tool_glob(
    pattern: String,
    path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    // 未指定 path 时以家目录兜底，并开启 guard：跳过 TCC 保护目录与隐藏目录。
    // 显式给了 path 就完全按调用方的意思搜，不做额外跳过。
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let explicit = path.is_some();
    let root = path.unwrap_or_else(|| home.to_string_lossy().to_string());

    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("路径不存在: {}", root));
    }
    let guard_home: Option<&Path> = if explicit { None } else { Some(home.as_path()) };

    let max_results = limit.unwrap_or(200).min(1000);
    let mut results = Vec::new();

    // 使用 glob crate 风格匹配（简单实现：递归遍历 + 模式匹配）
    let glob_pattern = glob::Pattern::new(&pattern)
        .map_err(|e| format!("无效的 glob 模式: {}", e))?;

    fn walk_dir(
        dir: &Path,
        root: &Path,
        pattern: &glob::Pattern,
        results: &mut Vec<String>,
        max: usize,
        guard_home: Option<&Path>,
    ) {
        if results.len() >= max {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if results.len() >= max {
                return;
            }
            let path = entry.path();

            // 排除默认排除目录，宽范围搜索时再跳过隐藏目录与 TCC 保护目录
            if should_exclude(&path) {
                continue;
            }

            let relative = path.strip_prefix(root).unwrap_or(&path);
            let relative_str = relative.to_string_lossy();

            if path.is_file() {
                // 匹配文件名或相对路径
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if pattern.matches(&file_name) || pattern.matches(&relative_str) {
                    results.push(path.to_string_lossy().to_string());
                }
            } else if path.is_dir() {
                if should_skip_dir(&path, guard_home) {
                    continue;
                }
                walk_dir(&path, root, pattern, results, max, guard_home);
            }
        }
    }

    walk_dir(root_path, root_path, &glob_pattern, &mut results, max_results, guard_home);

    results.sort();
    Ok(results)
}

/// 文本内容搜索（grep）
#[tauri::command]
pub async fn tool_grep(
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    limit: Option<usize>,
) -> Result<String, String> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let explicit = path.is_some();
    let root = path.unwrap_or_else(|| home.to_string_lossy().to_string());

    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("路径不存在: {}", root));
    }
    let guard_home: Option<&Path> = if explicit { None } else { Some(home.as_path()) };

    let max_matches = limit.unwrap_or(100).min(500);

    // 编译正则
    let regex = regex::Regex::new(&pattern)
        .map_err(|e| format!("无效的正则表达式: {}", e))?;

    // 可选的文件名过滤
    let include_pattern = include
        .as_ref()
        .map(|p| glob::Pattern::new(p))
        .transpose()
        .map_err(|e| format!("无效的 include 模式: {}", e))?;

    let mut matches = Vec::new();

    fn search_dir(
        dir: &Path,
        regex: &regex::Regex,
        include_pattern: &Option<glob::Pattern>,
        matches: &mut Vec<String>,
        max: usize,
        guard_home: Option<&Path>,
    ) {
        if matches.len() >= max {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if matches.len() >= max {
                return;
            }
            let path = entry.path();

            if should_exclude(&path) {
                continue;
            }

            if path.is_file() {
                // 文件名过滤
                if let Some(ref pat) = include_pattern {
                    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                    if !pat.matches(&file_name) {
                        continue;
                    }
                }

                // 跳过二进制文件（简单判断：检查前 512 字节是否含 \0）
                if let Ok(mut f) = std::fs::File::open(&path) {
                    use std::io::Read;
                    let mut buf = [0u8; 512];
                    if let Ok(n) = f.read(&mut buf) {
                        if buf[..n].contains(&0) {
                            continue;
                        }
                    }
                }

                // 搜索文件内容
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for (line_num, line) in content.lines().enumerate() {
                        if matches.len() >= max {
                            break;
                        }
                        if regex.is_match(line) {
                            matches.push(format!(
                                "{}:{}:{}",
                                path.to_string_lossy(),
                                line_num + 1,
                                line.chars().take(200).collect::<String>()
                            ));
                        }
                    }
                }
            } else if path.is_dir() {
                if should_skip_dir(&path, guard_home) {
                    continue;
                }
                search_dir(&path, regex, include_pattern, matches, max, guard_home);
            }
        }
    }

    // 如果 root 是文件，直接搜索该文件
    if root_path.is_file() {
        if let Ok(content) = std::fs::read_to_string(root_path) {
            for (line_num, line) in content.lines().enumerate() {
                if matches.len() >= max_matches {
                    break;
                }
                if regex.is_match(line) {
                    matches.push(format!(
                        "{}:{}:{}",
                        root,
                        line_num + 1,
                        line.chars().take(200).collect::<String>()
                    ));
                }
            }
        }
    } else {
        search_dir(root_path, &regex, &include_pattern, &mut matches, max_matches, guard_home);
    }

    if matches.is_empty() {
        Ok(format!("No matches found for pattern: {}", pattern))
    } else {
        let total = matches.len();
        let result = matches.join("\n");
        Ok(format!("{}\n\n[{} matches]", result, total))
    }
}

#[cfg(test)]
mod skip_dir_tests {
    use super::*;

    #[test]
    fn 宽范围搜索跳过家目录下的受保护目录() {
        let home = Path::new("/Users/someone");
        let guard = Some(home);
        for name in ["Downloads", "Pictures", "Music", "Documents", "Desktop", "Library"] {
            assert!(
                should_skip_dir(&home.join(name), guard),
                "{} 应被跳过，否则会弹系统授权框",
                name
            );
        }
    }

    #[test]
    fn 显式指定路径时不跳过任何目录() {
        let home = Path::new("/Users/someone");
        // guard 为 None 表示调用方给了明确的 path，尊重其意图
        assert!(!should_skip_dir(&home.join("Downloads"), None));
        assert!(!should_skip_dir(&home.join(".config"), None));
    }

    #[test]
    fn 不误伤工程内的同名目录() {
        let home = Path::new("/Users/someone");
        let guard = Some(home);
        // 只按「home 的直接子目录」判定，工程内叫 Documents/Library 的目录照常搜
        assert!(!should_skip_dir(Path::new("/Users/someone/workspace/app/Documents"), guard));
        assert!(!should_skip_dir(Path::new("/Users/someone/workspace/app/Library"), guard));
    }

    #[test]
    fn 宽范围搜索跳过隐藏目录() {
        let home = Path::new("/Users/someone");
        let guard = Some(home);
        assert!(should_skip_dir(&home.join(".cache"), guard));
        assert!(should_skip_dir(Path::new("/Users/someone/workspace/.venv-custom"), guard));
        assert!(!should_skip_dir(&home.join("workspace"), guard));
    }

    #[test]
    fn 默认排除目录与位置无关() {
        assert!(should_exclude(Path::new("/any/where/node_modules/pkg/index.js")));
        assert!(should_exclude(Path::new("/any/where/.git/config")));
        assert!(!should_exclude(Path::new("/any/where/src/main.rs")));
    }
}
