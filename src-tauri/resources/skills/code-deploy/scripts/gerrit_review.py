#!/usr/bin/env python3
"""Gerrit Outgoing Reviews: 列出 & Code-Review +2.

独立版本，不依赖 internal-wiki-fetch，配置和状态文件均存放在
~/.pipeline-commander/skills/code-deploy/ 下。
"""

import json, os, sys, time, shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

GERRIT_BASE = "https://gerrit.ingageapp.com"

# ── paths ────────────────────────────────────────────────────────────

def _skill_root() -> Path:
    return Path(__file__).resolve().parent.parent

def _sso_config_path() -> Path:
    return _skill_root() / "config" / "sso_config.json"

def _state_path() -> Path:
    return _skill_root() / "config" / "storage_state.json"

# ── helpers ──────────────────────────────────────────────────────────

def _eprint(*a: object) -> None:
    print(*a, file=sys.stderr, flush=True)

def _read_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text("utf-8")) if p.exists() else {}

# ── playwright / login ───────────────────────────────────────────────

def _ensure_playwright():
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except ImportError:
        _eprint("playwright 未安装，请运行: pip install playwright && playwright install chromium")
        sys.exit(1)

def _looks_like_login(url: str, cfg: Dict[str, Any]) -> bool:
    markers = ["login.xiaoshouyi.com", "/login", "/auc/oauth2"]
    contains = cfg.get("login_url_contains", "")
    if contains:
        markers.append(contains)
    return any(m in url for m in markers)

def _safe_text(s: str) -> str:
    return s.strip().replace("\u200b", "").replace("\u00a0", " ")

def _fill_like_human(loc: Any, value: str) -> None:
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

def _login(page: Any, cfg: Dict[str, Any]) -> None:
    username = _safe_text(str(cfg.get("username", "")))
    password = str(cfg.get("password", ""))
    if not username or not password:
        raise RuntimeError("sso_config.json 中缺少 username/password")

    try:
        page.wait_for_selector(
            "input[type='password'], input[data-ta-key='password_input']",
            timeout=15000,
        )
    except Exception:
        pass

    try:
        tab = page.get_by_text("密码登录", exact=False)
        if tab.count():
            tab.first.click(timeout=2000)
            page.wait_for_timeout(500)
    except Exception:
        pass

    user_sel = cfg.get("username_selector") or "input[data-ta-key='email_input'], input[name='username'], input[type='email'], input[type='text']"
    pass_sel = cfg.get("password_selector") or "input[data-ta-key='password_input'], input[type='password']"

    _fill_like_human(page.locator(user_sel).first, username)
    _fill_like_human(page.locator(pass_sel).first, password)

    submit_sel = cfg.get("submit_selector")
    if submit_sel:
        page.locator(submit_sel).first.click()
    elif page.locator("button[data-ta-key='login_btn']").count():
        page.locator("button[data-ta-key='login_btn']").first.click()
    else:
        page.locator("button[type='submit']").first.click()

    try:
        page.wait_for_load_state("networkidle", timeout=int(cfg.get("post_submit_timeout_ms", 30000)))
    except Exception:
        pass

    company = _safe_text(str(cfg.get("company", "")))
    if company:
        try:
            page.get_by_text(company, exact=False).first.click(timeout=5000)
            page.wait_for_load_state("networkidle", timeout=int(cfg.get("post_company_timeout_ms", 30000)))
        except Exception:
            pass

def _strip_gerrit_prefix(text: str) -> Any:
    """Gerrit REST API 返回的 JSON 前面有 )]}' 前缀。"""
    if text.startswith(")]}'"):
        text = text[4:].lstrip()
    return json.loads(text)

# ── 浏览器内执行 Gerrit API ──────────────────────────────────────────

