#!/usr/bin/env python3
from __future__ import annotations
import html, mimetypes, os, posixpath, secrets, hashlib
from pathlib import Path
from urllib.parse import quote, unquote
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
ROOT = Path(os.environ.get("IMAGE_BROWSER_ROOT", "/home/gpt2api/chatgpt2api/data/images")).resolve()
BASE_PATH = os.environ.get("IMAGE_BROWSER_BASE_PATH", "/_image-browser").rstrip("/") or ""
PASSWORD_HASH = os.environ.get("IMAGE_BROWSER_PASSWORD_HASH", "")
SESSION_SECRET = os.environ.get("IMAGE_BROWSER_SESSION_SECRET", "")
COOKIE_NAME = "gpt2api_img_browser"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
app = FastAPI(title="gpt2api image browser")
def _verify_password(password: str) -> bool:
    try:
        salt_hex, digest = PASSWORD_HASH.split(":", 1)
        got = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 200000).hex()
        return secrets.compare_digest(got, digest)
    except Exception:
        return False
def _token() -> str:
    return hashlib.sha256((SESSION_SECRET + ":image-browser").encode()).hexdigest()
def _authed(request: Request) -> bool:
    return bool(SESSION_SECRET) and secrets.compare_digest(request.cookies.get(COOKIE_NAME, ""), _token())
def _url(path: str = "") -> str:
    path = path.strip("/")
    return f"{BASE_PATH}/{quote(path)}" if path else f"{BASE_PATH}/"
def _safe_path(rel: str) -> Path:
    rel = unquote(rel or "").strip("/")
    parts = [p for p in rel.split("/") if p]
    if any(p in {".", ".."} for p in parts):
        raise HTTPException(404, "not found")
    p = (ROOT / Path(*parts)).resolve() if parts else ROOT
    try:
        p.relative_to(ROOT)
    except ValueError as exc:
        raise HTTPException(404, "not found") from exc
    return p
def _layout(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>
body{{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}}a{{color:#93c5fd;text-decoration:none}}.wrap{{max-width:1200px;margin:0 auto;padding:18px}}.bar{{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}}.card{{background:#111827;border:1px solid #263244;border-radius:12px;padding:10px;overflow:hidden}}.thumb{{width:100%;height:180px;object-fit:cover;border-radius:8px;background:#020617}}.name{{font-size:12px;word-break:break-all;margin-top:8px;color:#cbd5e1}}.meta{{font-size:12px;color:#94a3b8}}.dirs{{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 18px}}.dir{{padding:8px 10px;background:#1e293b;border-radius:8px}}input{{padding:10px;border-radius:8px;border:1px solid #334155;background:#020617;color:#e5e7eb}}button{{padding:10px 12px;border-radius:8px;border:0;background:#2563eb;color:white}}.err{{color:#fca5a5}}</style></head><body><div class="wrap">{body}</div></body></html>''')
@app.get("/healthz")
def healthz(): return {"ok": True, "root": str(ROOT), "exists": ROOT.exists()}
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if _authed(request): return RedirectResponse(_url(""), status_code=302)
    return _layout("Login", '<h2>图片浏览鉴权</h2><form method="post"><input name="password" type="password" autofocus placeholder="Password"><button>进入</button></form>')
@app.post("/login")
async def do_login(request: Request):
    form = await request.form()
    if not _verify_password(str(form.get("password", ""))):
        return _layout("Login", '<h2>图片浏览鉴权</h2><p class="err">密码错误</p><form method="post"><input name="password" type="password" autofocus><button>进入</button></form>')
    resp = RedirectResponse(_url(""), status_code=302)
    resp.set_cookie(COOKIE_NAME, _token(), httponly=True, secure=True, samesite="lax", max_age=86400)
    return resp
@app.get("/logout")
def logout():
    resp = RedirectResponse(f"{BASE_PATH}/login", status_code=302); resp.delete_cookie(COOKIE_NAME); return resp
@app.get("/file/{rel:path}")
def file(request: Request, rel: str):
    if not _authed(request): return RedirectResponse(f"{BASE_PATH}/login", status_code=302)
    p = _safe_path(rel)
    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS: raise HTTPException(404, "not found")
    return FileResponse(p, media_type=mimetypes.guess_type(str(p))[0] or "application/octet-stream", filename=p.name)
@app.get("/{rel:path}", response_class=HTMLResponse)
def browse(request: Request, rel: str = ""):
    if not _authed(request): return RedirectResponse(f"{BASE_PATH}/login", status_code=302)
    p = _safe_path(rel)
    if not p.exists(): raise HTTPException(404, "not found")
    if p.is_file(): return RedirectResponse(f"{BASE_PATH}/file/{quote(rel.strip('/'))}", status_code=302)
    rel_clean = unquote(rel or "").strip("/")
    dirs, imgs = [], []
    for e in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        child_rel = posixpath.join(rel_clean, e.name) if rel_clean else e.name
        if e.is_dir():
            count = sum(1 for x in e.rglob("*") if x.is_file() and x.suffix.lower() in IMAGE_EXTS)
            dirs.append(f"<a class=\"dir\" href=\"{_url(child_rel)}\">📁 {html.escape(e.name)} <span class=\"meta\">({count})</span></a>")
        elif e.is_file() and e.suffix.lower() in IMAGE_EXTS:
            st = e.stat(); file_url = f"{BASE_PATH}/file/{quote(child_rel)}"
            imgs.append(f"<div class=\"card\"><a href=\"{file_url}\" target=\"_blank\"><img class=\"thumb\" loading=\"lazy\" src=\"{file_url}\"></a><div class=\"name\">{html.escape(e.name)}</div><div class=\"meta\">{st.st_size//1024} KB</div></div>")
    parent = posixpath.dirname(rel_clean) if rel_clean else ""
    breadcrumbs = f"<a href=\"{_url('')}\">root</a>" + (" / " + html.escape(rel_clean) if rel_clean else "")
    up = f"<a href=\"{_url(parent)}\">⬆ 上级</a>" if rel_clean else ""
    return _layout("图片浏览", f"<div class=\"bar\"><div><h2>gpt2api 图片浏览</h2><div class=\"meta\">{breadcrumbs}</div></div><div>{up} &nbsp; <a href=\"{BASE_PATH}/logout\">退出</a></div></div><div class=\"dirs\">{''.join(dirs) or '<span class=meta>无子文件夹</span>'}</div><div class=\"grid\">{''.join(imgs) or '<span class=meta>当前目录无图片</span>'}</div>")
