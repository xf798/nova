// ===== 本地语义召回 =====
//
// 词面匹配已到顶：换过 IDF 加权、会话当查询、反向覆盖度三种算法都没解决
// 「语义无关但共享泛用词」的误召回，用 API 嵌入实测也一样。
// 真正的解是让机器理解语义，也就是向量召回。
//
// 设计要点：
// - 模型不打进应用包。ort 的 load-dynamic 特性让 onnxruntime 在运行时 dlopen，
//   二进制只增加 0.35MB（实测 29.40→29.75MB），模型与 dylib 首次启用时下载。
// - 模型 bge-small-zh-v1.5 int8：24M 参数、512 维、专门针对中文。
//   更强的 Qwen3-Embedding-0.6B 参数量大 25 倍，不适合「可选下载」的定位。
// - 实测冷启动加载 47ms、单条编码 1-2ms、100 条全量编码 827ms，
//   加在首字延迟上无感（对比 API 嵌入的 211ms 单条）。

use std::path::PathBuf;
use std::sync::Mutex;

/// 模型输出维度（bge-small 系列为 512）
const EMBED_DIM: usize = 512;
/// 单条文本最大 token 数，超出截断（模型上下文 512）
const MAX_TOKENS: usize = 512;

/// 资产清单：文件名 → sha256
///
/// 放在 nova-releases 的 models-v1 这个 **prerelease** 上。
///
/// 必须是 prerelease：updater 的 endpoint 用的是
/// `releases/latest/download/latest.json`，而 `latest` 别名指向最新的
/// 非 prerelease release。models-v1 若不标 prerelease 就会抢占该别名，
/// 导致所有客户端更新检查 404（已实际踩到并修复）。
const ASSET_BASE: &str =
    "https://github.com/xf798/nova-releases/releases/download/models-v1";

pub struct Asset {
    pub name: &'static str,
    pub sha256: &'static str,
}

pub const ASSETS: &[Asset] = &[
    Asset {
        name: "model.onnx",
        sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    },
    Asset {
        name: "tokenizer.json",
        sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    },
    Asset {
        name: "libonnxruntime.dylib",
        sha256: "530cdb5a0de774677d369a83ec8912b0242e9769acd12d34b61412ee6ae368ae",
    },
];

pub fn models_dir() -> PathBuf {
    crate::data_dir().join("models")
}

pub fn asset_url(name: &str) -> String {
    format!("{}/{}", ASSET_BASE, name)
}

pub fn asset_path(name: &str) -> PathBuf {
    models_dir().join(name)
}

/// 三个文件是否都已就位且校验通过
pub fn assets_ready() -> bool {
    ASSETS
        .iter()
        .all(|a| crate::downloader::is_valid(&asset_path(a.name), a.sha256))
}

// ===== 推理会话 =====
//
// ort 的 Session 不是 Sync，用 Mutex 包起来在命令间共享，
// 避免每次召回都重新加载模型（冷启动 47ms 虽不算长，但没必要每次付）。

struct Engine {
    session: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

/// 确保引擎已加载。资产缺失时返回 Err，调用方据此降级为关键词召回。
fn ensure_engine() -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    if !assets_ready() {
        return Err("模型资产未就绪".into());
    }

    // load-dynamic 靠这个环境变量找 dylib
    let dylib = asset_path("libonnxruntime.dylib");
    std::env::set_var("ORT_DYLIB_PATH", &dylib);

    let session = ort::session::Session::builder()
        .map_err(|e| format!("创建 session builder 失败: {e}"))?
        .commit_from_file(asset_path("model.onnx"))
        .map_err(|e| format!("加载模型失败: {e}"))?;

    let tokenizer = tokenizers::Tokenizer::from_file(asset_path("tokenizer.json"))
        .map_err(|e| format!("加载 tokenizer 失败: {e}"))?;

    *guard = Some(Engine { session, tokenizer });
    println!("[Nova:Embed] 引擎已加载");
    Ok(())
}

