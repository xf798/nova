#!/usr/bin/env python3
"""方舟(Arca) 发布中心 —— 后端服务发布脚本。

通过 arca-devops.ingageapp.com 的 release_self/publish_services API 触发后端服务部署。
认证复用 SSO (xiaoshouyi OAuth2) → arca_oauth_token cookie。

用法:
  # 发布单个服务到 crm-cd (develop 分支)
  arca_release.py --env crm-cd --branch develop --service neo-apps-salescloud-ai-service

  # 发布多个服务
  arca_release.py --env crm-cd --branch develop \
    --service neo-apps-salescloud-ai-service \
    --service neo-apps-ai-agent-service

  # 查看发布历史
  arca_release.py --history --service neo-apps-salescloud-ai-service --limit 5

  # 仅登录/刷新 token（不发布）
  arca_release.py --login
"""
import argparse, json, sys, time
from pathlib import Path
from urllib.parse import urlencode

ARCA_BASE = "https://arca-devops.ingageapp.com"
PUBLISH_URL = f"{ARCA_BASE}/rm_api/v1/release_self/publish_services/"
HISTORY_URL = f"{ARCA_BASE}/rm_api/v1/release_history/"
CONFIG_URL = f"{ARCA_BASE}/rm_api/v1/release_config/"
RELEASE_PAGE = f"{ARCA_BASE}/opsCenter/releaseCenter/releaseManager/"

SKILL_ROOT = Path(__file__).resolve().parent.parent
SSO_CFG = SKILL_ROOT / "config" / "sso_config.json"
ARCA_STATE = SKILL_ROOT / "config" / "arca_storage_state.json"
GERRIT_STATE = SKILL_ROOT / "config" / "storage_state.json"


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def read_json(p):
    return json.loads(Path(p).read_text("utf-8")) if Path(p).exists() else {}


# ── SSO 登录 ────────────────────────────────────────────────────────

def fill_like_human(loc, value):
    try:
        loc.click(timeout=1500)
    except Exception:
        pass
    try:
        loc.fill(value)
    except Exception:
        try:
            loc.type(value, delay=15)
        except Exception:
            pass


def xsy_login(page, cfg):
    try:
        page.wait_for_selector("input[type='password'], input[data-ta-key='password_input']", timeout=15000)
    except Exception:
        pass
    try:
        tab = page.get_by_text("密码登录", exact=False)
        if tab.count():
            tab.first.click(timeout=2000)
            page.wait_for_timeout(500)
    except Exception:
        pass
    user_sel = cfg.get("username_selector") or "input[type='email'], input[type='text']"
    pass_sel = cfg.get("password_selector") or "input[type='password']"
    fill_like_human(page.locator(user_sel).first, str(cfg.get("username", "")).strip())
    fill_like_human(page.locator(pass_sel).first, str(cfg.get("password", "")))
    submit_sel = cfg.get("submit_selector")
    if submit_sel and page.locator(submit_sel).count():
        page.locator(submit_sel).first.click()
    elif page.locator("button[data-ta-key='login_btn']").count():
        page.locator("button[data-ta-key='login_btn']").first.click()
    else:
        page.locator("button[type='submit']").first.click()
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    company = str(cfg.get("company", "")).strip()
    if company:
        try:
            page.get_by_text(company, exact=False).first.click(timeout=5000)
            page.wait_for_load_state("networkidle", timeout=30000)
        except Exception:
            pass