def _gerrit_api_via_browser(page: Any, method: str, path: str, body: Optional[dict] = None) -> Any:
    js_body = json.dumps(body) if body else "null"
    js = f"""
    async () => {{
        const cookies = document.cookie.split(';').map(c => c.trim());
        let xsrf = '';
        for (const c of cookies) {{
            if (c.startsWith('XSRF_TOKEN=')) {{
                xsrf = c.substring('XSRF_TOKEN='.length);
                break;
            }}
        }}

        const headers = {{
            'Content-Type': 'application/json; charset=UTF-8',
            'Accept': 'application/json',
        }};
        if (xsrf) headers['X-Gerrit-Auth'] = xsrf;

        const opts = {{
            method: '{method}',
            credentials: 'same-origin',
            headers: headers,
        }};
        const body = {js_body};
        if (body) opts.body = JSON.stringify(body);

        const resp = await fetch('/a{path}', opts);
        const text = await resp.text();
        return {{status: resp.status, text: text, xsrf: xsrf}};
    }}
    """
    result = page.evaluate(js)
    if result["status"] >= 400:
        raise RuntimeError(f"Gerrit API {result['status']}: {path} — {result['text'][:200]}")
    return _strip_gerrit_prefix(result["text"])

def _open_gerrit_session(cfg: Dict[str, Any]):
    sync_pw = _ensure_playwright()
    state = _state_path()

    pw = sync_pw().start()
    browser = pw.chromium.launch(headless=True)
    ctx_args: Dict[str, Any] = {}
    if state.exists():
        ctx_args["storage_state"] = str(state)
    context = browser.new_context(**ctx_args)
    page = context.new_page()

    page.goto(f"{GERRIT_BASE}/dashboard/self", wait_until="networkidle", timeout=30000)

    if _looks_like_login(page.url, cfg):
        _eprint("需要登录，正在执行 SSO 登录...")
        _login(page, cfg)
        page.goto(f"{GERRIT_BASE}/dashboard/self", wait_until="networkidle", timeout=30000)

    if _looks_like_login(page.url, cfg):
        browser.close()
        pw.stop()
        raise RuntimeError("登录后仍在登录页，请检查 config/sso_config.json 中的账号密码")

    # 保存 state
    state.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(state))

    return pw, browser, context, page

# ── commands ─────────────────────────────────────────────────────────

def cmd_list(cfg: Dict[str, Any]) -> None:
    pw, browser, context, page = _open_gerrit_session(cfg)
    try:
        changes = _gerrit_api_via_browser(
            page, "GET",
            "/changes/?q=owner:self+status:open&o=CURRENT_REVISION&o=LABELS"
        )
        out = []
        for c in changes:
            out.append({
                "id": c.get("id", ""),
                "number": c.get("_number", ""),
                "project": c.get("project", ""),
                "branch": c.get("branch", ""),
                "subject": c.get("subject", ""),
                "url": f"{GERRIT_BASE}/c/{c.get('project', '')}/+/{c.get('_number', '')}",
                "status": c.get("status", ""),
            })
        print(json.dumps(out, ensure_ascii=False, indent=2))
    finally:
        browser.close()
        pw.stop()

def cmd_review(cfg: Dict[str, Any], change_ids: List[str]) -> None:
    pw, browser, context, page = _open_gerrit_session(cfg)
    results = []
    try:
        for cid in change_ids:
            try:
                _gerrit_api_via_browser(
                    page, "POST",
                    f"/changes/{cid}/revisions/current/review",
                    {"labels": {"Code-Review": 2}}
                )
                results.append({"change": cid, "status": "success"})
                _eprint(f"✅ Code-Review +2: {cid}")
            except Exception as e:
                results.append({"change": cid, "status": "error", "message": str(e)})
                _eprint(f"❌ 失败: {cid} — {e}")
    finally:
        browser.close()
        pw.stop()
    print(json.dumps(results, ensure_ascii=False, indent=2))

def main() -> None:
    cfg = _read_json(_sso_config_path())
    args = sys.argv[1:]

    if not args or args[0] == "--list":
        cmd_list(cfg)
    elif args[0] == "--review" and len(args) > 1:
        cmd_review(cfg, args[1:])
    else:
        _eprint("用法:")
        _eprint("  gerrit_review.py --list                    列出 outgoing reviews")
        _eprint("  gerrit_review.py --review <id1> <id2> ...  Code-Review +2")
        sys.exit(1)

if __name__ == "__main__":
    main()