/// 编码一批文本为归一化向量
pub fn embed_batch(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    ensure_engine()?;
    let mut guard = ENGINE.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("引擎未初始化")?;

    if texts.is_empty() {
        return Ok(vec![]);
    }

    // 分词并对齐到批内最长
    let mut all_ids: Vec<Vec<i64>> = Vec::with_capacity(texts.len());
    for t in texts {
        let enc = engine
            .tokenizer
            .encode(t.as_str(), true)
            .map_err(|e| format!("分词失败: {e}"))?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        ids.truncate(MAX_TOKENS);
        all_ids.push(ids);
    }
    let max_len = all_ids.iter().map(|v| v.len()).max().unwrap_or(1).max(1);
    let batch = all_ids.len();

    let mut input_ids = vec![0i64; batch * max_len];
    let mut attention = vec![0i64; batch * max_len];
    let token_type = vec![0i64; batch * max_len];
    for (i, ids) in all_ids.iter().enumerate() {
        for (j, &id) in ids.iter().enumerate() {
            input_ids[i * max_len + j] = id;
            attention[i * max_len + j] = 1;
        }
    }

    let shape = [batch, max_len];
    let outputs = engine
        .session
        .run(ort::inputs![
            "input_ids" => ort::value::Tensor::from_array((shape, input_ids)).map_err(|e| e.to_string())?,
            "attention_mask" => ort::value::Tensor::from_array((shape, attention.clone())).map_err(|e| e.to_string())?,
            "token_type_ids" => ort::value::Tensor::from_array((shape, token_type)).map_err(|e| e.to_string())?,
        ])
        .map_err(|e| format!("推理失败: {e}"))?;

    let (out_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("取输出失败: {e}"))?;

    // last_hidden_state 形状 [batch, seq, dim]，需做 mean pooling
    let dim = *out_shape.last().unwrap_or(&(EMBED_DIM as i64)) as usize;
    let seq = if out_shape.len() >= 2 {
        out_shape[out_shape.len() - 2] as usize
    } else {
        max_len
    };

    let mut result = Vec::with_capacity(batch);
    for b in 0..batch {
        let mut sum = vec![0f32; dim];
        let mut count = 0f32;
        for s in 0..seq {
            // padding 位不参与平均，否则短文本会被零向量拉偏
            if attention[b * max_len + s] == 0 {
                continue;
            }
            let base = (b * seq + s) * dim;
            for d in 0..dim {
                sum[d] += data[base + d];
            }
            count += 1.0;
        }
        if count > 0.0 {
            for v in sum.iter_mut() {
                *v /= count;
            }
        }
        // L2 归一化，之后余弦相似度就是点积
        let norm = sum.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in sum.iter_mut() {
                *v /= norm;
            }
        }
        result.push(sum);
    }
    Ok(result)
}

/// 余弦相似度。向量已归一化，因此等于点积。
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ===== 向量存储 =====
//
// 存 f32 而非 f16：100 条记忆 × 512 维 × 4 字节 = 200KB，省那 100KB 不值得
// 引入半精度转换的复杂度与精度损失。
//
// 按 id 索引，新增记忆时只编码一条即可，不必全量重建。

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct VectorStore {
    /// 记忆 id → 向量
    pub vectors: std::collections::HashMap<String, Vec<f32>>,
    /// 生成这些向量的模型标识；换模型后需全量重建
    pub model: String,
}

fn store_path() -> PathBuf {
    models_dir().join("embeddings.json")
}