def ensure_arca_session(pw_module):
    """确保有效的 arca session，返回 (playwright, browser, context, page)。"""
    cfg = read_json(SSO_CFG)
    pw = pw_module.start()
    browser = pw.chromium.launch(headless=True)
    ctx_args = {}
    if ARCA_STATE.exists():
        ctx_args["storage_state"] = str(ARCA_STATE)
    elif GERRIT_STATE.exists():
        ctx_args["storage_state"] = str(GERRIT_STATE)
    context = browser.new_context(**ctx_args)
    page = context.new_page()
    page.goto(RELEASE_PAGE, wait_until="networkidle", timeout=45000)
    eprint(f"[arca] 到达: {page.url}")

    if "/user/login" in page.url:
        eprint("[arca] 需要登录...")
        try:
            page.locator("span.icon___rzGKO").first.click(timeout=8000)
        except Exception:
            pass
        page.wait_for_timeout(2000)
        if "login.xiaoshouyi.com" in page.url:
            eprint("[arca] SSO 登录中...")
            xsy_login(page, cfg)
        try:
            page.wait_for_url(lambda u: "arca-devops" in u and "/user/login" not in u, timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2000)
        page.goto(RELEASE_PAGE, wait_until="networkidle", timeout=45000)

    if "/user/login" in page.url:
        raise RuntimeError("SSO 登录失败，请检查 sso_config.json")

    ARCA_STATE.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(ARCA_STATE))
    eprint("[arca] ✓ 会话有效")
    return pw, browser, context, page


def api_call(page, method, url, body=None):
    """通过浏览器 same-origin fetch 调用 arca API（自动带 cookie 认证）。"""
    js = """
    async ([method, url, body]) => {
        const headers = {
            'Accept': 'application/json',
            'Authorization': 'JWT'
        };
        const opts = {method, credentials:'same-origin', headers};
        if (body) {
            headers['Content-Type'] = 'application/json;charset=UTF-8';
            opts.body = body;
        }
        const resp = await fetch(url, opts);
        const text = await resp.text();
        return {status: resp.status, text: text};
    }
    """
    result = page.evaluate(js, [method, url, body])
    return result["status"], result["text"]


# ── 命令 ─────────────────────────────────────────────────────────────

def cmd_publish(page, env_list, service_list, branch):
    payload = {
        "env_list": env_list,
        "service_list": service_list,
        "param": {"BRANCH": branch}
    }
    eprint(f"[arca] 发布请求: {json.dumps(payload, ensure_ascii=False)}")
    status, text = api_call(page, "POST", PUBLISH_URL, json.dumps(payload))
    try:
        data = json.loads(text)
    except Exception:
        data = {"raw": text}
    return {"http_status": status, "response": data}


def cmd_history(page, service=None, limit=10):
    params = {"page": 1, "page_size": limit}
    if service:
        params["service_name"] = service
    url = HISTORY_URL + "?" + urlencode(params)
    status, text = api_call(page, "GET", url)
    try:
        data = json.loads(text)
    except Exception:
        data = {"raw": text}
    return data


def cmd_config(page):
    status, text = api_call(page, "GET", CONFIG_URL)
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}


def main():
    parser = argparse.ArgumentParser(description="方舟发布中心 CLI")
    parser.add_argument("--login", action="store_true", help="仅登录，不执行操作")
    parser.add_argument("--history", action="store_true", help="查看发布历史")
    parser.add_argument("--config", action="store_true", help="查看发布配置")
    parser.add_argument("--env", action="append", default=[], help="目标环境(可多次指定)")
    parser.add_argument("--service", action="append", default=[], help="服务名(可多次指定)")
    parser.add_argument("--branch", default="develop", help="分支名(默认 develop)")
    parser.add_argument("--limit", type=int, default=10, help="历史条数(默认10)")
    args = parser.parse_args()

    from playwright.sync_api import sync_playwright
    pw, browser, context, page = ensure_arca_session(sync_playwright())

    try:
        if args.login:
            print(json.dumps({"status": "ok", "message": "登录成功"}, ensure_ascii=False, indent=2))
        elif args.config:
            result = cmd_config(page)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.history:
            result = cmd_history(page, service=args.service[0] if args.service else None, limit=args.limit)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.service:
            if not args.env:
                args.env = ["crm-cd"]
                eprint("[arca] 未指定环境，默认使用 crm-cd")
            result = cmd_publish(page, args.env, args.service, args.branch)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            parser.print_help()
    finally:
        browser.close()
        pw.stop()


if __name__ == "__main__":
    main()
