/// 企业微信智能机器人 WebSocket 长连接模块
///
/// 协议流程：
/// 1. 连接 wss://openws.work.weixin.qq.com
/// 2. 发送 aibot_subscribe 认证帧（bot_id + secret）

/// 安全的 println 宏，在无终端环境中不会 panic
macro_rules! safe_println {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let msg = format!($($arg)*);
        let _ = std::io::stdout().write_all(msg.as_bytes());
        let _ = std::io::stdout().write_all(b"\n");
        let _ = std::io::stdout().flush();
    }};
}
/// 3. 每 30s 发送 ping 心跳
/// 4. 监听入站消息，通过 Tauri event 转发给前端
/// 5. 断连时指数退避重连
/// 6. 未回复的消息持久化到磁盘，重启后自动重发给前端
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

const WECOM_WS_URL: &str = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAYS: &[u64] = &[2, 5, 10, 30, 60];

// ─── 数据结构 ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComConfig {
    pub bot_id: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BotStatus {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

/// 企微入站消息（前端处理用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComInboundMessage {
    pub request_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub chat_id: String,
    pub chat_type: String, // "single" | "group"
    pub msg_type: String,
    pub text: String,
    pub mentioned: bool,
    pub response_url: String,
}

/// 前端回传的回复内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComReply {
    pub request_id: String,
    pub content: String,
}

/// 状态变更 event payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComStatusEvent {
    pub status: String, // "connected" | "disconnected" | "connecting" | "error"
    pub message: Option<String>,
}

// ─── 消息持久化队列 ───
// 确保重启后未回复的消息能被重新处理

fn pending_messages_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nova")
        .join("wecom-pending.json")
}

