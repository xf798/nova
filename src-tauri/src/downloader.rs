// ===== 带代理回落的下载器 =====
//
// GitHub 在本地实测只有 21KB/s（自己的仓库也一样，是整体带宽问题），
// 47MB 的模型资产要下 38 分钟。而加速代理实测 4.6-5.2MB/s，同样内容 11 秒。
//
// 两个代理下载的文件 sha256 与官方完全一致，说明代理只是传输通道。
// 因此策略是：优先走快的代理，内容正确性交给 sha256 校验，
// 任一源校验失败就换下一个，最后兜底直连。
//
// 注意代理对「刚上传、尚未缓存」的资产会回源，此时和直连一样慢
// （实测某次首拉 126 秒，缓存后 19 秒）。所以超时要给足，
// 不能因为「代理应该很快」就设短超时。

use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

/// 下载源，按优先级排列。
///
/// 前两个是加速代理，用法是把完整的 GitHub URL 拼在后面。
/// 最后一个空前缀代表直连兜底。
const MIRRORS: &[&str] = &[
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "",
];

/// 单源超时。给足余量：代理未缓存时会回源，速度退化到直连水平。
const PER_SOURCE_TIMEOUT_SECS: u64 = 600;

/// 下载进度
#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub file: String,
    pub downloaded: u64,
    pub total: u64,
    /// 当前使用的源（便于排查是哪个源慢）
    pub source: String,
}

/// 校验文件 sha256 是否匹配
fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got = format!("{:x}", hasher.finalize());
    Ok(got.eq_ignore_ascii_case(expected))
}

/// 已存在且校验通过则跳过下载
pub fn is_valid(path: &Path, expected_sha256: &str) -> bool {
    path.exists() && verify_sha256(path, expected_sha256).unwrap_or(false)
}

/**
 * 下载单个文件，依次尝试各源直到 sha256 校验通过。
 *
 * 先写临时文件再原子改名，避免中断后留下半截文件被当成有效产物。
 */
pub async fn download_verified<F>(
    github_url: &str,
    dest: &Path,
    expected_sha256: &str,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(DownloadProgress),
{
    if is_valid(dest, expected_sha256) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_name = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut errors: Vec<String> = Vec::new();

    for mirror in MIRRORS {
        let url = format!("{}{}", mirror, github_url);
        let source_label = if mirror.is_empty() {
            "github 直连".to_string()
        } else {
            mirror.trim_start_matches("https://").trim_end_matches('/').to_string()
        };

        match try_one_source(&url, dest, &file_name, &source_label, &mut on_progress).await {
            Ok(()) => {
                if verify_sha256(dest, expected_sha256).unwrap_or(false) {
                    println!("[Nova:Download] {} 完成（{}）", file_name, source_label);
                    return Ok(());
                }
                let _ = std::fs::remove_file(dest);
                errors.push(format!("{}: sha256 不匹配", source_label));
            }
            Err(e) => errors.push(format!("{}: {}", source_label, e)),
        }
    }

    Err(format!("{} 下载失败 — {}", file_name, errors.join("; ")))
}

async fn try_one_source<F>(
    url: &str,
    dest: &Path,
    file_name: &str,
    source_label: &str,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(DownloadProgress),
{
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PER_SOURCE_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    // 临时文件带进程号，避免多实例互相覆盖
    let tmp = dest.with_extension(format!("{}.part", std::process::id()));
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_report = std::time::Instant::now();

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        // 限频回报，避免高频 IPC 拖慢下载
        if last_report.elapsed() >= std::time::Duration::from_millis(200) {
            on_progress(DownloadProgress {
                file: file_name.to_string(),
                downloaded,
                total,
                source: source_label.to_string(),
            });
            last_report = std::time::Instant::now();
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;

    on_progress(DownloadProgress {
        file: file_name.to_string(),
        downloaded,
        total: if total > 0 { total } else { downloaded },
        source: source_label.to_string(),
    });
    Ok(())
}

/// 把 GitHub URL 转成走代理的形式（供 updater 等复用）
pub fn accelerated_url(github_url: &str) -> String {
    format!("{}{}", MIRRORS[0], github_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_end_with_direct_fallback() {
        // 最后一个必须是空前缀（直连），否则代理全挂时无路可走
        assert_eq!(*MIRRORS.last().unwrap(), "");
    }

    #[test]
    fn mirrors_are_ordered_fast_first() {
        // gh-proxy 实测最快，应排第一
        assert!(MIRRORS[0].contains("gh-proxy"));
    }

    #[test]
    fn accelerated_url_prefixes_mirror() {
        let u = accelerated_url("https://github.com/a/b/releases/download/v1/x.tar.gz");
        assert!(u.starts_with("https://gh-proxy.com/https://github.com/"));
    }

    #[test]
    fn is_valid_false_for_missing_file() {
        assert!(!is_valid(Path::new("/definitely/not/here"), "abc"));
    }

    #[test]
    fn verify_detects_mismatch() {
        let dir = std::env::temp_dir().join(format!("nova-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.bin");
        std::fs::write(&f, b"hello").unwrap();
        // "hello" 的 sha256
        let correct = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256(&f, correct).unwrap());
        assert!(verify_sha256(&f, "0000").unwrap() == false);
        // 大小写不敏感
        assert!(verify_sha256(&f, &correct.to_uppercase()).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
