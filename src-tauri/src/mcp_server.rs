// ===== Nova MCP Server =====
//
// 轻量 HTTP MCP Server，将 Nova 前端 toolRegistry 中的 tools 暴露给 kiro-cli agent。
// 协议: MCP Streamable HTTP Transport (JSON-RPC over HTTP POST)
// 绑定: 127.0.0.1 随机端口
//
// 通信链路: kiro-cli → HTTP POST → axum → Tauri event → WebView toolRegistry → Tauri command → axum → HTTP response

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tauri::{AppHandle, Emitter, Runtime};

// ─── JSON-RPC 类型 ───

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ─── MCP 请求/响应 事件载荷 ───

/// 发往 WebView 的 MCP 请求事件
#[derive(Debug, Clone, Serialize)]
struct McpRequestEvent {
    /// 请求唯一 ID（用于匹配响应）
    request_id: String,
    /// MCP method: "tools/list" | "tools/call"
    method: String,
    /// 请求参数
    params: Option<serde_json::Value>,
}

/// 从 WebView 收到的 MCP 响应（通过 Tauri command）
#[derive(Debug, Deserialize)]
pub struct McpResponsePayload {
    pub request_id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

// ─── Server 状态 ───

struct McpServerState<R: Runtime> {
    app_handle: AppHandle<R>,
    /// 等待 WebView 响应的 pending requests
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<McpResponsePayload>>>>,
}

impl<R: Runtime> Clone for McpServerState<R> {
    fn clone(&self) -> Self {
        Self {
            app_handle: self.app_handle.clone(),
            pending: self.pending.clone(),
        }
    }
}

// ─── 全局 pending map（供 Tauri command 回传结果） ───

use std::sync::OnceLock;

fn get_pending_requests() -> &'static Arc<Mutex<HashMap<String, oneshot::Sender<McpResponsePayload>>>> {
    static INSTANCE: OnceLock<Arc<Mutex<HashMap<String, oneshot::Sender<McpResponsePayload>>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// 启动 MCP Server，返回监听端口
pub async fn start_mcp_server<R: Runtime>(app_handle: AppHandle<R>) -> Result<u16, String> {
    let state = McpServerState {
        app_handle,
        pending: get_pending_requests().clone(),
    };

    let app = Router::new()
        .route("/mcp", post(handle_mcp_post))
        .route("/mcp", get(handle_mcp_get))
        .with_state(state);

    // 绑定到随机可用端口
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind MCP server: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?
        .port();

    // 后台运行 server
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    Ok(port)
}

/// Tauri command：WebView 侧调用此函数回传 MCP 执行结果
#[tauri::command]
pub async fn mcp_respond(payload: McpResponsePayload) -> Result<(), String> {
    let mut pending = get_pending_requests().lock().await;
    if let Some(sender) = pending.remove(&payload.request_id) {
        sender.send(payload).ok();
    }
    Ok(())
}

// ─── HTTP Handlers ───

async fn handle_mcp_post<R: Runtime>(
    State(state): State<McpServerState<R>>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, HeaderMap, String) {
    // 安全校验：验证 Origin header（防止 DNS rebinding）
    if let Some(origin) = headers.get("origin") {
        let origin_str = origin.to_str().unwrap_or("");
        // 只允许来自 localhost/tauri 的请求
        if !origin_str.is_empty()
            && !origin_str.contains("localhost")
            && !origin_str.contains("127.0.0.1")
            && !origin_str.contains("tauri://")
        {
            return error_response(StatusCode::FORBIDDEN, "Origin not allowed");
        }
    }

    // 解析 JSON-RPC 请求
    let request: JsonRpcRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            return json_rpc_error_response(
                serde_json::Value::Null,
                -32700,
                &format!("Parse error: {}", e),
            );
        }
    };

    let id = request.id.clone().unwrap_or(serde_json::Value::Null);

    match request.method.as_str() {
        "initialize" => handle_initialize(id),
        "tools/list" => handle_tools_request(&state, id, "tools/list", request.params).await,
        "tools/call" => handle_tools_request(&state, id, "tools/call", request.params).await,
        "notifications/initialized" => {
            // 通知类消息，返回 202
            (StatusCode::ACCEPTED, HeaderMap::new(), String::new())
        }
        _ => json_rpc_error_response(id, -32601, &format!("Method not found: {}", request.method)),
    }
}

