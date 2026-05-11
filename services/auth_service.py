from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Literal

from services.config import config
from services.storage.base import StorageBackend

AuthRole = Literal["admin", "user"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class AuthService:
    def __init__(self, storage: StorageBackend):
        self.storage = storage
        self._lock = Lock()
        self._items = self._load()
        self._last_used_flush_at: dict[str, datetime] = {}

    @staticmethod
    def _clean(value: object) -> str:
        return str(value or "").strip()

    @staticmethod
    def _default_name(role: object) -> str:
        return "管理员密钥" if str(role or "").strip().lower() == "admin" else "普通用户"

    @staticmethod
    def _default_permissions() -> dict[str, bool]:
        return {"chat": True, "image": True}

    @staticmethod
    def _default_limits() -> dict[str, object]:
        return {"expires_at": None, "max_tokens": None, "max_images": None}

    @staticmethod
    def _default_usage() -> dict[str, int]:
        return {"used_tokens": 0, "used_images": 0}

    def _normalize_optional_nonnegative_int(self, value: object) -> int | None:
        if value is None or value == "":
            return None
        try:
            return max(0, int(value))
        except Exception:
            return None

    def _normalize_expires_at(self, value: object) -> str | None:
        text = self._clean(value)
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()

    def _normalize_permissions(self, raw: object) -> dict[str, bool]:
        defaults = self._default_permissions()
        if not isinstance(raw, dict):
            return defaults
        return {
            "chat": bool(raw.get("chat", defaults["chat"])),
            "image": bool(raw.get("image", defaults["image"])),
        }

    def _normalize_limits(self, raw: object) -> dict[str, object]:
        defaults = self._default_limits()
        if not isinstance(raw, dict):
            return defaults
        return {
            "expires_at": self._normalize_expires_at(raw.get("expires_at")),
            "max_tokens": self._normalize_optional_nonnegative_int(raw.get("max_tokens")),
            "max_images": self._normalize_optional_nonnegative_int(raw.get("max_images")),
        }

    def _normalize_usage(self, raw: object) -> dict[str, int]:
        defaults = self._default_usage()
        if not isinstance(raw, dict):
            return defaults
        used_tokens = self._normalize_optional_nonnegative_int(raw.get("used_tokens"))
        used_images = self._normalize_optional_nonnegative_int(raw.get("used_images"))
        return {
            "used_tokens": defaults["used_tokens"] if used_tokens is None else used_tokens,
            "used_images": defaults["used_images"] if used_images is None else used_images,
        }

    def _normalize_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        role = self._clean(raw.get("role")).lower()
        if role not in {"admin", "user"}:
            return None
        key_hash = self._clean(raw.get("key_hash"))
        if not key_hash:
            return None
        item_id = self._clean(raw.get("id")) or uuid.uuid4().hex[:12]
        name = self._clean(raw.get("name")) or self._default_name(role)
        created_at = self._clean(raw.get("created_at")) or _now_iso()
        last_used_at = self._clean(raw.get("last_used_at")) or None
        return {
            "id": item_id,
            "name": name,
            "role": role,
            "key_hash": key_hash,
            "enabled": bool(raw.get("enabled", True)),
            "created_at": created_at,
            "last_used_at": last_used_at,
            "permissions": self._normalize_permissions(raw.get("permissions")),
            "limits": self._normalize_limits(raw.get("limits")),
            "usage": self._normalize_usage(raw.get("usage")),
        }

    def _load(self) -> list[dict[str, object]]:
        try:
            items = self.storage.load_auth_keys()
        except Exception:
            return []
        if not isinstance(items, list):
            return []
        return [normalized for item in items if (normalized := self._normalize_item(item)) is not None]

    def _save(self) -> None:
        self.storage.save_auth_keys(self._items)

    def _reload_locked(self) -> None:
        self._items = self._load()

    @staticmethod
    def _public_item(item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item.get("id"),
            "name": item.get("name"),
            "role": item.get("role"),
            "enabled": bool(item.get("enabled", True)),
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
            "permissions": dict(item.get("permissions") or {}),
            "limits": dict(item.get("limits") or {}),
            "usage": dict(item.get("usage") or {}),
        }

    def list_keys(self, role: AuthRole | None = None) -> list[dict[str, object]]:
        with self._lock:
            self._reload_locked()
            items = [item for item in self._items if role is None or item.get("role") == role]
            return [self._public_item(item) for item in items]

    def _has_key_hash_locked(self, key_hash: str, *, exclude_id: str = "") -> bool:
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            stored_hash = self._clean(item.get("key_hash"))
            if stored_hash and hmac.compare_digest(stored_hash, key_hash):
                return True
        return False

    def _build_key_hash_locked(self, raw_key: str, *, exclude_id: str = "") -> str:
        candidate = self._clean(raw_key)
        if not candidate:
            raise ValueError("请输入新的专用密钥")
        admin_key = self._clean(config.auth_key)
        if admin_key and hmac.compare_digest(candidate, admin_key):
            raise ValueError("这个密钥和管理员密钥冲突了，请换一个新的密钥")
        key_hash = _hash_key(candidate)
        if self._has_key_hash_locked(key_hash, exclude_id=exclude_id):
            raise ValueError("这个专用密钥已经存在，请换一个新的密钥")
        return key_hash

    def _has_name_locked(self, name: str, *, role: AuthRole | None = None, exclude_id: str = "") -> bool:
        candidate = self._clean(name)
        if not candidate:
            return False
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            if role is not None and item.get("role") != role:
                continue
            if self._clean(item.get("name")) == candidate:
                return True
        return False

    def _build_default_name_locked(self, role: AuthRole, *, exclude_id: str = "") -> str:
        base_name = self._default_name(role)
        if not self._has_name_locked(base_name, role=role, exclude_id=exclude_id):
            return base_name
        suffix = 2
        while True:
            candidate = f"{base_name} {suffix}"
            if not self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
                return candidate
            suffix += 1

    def _build_name_locked(self, name: str, *, role: AuthRole, exclude_id: str = "") -> str:
        candidate = self._clean(name)
        if not candidate:
            return self._build_default_name_locked(role, exclude_id=exclude_id)
        if self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
            raise ValueError("这个名称已经在使用中了，换一个更容易区分的名称吧")
        return candidate

    def create_key(
        self,
        *,
        role: AuthRole,
        name: str = "",
        permissions: dict[str, object] | None = None,
        limits: dict[str, object] | None = None,
    ) -> tuple[dict[str, object], str]:
        with self._lock:
            self._reload_locked()
            normalized_name = self._build_name_locked(name, role=role)
            while True:
                raw_key = f"sk-{secrets.token_urlsafe(24)}"
                try:
                    key_hash = self._build_key_hash_locked(raw_key)
                    break
                except ValueError:
                    continue
            item = {
                "id": uuid.uuid4().hex[:12],
                "name": normalized_name,
                "role": role,
                "key_hash": key_hash,
                "enabled": True,
                "created_at": _now_iso(),
                "last_used_at": None,
                "permissions": self._normalize_permissions(permissions),
                "limits": self._normalize_limits(limits),
                "usage": self._default_usage(),
            }
            self._items.append(item)
            self._save()
            return self._public_item(item), raw_key

    def update_key(
        self,
        key_id: str,
        updates: dict[str, object],
        *,
        role: AuthRole | None = None,
    ) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                if role is not None and item.get("role") != role:
                    return None
                next_item = dict(item)
                next_role = "admin" if str(next_item.get("role") or "").strip().lower() == "admin" else "user"
                if "name" in updates and updates.get("name") is not None:
                    next_item["name"] = self._build_name_locked(
                        str(updates.get("name") or ""),
                        role=next_role,
                        exclude_id=normalized_id,
                    )
                if "enabled" in updates and updates.get("enabled") is not None:
                    next_item["enabled"] = bool(updates.get("enabled"))
                if "key" in updates and updates.get("key") is not None:
                    next_item["key_hash"] = self._build_key_hash_locked(str(updates.get("key") or ""), exclude_id=normalized_id)
                if "permissions" in updates and updates.get("permissions") is not None:
                    next_item["permissions"] = self._normalize_permissions(updates.get("permissions"))
                if "limits" in updates and updates.get("limits") is not None:
                    next_item["limits"] = self._normalize_limits(updates.get("limits"))
                if "usage" in updates and updates.get("usage") is not None:
                    next_item["usage"] = self._normalize_usage(updates.get("usage"))
                normalized = self._normalize_item(next_item)
                if normalized is None:
                    return None
                self._items[index] = normalized
                self._save()
                return self._public_item(normalized)
        return None

    def delete_key(self, key_id: str, *, role: AuthRole | None = None) -> bool:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return False
        with self._lock:
            self._reload_locked()
            before = len(self._items)
            self._items = [
                item
                for item in self._items
                if not (item.get("id") == normalized_id and (role is None or item.get("role") == role))
            ]
            if len(self._items) == before:
                return False
            self._save()
            return True

    def authenticate(self, raw_key: str) -> dict[str, object] | None:
        candidate = self._clean(raw_key)
        if not candidate:
            return None
        candidate_hash = _hash_key(candidate)
        with self._lock:
            for index, item in enumerate(self._items):
                if not bool(item.get("enabled", True)):
                    continue
                stored_hash = self._clean(item.get("key_hash"))
                if not stored_hash or not hmac.compare_digest(stored_hash, candidate_hash):
                    continue
                next_item = dict(item)
                now = datetime.now(timezone.utc)
                next_item["last_used_at"] = now.isoformat()
                normalized = self._normalize_item(next_item)
                if normalized is None:
                    continue
                self._items[index] = normalized
                item_id = self._clean(normalized.get("id"))
                last_flush_at = self._last_used_flush_at.get(item_id)
                if last_flush_at is None or (now - last_flush_at).total_seconds() >= 60:
                    try:
                        self._save()
                        self._last_used_flush_at[item_id] = now
                    except Exception:
                        pass
                return self._public_item(normalized)
        return None

    def _update_usage_locked(self, key_id: str, *, used_tokens: int = 0, used_images: int = 0, role: AuthRole | None = None) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        for index, item in enumerate(self._items):
            if item.get("id") != normalized_id:
                continue
            if role is not None and item.get("role") != role:
                return None
            next_item = dict(item)
            current_usage = self._normalize_usage(next_item.get("usage"))
            next_item["usage"] = {
                "used_tokens": current_usage["used_tokens"] + max(0, int(used_tokens or 0)),
                "used_images": current_usage["used_images"] + max(0, int(used_images or 0)),
            }
            normalized = self._normalize_item(next_item)
            if normalized is None:
                return None
            self._items[index] = normalized
            self._save()
            return self._public_item(normalized)
        return None

    def consume_tokens(self, key_id: str, tokens: int, *, role: AuthRole | None = None) -> dict[str, object] | None:
        with self._lock:
            self._reload_locked()
            return self._update_usage_locked(key_id, used_tokens=tokens, role=role)

    def consume_images(self, key_id: str, images: int, *, role: AuthRole | None = None) -> dict[str, object] | None:
        with self._lock:
            self._reload_locked()
            return self._update_usage_locked(key_id, used_images=images, role=role)


auth_service = AuthService(config.get_storage_backend())