/// 读取未完成的消息列表
fn load_pending_messages() -> Vec<WeComInboundMessage> {
    let path = pending_messages_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 保存未完成的消息列表
fn save_pending_messages(messages: &[WeComInboundMessage]) {
    let path = pending_messages_path();
    if let Ok(json) = serde_json::to_string_pretty(messages) {
        let _ = std::fs::write(&path, json);
    }
}

/// 添加一条待处理消息
fn add_pending_message(msg: &WeComInboundMessage) {
    let mut pending = load_pending_messages();
    // 避免重复（按 request_id 去重）
    if !pending.iter().any(|m| m.request_id == msg.request_id) {
        pending.push(msg.clone());
        save_pending_messages(&pending);
    }
}

/// 移除已完成的消息（前端回复后调用）
pub fn remove_pending_message(request_id: &str) {
    let mut pending = load_pending_messages();
    let before = pending.len();
    pending.retain(|m| m.request_id != request_id);
    if pending.len() != before {
        save_pending_messages(&pending);
        safe_println!("[WeCom] 已完成消息移出队列: {} (剩余 {})", request_id, pending.len());
    }
}

/// 重启后重发未完成的消息给前端（同时清理过期消息）
pub fn replay_pending_messages(app: &AppHandle) {
    let mut pending = load_pending_messages();
    if pending.is_empty() {
        return;
    }

    // 清理超过 5 分钟的过期消息（企微 response 有时效性）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let max_age_secs = 300; // 5 分钟

    let _before_len = pending.len();
    pending.retain(|_msg| {
        // request_id 通常包含时间戳信息，但我们用文件 mtime 作为近似
        // 这里简单处理：保留所有消息让前端尝试，过期的前端回复失败后自然移除
        true
    });

    // 如果文件本身超过 5 分钟没更新，说明都是旧的，全部清空
    let path = pending_messages_path();
    let file_too_old = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
        .map(|d| now.saturating_sub(d.as_secs()) > max_age_secs)
        .unwrap_or(false);

    if file_too_old {
        safe_println!("[WeCom] pending 消息已过期（超过 {}s），清空", max_age_secs);
        save_pending_messages(&[]);
        return;
    }

    safe_println!("[WeCom] 发现 {} 条未回复的消息，重新发送给前端处理", pending.len());
    for msg in &pending {
        safe_println!("[WeCom] 重发: req_id={}, from={}, text={}", msg.request_id, msg.sender_name, msg.text.chars().take(30).collect::<String>());
        let _ = app.emit("wecom-message", msg);
    }
}

// ─── Bot 管理器 ───

pub struct WeComBot {
    status: Arc<RwLock<BotStatus>>,
    /// 发送 reply 到 WebSocket 的 channel
    reply_tx: Arc<Mutex<Option<mpsc::Sender<WeComReply>>>>,
    /// 停止信号
    stop_tx: Arc<Mutex<Option<mpsc::Sender<()>>>>,
}

impl WeComBot {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(BotStatus::Disconnected)),
            reply_tx: Arc::new(Mutex::new(None)),
            stop_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_status(&self) -> BotStatus {
        self.status.read().await.clone()
    }

    /// 启动机器人（后台 task）
    pub async fn start(&self, config: WeComConfig, app: AppHandle) -> Result<(), String> {
        // 如果已在运行，先停止
        self.stop().await;

        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let (reply_tx, reply_rx) = mpsc::channel::<WeComReply>(64);

        *self.stop_tx.lock().await = Some(stop_tx);
        *self.reply_tx.lock().await = Some(reply_tx);

        let status = self.status.clone();
        let reply_rx = Arc::new(Mutex::new(reply_rx));

        // 启动后台连接任务
        tokio::spawn(async move {
            let mut retry_count: usize = 0;

            loop {
                // 检查停止信号
                if stop_rx.try_recv().is_ok() {
                    *status.write().await = BotStatus::Disconnected;
                    emit_status(&app, "disconnected", None);
                    break;
                }

                *status.write().await = BotStatus::Connecting;
                emit_status(&app, "connecting", None);

                match run_connection(&config, &app, &reply_rx, &mut stop_rx, &status).await {
                    Ok(()) => {
                        // 正常关闭（收到 stop 信号）
                        *status.write().await = BotStatus::Disconnected;
                        emit_status(&app, "disconnected", None);
                        break;
                    }
                    Err(e) => {
                        let msg = format!("{}", e);
                        safe_println!("[WeCom] 连接失败: {}", msg);
                        *status.write().await = BotStatus::Error(msg.clone());
                        emit_status(&app, "error", Some(msg));

                        // 指数退避
                        let delay_idx = retry_count.min(RECONNECT_DELAYS.len() - 1);
                        let delay = Duration::from_secs(RECONNECT_DELAYS[delay_idx]);
                        retry_count += 1;
                        safe_println!("[WeCom] 将在 {}s 后重连（第 {} 次）", delay.as_secs(), retry_count);

                        tokio::select! {
                            _ = time::sleep(delay) => {},
                            _ = stop_rx.recv() => {
                                *status.write().await = BotStatus::Disconnected;
                                emit_status(&app, "disconnected", None);
                                break; // 在等待期间收到停止
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    /// 停止机器人
    pub async fn stop(&self) {
        if let Some(tx) = self.stop_tx.lock().await.take() {
            let _ = tx.send(()).await;
        }
        *self.reply_tx.lock().await = None;
    }

    /// 发送回复（前端调用）
    pub async fn send_reply(&self, reply: WeComReply) -> Result<(), String> {
        let tx = self.reply_tx.lock().await;
        if let Some(ref tx) = *tx {
            tx.send(reply).await.map_err(|e| format!("发送回复失败: {}", e))
        } else {
            Err("机器人未运行".to_string())
        }
    }
}

// ─── WebSocket 连接运行逻辑 ───

async fn run_connection(
    config: &WeComConfig,
    app: &AppHandle,
    reply_rx: &Arc<Mutex<mpsc::Receiver<WeComReply>>>,
    stop_rx: &mut mpsc::Receiver<()>,
    status: &Arc<RwLock<BotStatus>>,
) -> Result<(), String> {
    // 1. 连接
    let (ws_stream, _) = connect_async(WECOM_WS_URL)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    safe_println!("[WeCom] WebSocket 已连接到 {}, 发送认证...", WECOM_WS_URL);
    let (mut write, mut read) = ws_stream.split();

    // 2. 发送认证
    let auth_frame = serde_json::json!({
        "cmd": "aibot_subscribe",
        "headers": {},
        "body": {
            "bot_id": config.bot_id,
            "secret": config.secret,
        }
    });
    write
        .send(WsMessage::Text(auth_frame.to_string()))
        .await
        .map_err(|e| format!("发送认证失败: {}", e))?;

    // 3. 等待认证响应（可能需要跳过非文本帧）
    let auth_deadline = time::Instant::now() + AUTH_TIMEOUT;
    let mut authenticated = false;

    while time::Instant::now() < auth_deadline && !authenticated {
        let auth_result = tokio::select! {
            msg = read.next() => msg,
            _ = time::sleep_until(auth_deadline) => {
                return Err("认证超时（10s 内未收到确认）".to_string());
            }
        };

        match auth_result {
            Some(Ok(WsMessage::Text(text))) => {
                let preview: String = text.chars().take(200).collect();
                safe_println!("[WeCom] 收到认证响应: {}", preview);
                let val: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                let cmd = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                let errcode = val.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);

                if errcode == 0 {
                    safe_println!("[WeCom] ✅ 认证成功 (cmd={})", cmd);
                    *status.write().await = BotStatus::Connected;
                    emit_status(app, "connected", None);
                    authenticated = true;
                } else if errcode > 0 {
                    let err_msg = val.get("errmsg")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知错误");
                    return Err(format!("认证失败 [{}]: {}", errcode, err_msg));
                } else {
                    // errcode 不存在或为负数，可能是其他帧类型
                    safe_println!("[WeCom] 收到非认证帧: cmd={}, 继续等待...", cmd);
                }
            }
            Some(Ok(WsMessage::Ping(data))) => {
                let _ = write.send(WsMessage::Pong(data)).await;
            }
            Some(Ok(WsMessage::Close(frame))) => {
                let reason = frame.map(|f| f.reason.to_string()).unwrap_or_default();
                return Err(format!("服务端关闭连接: {}", reason));
            }
            Some(Ok(_)) => {
                // 跳过其他帧类型
            }
            Some(Err(e)) => return Err(format!("认证阶段错误: {}", e)),
            None => return Err("连接在认证阶段关闭".to_string()),
        }
    }

    if !authenticated {
        return Err("认证超时".to_string());
    }

    // 4. 主循环：心跳 + 接收消息 + 发送回复
    let mut heartbeat_interval = time::interval(HEARTBEAT_INTERVAL);
    let mut reply_rx_guard = reply_rx.lock().await;

    loop {
        tokio::select! {
            // 心跳
            _ = heartbeat_interval.tick() => {
                if write.send(WsMessage::Ping(vec![])).await.is_err() {
                    return Err("心跳发送失败，连接可能已断开".to_string());
                }
            }

            // 接收消息
            msg = read.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        handle_inbound_frame(&text, app);
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = write.send(WsMessage::Pong(data)).await;
                    }
                    Some(Ok(WsMessage::Pong(_))) => {} // 忽略 pong
                    Some(Ok(WsMessage::Close(_))) => {
                        return Err("服务端关闭连接".to_string());
                    }
                    Some(Err(e)) => {
                        return Err(format!("接收错误: {}", e));
                    }
                    None => {
                        return Err("连接已关闭".to_string());
                    }
                    _ => {}
                }
            }

            // 发送回复（从前端来的）— 使用 aibot_respond_msg + stream 格式
            reply = reply_rx_guard.recv() => {
                if let Some(reply) = reply {
                    let stream_id = format!("stream-{}", &reply.request_id);
                    let frame = serde_json::json!({
                        "cmd": "aibot_respond_msg",
                        "headers": {
                            "req_id": reply.request_id,
                        },
                        "body": {
                            "msgtype": "stream",
                            "stream": {
                                "id": stream_id,
                                "finish": true,
                                "content": reply.content,
                            }
                        }
                    });
                    let preview: String = reply.content.chars().take(100).collect();
                    println!("[WeCom] 发送回复 (aibot_respond_msg): req_id={}, 内容: {}", reply.request_id, preview);
                    if write.send(WsMessage::Text(frame.to_string())).await.is_err() {
                        return Err("发送回复失败".to_string());
                    }
                    println!("[WeCom] 回复已发送: request_id={}", reply.request_id);
                }
            }

            // 停止信号
            _ = stop_rx.recv() => {
                let _ = write.send(WsMessage::Close(None)).await;
                return Ok(());
            }
        }
    }
}

/// 解析并转发入站消息到前端
fn handle_inbound_frame(text: &str, app: &AppHandle) {
    let val: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            let preview: String = text.chars().take(100).collect();
            safe_println!("[WeCom] 收到非 JSON 帧: {}", preview);
            return;
        }
    };

    let cmd = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

    // 打印所有收到的帧（调试用）
    let frame_preview: String = text.chars().take(300).collect();
    safe_println!("[WeCom] 收到帧: cmd={}, 内容={}", cmd, frame_preview);

    // 心跳帧忽略
    if cmd == "heartbeat" || cmd == "pong" || cmd == "" {
        return;
    }

    // 处理消息回调
    if cmd != "aibot_msg_callback" {
        safe_println!("[WeCom] 未处理的 cmd: {}", cmd);
        return;
    }

    let headers = val.get("headers").unwrap_or(&serde_json::Value::Null);
    let body = val.get("body").unwrap_or(&serde_json::Value::Null);

    let request_id = headers.get("req_id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // from 是对象: {"userid": "xxx"} 或字符串
    let sender_id = body.get("from")
        .and_then(|f| {
            // 先尝试作为对象取 userid
            f.get("userid").and_then(|v| v.as_str())
                .or_else(|| f.as_str())
        })
        .unwrap_or("").to_string();
    let sender_name = body.get("sender_name").and_then(|v| v.as_str()).unwrap_or(&sender_id).to_string();

    // chatid / chattype（注意企微用的是 chattype 不是 chat_type）
    let chat_id = body.get("chatid").and_then(|v| v.as_str())
        .or_else(|| body.get("chat_id").and_then(|v| v.as_str()))
        .unwrap_or(&sender_id).to_string();
    let chat_type = body.get("chattype").and_then(|v| v.as_str())
        .or_else(|| body.get("chat_type").and_then(|v| v.as_str()))
        .unwrap_or("single").to_string();

    let msg_type = body.get("msgtype").and_then(|v| v.as_str())
        .or_else(|| body.get("msg_type").and_then(|v| v.as_str()))
        .unwrap_or("text").to_string();

    // 提取文本内容：body.text.content
    let text_content = body.get("text").and_then(|t| t.get("content")).and_then(|v| v.as_str())
        .or_else(|| body.get("content").and_then(|v| v.as_str()))
        .unwrap_or("").to_string();

    // 私聊默认算 mentioned
    let mentioned = body.get("mentioned").and_then(|v| v.as_bool())
        .unwrap_or(chat_type == "single");

    if request_id.is_empty() || sender_id.is_empty() {
        safe_println!("[WeCom] 消息缺少 req_id 或 sender_id，跳过");
        return;
    }

    // 群聊未 @ 则忽略
    if chat_type == "group" && !mentioned {
        return;
    }

    // 提取 response_url
    let response_url = body.get("response_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let msg = WeComInboundMessage {
        request_id,
        sender_id,
        sender_name,
        chat_id,
        chat_type,
        msg_type,
        text: text_content,
        mentioned,
        response_url,
    };

    // 发送 Tauri event 到前端（先持久化，确保重启不丢）
    add_pending_message(&msg);
    let _ = app.emit("wecom-message", &msg);
    safe_println!("[WeCom] 收到消息: {} -> {}", msg.sender_name, msg.text.chars().take(50).collect::<String>());
}

/// 发送状态变更事件
fn emit_status(app: &AppHandle, status: &str, message: Option<String>) {
    let event = WeComStatusEvent {
        status: status.to_string(),
        message,
    };
    let _ = app.emit("wecom-status", &event);
}
