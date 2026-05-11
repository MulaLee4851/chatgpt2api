from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Thread

from fastapi import HTTPException, Request

from services.account_service import account_service
from services.auth_service import auth_service
from services.config import config

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def _legacy_admin_identity(token: str) -> dict[str, object] | None:
    auth_key = str(config.auth_key or "").strip()
    if auth_key and token == auth_key:
        return {
            "id": "admin",
            "name": "管理员",
            "role": "admin",
            "permissions": {"chat": True, "image": True},
            "limits": {"expires_at": None, "max_tokens": None, "max_images": None},
            "usage": {"used_tokens": 0, "used_images": 0},
        }
    return None


def require_identity(authorization: str | None) -> dict[str, object]:
    token = extract_bearer_token(authorization)
    identity = _legacy_admin_identity(token) or auth_service.authenticate(token)
    if identity is None:
        raise HTTPException(status_code=401, detail={"error": "密钥无效或已失效，请重新登录"})
    return identity


def require_auth_key(authorization: str | None) -> None:
    require_identity(authorization)


def require_admin(authorization: str | None) -> dict[str, object]:
    identity = require_identity(authorization)
    if identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"error": "需要管理员权限才能执行这个操作"})
    return identity


def resolve_image_base_url(request: Request) -> str:
    return config.base_url or f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"


def raise_image_quota_error(exc: Exception) -> None:
    message = str(exc)
    if "no available image quota" in message.lower():
        raise HTTPException(status_code=429, detail={"error": "no available image quota"}) from exc
    raise HTTPException(status_code=502, detail={"error": message}) from exc


def _identity_permissions(identity: dict[str, object]) -> dict[str, bool]:
    permissions = identity.get("permissions")
    if not isinstance(permissions, dict):
        return {"chat": True, "image": True}
    return {
        "chat": bool(permissions.get("chat", True)),
        "image": bool(permissions.get("image", True)),
    }


def _identity_limits(identity: dict[str, object]) -> dict[str, object]:
    limits = identity.get("limits")
    if not isinstance(limits, dict):
        return {"expires_at": None, "max_tokens": None, "max_images": None}
    return {
        "expires_at": limits.get("expires_at"),
        "max_tokens": limits.get("max_tokens"),
        "max_images": limits.get("max_images"),
    }


def _identity_usage(identity: dict[str, object]) -> dict[str, int]:
    usage = identity.get("usage")
    if not isinstance(usage, dict):
        return {"used_tokens": 0, "used_images": 0}
    try:
        used_tokens = max(0, int(usage.get("used_tokens") or 0))
    except Exception:
        used_tokens = 0
    try:
        used_images = max(0, int(usage.get("used_images") or 0))
    except Exception:
        used_images = 0
    return {"used_tokens": used_tokens, "used_images": used_images}


def _parse_iso_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _ensure_identity_not_expired(identity: dict[str, object]) -> None:
    if identity.get("role") == "admin":
        return
    expires_at = _parse_iso_datetime(_identity_limits(identity).get("expires_at"))
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=403, detail={"error": "当前密钥已过期"})


def ensure_identity_can_use_chat(identity: dict[str, object]) -> None:
    if identity.get("role") == "admin":
        return
    _ensure_identity_not_expired(identity)
    permissions = _identity_permissions(identity)
    if not permissions["chat"]:
        raise HTTPException(status_code=403, detail={"error": "当前密钥没有对话权限"})
    limits = _identity_limits(identity)
    usage = _identity_usage(identity)
    max_tokens = limits.get("max_tokens")
    if max_tokens is not None and usage["used_tokens"] >= int(max_tokens):
        raise HTTPException(status_code=403, detail={"error": "当前密钥的 tokens 已用完"})


def ensure_identity_can_use_image(identity: dict[str, object], image_count: int = 1) -> None:
    if identity.get("role") == "admin":
        return
    _ensure_identity_not_expired(identity)
    permissions = _identity_permissions(identity)
    if not permissions["image"]:
        raise HTTPException(status_code=403, detail={"error": "当前密钥没有生图权限"})
    limits = _identity_limits(identity)
    usage = _identity_usage(identity)
    max_images = limits.get("max_images")
    normalized_count = max(0, int(image_count or 0))
    if max_images is not None and usage["used_images"] + normalized_count > int(max_images):
        raise HTTPException(status_code=403, detail={"error": "当前密钥的图片额度已用完"})


def consume_identity_tokens(identity: dict[str, object], total_tokens: int) -> dict[str, object]:
    if identity.get("role") == "admin":
        return identity
    key_id = str(identity.get("id") or "").strip()
    amount = max(0, int(total_tokens or 0))
    if not key_id or amount <= 0:
        return identity
    updated = auth_service.consume_tokens(key_id, amount, role="user")
    if updated is not None:
        identity.update(updated)
    return identity


def consume_identity_images(identity: dict[str, object], image_count: int) -> dict[str, object]:
    if identity.get("role") == "admin":
        return identity
    key_id = str(identity.get("id") or "").strip()
    amount = max(0, int(image_count or 0))
    if not key_id or amount <= 0:
        return identity
    updated = auth_service.consume_images(key_id, amount, role="user")
    if updated is not None:
        identity.update(updated)
    return identity


def sanitize_cpa_pool(pool: dict | None) -> dict | None:
    if not isinstance(pool, dict):
        return None
    return {key: value for key, value in pool.items() if key != "secret_key"}


def sanitize_cpa_pools(pools: list[dict]) -> list[dict]:
    return [sanitized for pool in pools if (sanitized := sanitize_cpa_pool(pool)) is not None]


def sanitize_sub2api_server(server: dict | None) -> dict | None:
    if not isinstance(server, dict):
        return None
    sanitized = {key: value for key, value in server.items() if key not in {"password", "api_key"}}
    sanitized["has_api_key"] = bool(str(server.get("api_key") or "").strip())
    return sanitized


def sanitize_sub2api_servers(servers: list[dict]) -> list[dict]:
    return [sanitized for server in servers if (sanitized := sanitize_sub2api_server(server)) is not None]


def start_limited_account_watcher(stop_event: Event) -> Thread:
    interval_seconds = config.refresh_account_interval_minute * 60

    def worker() -> None:
        while not stop_event.is_set():
            try:
                limited_tokens = account_service.list_limited_tokens()
                if limited_tokens:
                    print(f"[account-limited-watcher] checking {len(limited_tokens)} limited accounts")
                    account_service.refresh_accounts(limited_tokens)
            except Exception as exc:
                print(f"[account-limited-watcher] fail {exc}")
            stop_event.wait(interval_seconds)

    thread = Thread(target=worker, name="limited-account-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None
    clean_path = requested_path.strip("/")
    base_dir = WEB_DIST_DIR.resolve()
    candidates = [base_dir / "index.html"] if not clean_path else [
        base_dir / Path(clean_path),
        base_dir / clean_path / "index.html",
        base_dir / f"{clean_path}.html",
    ]
    for candidate in candidates:
        try:
            candidate.resolve().relative_to(base_dir)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None
