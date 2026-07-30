use serde::{Deserialize, Serialize};

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub tchub_token: String,
    pub polling_interval_secs: u64,
    pub workspace_path: String,
    pub pm_team_path: String,
    pub ux_team_path: String,
    pub dev_team_path: String,
    pub notify_wecom: bool,
    pub pipeline_mode: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            tchub_token: String::new(),
            polling_interval_secs: 600,
            workspace_path: String::from("/Users/wangxf/workspace"),
            pm_team_path: String::from("/Users/wangxf/workspace/ai-pm-team"),
            ux_team_path: String::from("/Users/wangxf/workspace/ai-ux-team"),
            dev_team_path: String::from("/Users/wangxf/workspace/ai-develop-team"),
            notify_wecom: true,
            pipeline_mode: String::from("light"),
        }
    }
}