pub fn load_store() -> VectorStore {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save_store(store: &VectorStore) -> Result<(), String> {
    std::fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    crate::atomic_write(&store_path(), json.as_bytes())
}

// ===== Tauri 命令 =====

/// 语义召回是否可用（资产齐备）
#[tauri::command]
pub fn embedding_status() -> serde_json::Value {
    let files: Vec<serde_json::Value> = ASSETS
        .iter()
        .map(|a| {
            let p = asset_path(a.name);
            serde_json::json!({
                "name": a.name,
                "ready": crate::downloader::is_valid(&p, a.sha256),
                "size": std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
            })
        })
        .collect();
    let store = load_store();
    serde_json::json!({
        "ready": assets_ready(),
        "files": files,
        "indexedCount": store.vectors.len(),
        "model": store.model,
    })
}

/// 下载模型资产，进度通过事件回报
#[tauri::command]
pub async fn download_embedding_model(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    for a in ASSETS {
        let dest = asset_path(a.name);
        let app2 = app.clone();
        crate::downloader::download_verified(&asset_url(a.name), &dest, a.sha256, move |p| {
            let _ = app2.emit("nova-model-download", &p);
        })
        .await?;
    }
    println!("[Nova:Embed] 全部资产就绪");
    Ok(())
}

/// 删除已下载的模型资产与索引
#[tauri::command]
pub fn remove_embedding_model() -> Result<(), String> {
    for a in ASSETS {
        let p = asset_path(a.name);
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    let sp = store_path();
    if sp.exists() {
        std::fs::remove_file(&sp).map_err(|e| e.to_string())?;
    }
    // 卸载后引擎里的 session 也要丢掉，否则仍持有已删除文件的句柄
    if let Ok(mut g) = ENGINE.lock() {
        *g = None;
    }
    Ok(())
}

/// 为给定记忆建立/补齐索引。只编码缺失的条目。
#[tauri::command]
pub fn index_memories(items: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut store = load_store();
    let model_tag = "bge-small-zh-v1.5-int8";
    // 换模型后旧向量不可比，全部作废
    if store.model != model_tag {
        store.vectors.clear();
        store.model = model_tag.to_string();
    }

    let mut pending_ids: Vec<String> = Vec::new();
    let mut pending_texts: Vec<String> = Vec::new();
    let mut present: std::collections::HashSet<String> = std::collections::HashSet::new();

    for it in &items {
        let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let content = it.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() || content.is_empty() {
            continue;
        }
        present.insert(id.clone());
        if !store.vectors.contains_key(&id) {
            pending_ids.push(id);
            pending_texts.push(content.to_string());
        }
    }

    // 已删除的记忆，其向量一并清理，避免无限增长
    store.vectors.retain(|k, _| present.contains(k));

    let mut encoded = 0usize;
    if !pending_texts.is_empty() {
        // 分批推理，避免单批张量过大
        const BATCH: usize = 16;
        for chunk_start in (0..pending_texts.len()).step_by(BATCH) {
            let end = (chunk_start + BATCH).min(pending_texts.len());
            let vecs = embed_batch(&pending_texts[chunk_start..end])?;
            for (offset, v) in vecs.into_iter().enumerate() {
                store.vectors.insert(pending_ids[chunk_start + offset].clone(), v);
                encoded += 1;
            }
        }
    }

    save_store(&store)?;
    Ok(serde_json::json!({
        "indexed": store.vectors.len(),
        "newlyEncoded": encoded,
    }))
}

/// 语义检索：返回 id → 相似度
#[tauri::command]
pub fn semantic_search(query: String, top_k: Option<usize>) -> Result<serde_json::Value, String> {
    if query.trim().is_empty() {
        return Ok(serde_json::json!({ "hits": [] }));
    }
    let store = load_store();
    if store.vectors.is_empty() {
        return Ok(serde_json::json!({ "hits": [] }));
    }
    let qv = embed_batch(&[query])?
        .into_iter()
        .next()
        .ok_or("查询编码失败")?;

    let mut scored: Vec<(String, f32)> = store
        .vectors
        .iter()
        .map(|(id, v)| (id.clone(), cosine(&qv, v)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k.unwrap_or(10));

    Ok(serde_json::json!({
        "hits": scored.iter().map(|(id, s)| serde_json::json!({ "id": id, "score": s })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_of_identical_normalized_is_one() {
        let v = vec![0.6f32, 0.8]; // 已归一化
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_opposite_is_negative_one() {
        assert!((cosine(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_mismatched_dims_returns_zero() {
        assert_eq!(cosine(&[1.0, 0.0], &[1.0]), 0.0);
    }

    #[test]
    fn asset_url_points_to_models_release() {
        let u = asset_url("model.onnx");
        assert!(u.contains("/models-v1/model.onnx"));
    }

    #[test]
    fn all_assets_have_full_length_sha256() {
        for a in ASSETS {
            assert_eq!(a.sha256.len(), 64, "{} 的哈希长度不对", a.name);
        }
    }

    #[test]
    fn asset_list_covers_model_tokenizer_and_runtime() {
        let names: Vec<&str> = ASSETS.iter().map(|a| a.name).collect();
        assert!(names.contains(&"model.onnx"));
        assert!(names.contains(&"tokenizer.json"));
        assert!(names.contains(&"libonnxruntime.dylib"));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    /// 需要真实模型资产，缺失时自动跳过（CI 上不会失败）
    fn skip_if_missing() -> bool {
        if !assets_ready() {
            println!("跳过：模型资产未就绪");
            return true;
        }
        false
    }

    #[test]
    fn embeds_text_into_normalized_vector() {
        if skip_if_missing() { return; }
        let v = embed_batch(&["会话存储改成 JSONL".to_string()]).expect("编码失败");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].len(), EMBED_DIM, "维度应为 {}", EMBED_DIM);
        let norm: f32 = v[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "应已 L2 归一化，实际 norm={}", norm);
    }

    #[test]
    fn similar_texts_score_higher_than_unrelated() {
        if skip_if_missing() { return; }
        let texts = vec![
            "会话存储从整体 JSON 改成 JSONL 追加写".to_string(),  // 基准
            "消息持久化改为逐行追加的 jsonl 格式".to_string(),      // 语义相近
            "客户画像页面的下拉框需要支持搜索".to_string(),         // 无关
        ];
        let v = embed_batch(&texts).expect("编码失败");
        let near = cosine(&v[0], &v[1]);
        let far = cosine(&v[0], &v[2]);
        println!("  相近={:.3}  无关={:.3}", near, far);
        assert!(near > far, "语义相近的应得分更高：{} vs {}", near, far);
    }

    #[test]
    fn batch_encoding_matches_single() {
        if skip_if_missing() { return; }
        let t = "打包发布流程".to_string();
        let single = embed_batch(&[t.clone()]).unwrap();
        let batched = embed_batch(&[t.clone(), "另一段无关文字".to_string()]).unwrap();
        // 同一文本在批内与单独编码应基本一致（padding 已被 attention mask 排除）
        let sim = cosine(&single[0], &batched[0]);
        assert!(sim > 0.99, "批内编码应与单条一致，实际相似度 {}", sim);
    }
}

#[cfg(test)]
mod quality_tests {
    use super::*;

    #[test]
    fn compare_recall_quality_on_real_memories() {
        if !assets_ready() { println!("跳过：资产未就绪"); return; }
        let home = std::env::var("HOME").unwrap();
        let raw = match std::fs::read_to_string(format!("{}/.nova/app-storage.json", home)) {
            Ok(r) => r, Err(_) => { println!("跳过：无记忆库"); return; }
        };
        let j: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mems: Vec<(String, String)> = j["memory"]["longterm"].as_array()
            .map(|a| a.iter().filter_map(|m| {
                let c = m.get("content")?.as_str()?;
                let cat = m.get("category")?.as_str().unwrap_or("");
                Some((cat.to_string(), c.to_string()))
            }).collect()).unwrap_or_default();
        if mems.is_empty() { println!("跳过：记忆为空"); return; }

        println!("\n  记忆库 {} 条，编码中…", mems.len());
        let t0 = std::time::Instant::now();
        let texts: Vec<String> = mems.iter().map(|(_, c)| c.chars().take(500).collect()).collect();
        let mut vecs = Vec::new();
        for chunk in texts.chunks(16) {
            vecs.extend(embed_batch(chunk).expect("编码失败"));
        }
        println!("  编码耗时 {:?}\n", t0.elapsed());

        let cases = [
            "会话存储为什么要改成 JSONL",
            "切换会话卡顿是怎么解决的",
            "updater 的签名怎么验证",
            "客户画像的字段推断在哪一步",
        ];
        for q in cases {
            let t = std::time::Instant::now();
            let qv = embed_batch(&[q.to_string()]).unwrap().remove(0);
            let enc_ms = t.elapsed().as_millis();
            let mut scored: Vec<(f32, &str, &str)> = vecs.iter().enumerate()
                .map(|(i, v)| (cosine(&qv, v), mems[i].0.as_str(), mems[i].1.as_str()))
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            println!("  Q \"{}\"  (查询编码 {}ms)", q, enc_ms);
            for (s, cat, c) in scored.iter().take(3) {
                let preview: String = c.chars().take(46).collect();
                println!("     {:.3} [{}] {}", s, cat, preview);
            }
            println!();
        }
    }
}