async fn handle_mcp_get<R: Runtime>(
    State(_state): State<McpServerState<R>>,
) -> (StatusCode, &'static str) {
    // GET 用于 SSE 流，我们不支持，返回 405
    (StatusCode::METHOD_NOT_ALLOWED, "SSE not supported")
}

// ─── MCP Method Handlers ───

fn handle_initialize(id: serde_json::Value) -> (StatusCode, HeaderMap, String) {
    let result = serde_json::json!({
        "protocolVersion": "2025-03-26",
        "capabilities": {
            "tools": {
                "listChanged": true
            }
        },
        "serverInfo": {
            "name": "nova-tools",
            "version": "1.0.0"
        }
    });

    json_rpc_success_response(id, result)
}

async fn handle_tools_request<R: Runtime>(
    state: &McpServerState<R>,
    id: serde_json::Value,
    method: &str,
    params: Option<serde_json::Value>,
) -> (StatusCode, HeaderMap, String) {
    // 生成唯一请求 ID
    let request_id = format!("mcp-{}", uuid_v4());

    // 创建 oneshot channel 等待 WebView 响应
    let (tx, rx) = oneshot::channel::<McpResponsePayload>();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(request_id.clone(), tx);
    }

    // 发送事件到 WebView
    let event = McpRequestEvent {
        request_id: request_id.clone(),
        method: method.to_string(),
        params,
    };

    if let Err(e) = state.app_handle.emit("mcp-request", &event) {
        // 清理 pending
        let mut pending = state.pending.lock().await;
        pending.remove(&request_id);
        return json_rpc_error_response(id, -32603, &format!("Failed to emit event: {}", e));
    }

    // 等待 WebView 响应（超时 10 秒）
    let response = tokio::time::timeout(std::time::Duration::from_secs(10), rx).await;

    match response {
        Ok(Ok(payload)) => {
            if let Some(error_msg) = payload.error {
                json_rpc_error_response(id, -32603, &error_msg)
            } else {
                let result = payload.result.unwrap_or(serde_json::Value::Null);
                json_rpc_success_response(id, result)
            }
        }
        Ok(Err(_)) => {
            json_rpc_error_response(id, -32603, "Internal: channel closed")
        }
        Err(_) => {
            // 超时，清理 pending
            let mut pending = state.pending.lock().await;
            pending.remove(&request_id);
            json_rpc_error_response(id, -32603, "Timeout waiting for tool execution")
        }
    }
}

// ─── Helper functions ───

fn json_rpc_success_response(
    id: serde_json::Value,
    result: serde_json::Value,
) -> (StatusCode, HeaderMap, String) {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(result),
        error: None,
    };
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    (StatusCode::OK, headers, serde_json::to_string(&resp).unwrap())
}

fn json_rpc_error_response(
    id: serde_json::Value,
    code: i32,
    message: &str,
) -> (StatusCode, HeaderMap, String) {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
    };
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    (StatusCode::OK, headers, serde_json::to_string(&resp).unwrap())
}

fn error_response(status: StatusCode, message: &str) -> (StatusCode, HeaderMap, String) {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "text/plain".parse().unwrap());
    (status, headers, message.to_string())
}

/// 简单的 UUID v4 生成（避免引入 uuid crate）
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seed = now.as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (seed & 0xFFFFFFFF) as u32,
        ((seed >> 32) & 0xFFFF) as u16,
        ((seed >> 48) & 0x0FFF) as u16,
        (((seed >> 60) & 0x3F) | 0x80) as u16 * 256 + ((seed >> 66) & 0xFF) as u16,
        (seed.wrapping_mul(6364136223846793005).wrapping_add(1) & 0xFFFFFFFFFFFF) as u64,
    )
}
