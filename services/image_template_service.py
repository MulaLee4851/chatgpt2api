from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Optional
from uuid import uuid4

from fastapi import HTTPException

from services.config import config

TEMPLATES_FILE = config.image_templates_dir / "templates.json"
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _to_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _to_optional_int(value: object) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _asset_root() -> Path:
    path = config.image_templates_dir / "assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_items() -> list[dict[str, object]]:
    if not TEMPLATES_FILE.exists():
        return []
    try:
        data = json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _save_items(items: list[dict[str, object]]) -> None:
    TEMPLATES_FILE.parent.mkdir(parents=True, exist_ok=True)
    TEMPLATES_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _normalize_asset_rel(template_id: str, value: object) -> Optional[str]:
    rel = _clean_text(value).replace("\\", "/").lstrip("/")
    if not rel:
        return None
    path = Path(rel)
    if path.parts[:1] != (template_id,):
        return None
    if any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path.as_posix()


def _normalize_item(value: object) -> Optional[dict[str, object]]:
    if not isinstance(value, dict):
        return None
    template_id = _clean_text(value.get("id")) or uuid4().hex
    mode = _clean_text(value.get("mode")) or "generate"
    if mode not in {"generate", "edit"}:
        mode = "generate"
    placeholder_token = _clean_text(value.get("placeholder_token")) or "{{prompt}}"
    item = {
        "id": template_id,
        "name": _clean_text(value.get("name")),
        "description": _clean_text(value.get("description")),
        "mode": mode,
        "prompt_template": _clean_text(value.get("prompt_template")),
        "default_count": max(1, min(100, int(value.get("default_count") or 1))),
        "default_size": _clean_text(value.get("default_size")),
        "requires_placeholder": _to_bool(value.get("requires_placeholder"), False),
        "placeholder_token": placeholder_token,
        "requires_user_source_image": _to_bool(value.get("requires_user_source_image"), False),
        "reference_image_rel": _normalize_asset_rel(template_id, value.get("reference_image_rel")),
        "original_image_rel": _normalize_asset_rel(template_id, value.get("original_image_rel")),
        "enabled": _to_bool(value.get("enabled"), True),
        "created_at": _clean_text(value.get("created_at")) or _iso_now(),
        "updated_at": _clean_text(value.get("updated_at")) or _iso_now(),
    }
    if not item["name"]:
        return None
    return item


def _get_extension(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail={"error": "仅支持 png/jpg/jpeg/webp/gif 图片"})
    return suffix


def _safe_asset_file(template_id: str, rel_path: str) -> Path:
    root = _asset_root().resolve()
    path = (root / rel_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail={"error": "模板图片不存在"}) from exc
    if path.parts[-2] != template_id:
        raise HTTPException(status_code=404, detail={"error": "模板图片不存在"})
    return path


def _asset_url(base_url: str, rel_path: Optional[str]) -> Optional[str]:
    if not rel_path:
        return None
    return f"{base_url.rstrip('/')}/template-images/{rel_path}"


class ImageTemplateService:
    def list_items(self, *, include_disabled: bool = True) -> list[dict[str, object]]:
        items = [_normalize_item(item) for item in _load_items()]
        normalized = [item for item in items if item is not None]
        if not include_disabled:
            normalized = [item for item in normalized if item.get("enabled")]
        normalized.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return normalized

    def get_item(self, template_id: str) -> Optional[dict[str, object]]:
        template_id = _clean_text(template_id)
        for item in self.list_items(include_disabled=True):
            if item["id"] == template_id:
                return dict(item)
        return None

    def create_item(self, payload: dict[str, object]) -> dict[str, object]:
        now = _iso_now()
        item = _normalize_item({
            **dict(payload or {}),
            "id": uuid4().hex,
            "created_at": now,
            "updated_at": now,
        })
        if item is None:
            raise HTTPException(status_code=400, detail={"error": "模板名称不能为空"})
        items = self.list_items(include_disabled=True)
        if any(str(existing.get("name") or "") == item["name"] for existing in items):
            raise HTTPException(status_code=400, detail={"error": "模板名称已存在"})
        items.append(item)
        _save_items(items)
        return item

    def update_item(self, template_id: str, payload: dict[str, object]) -> Optional[dict[str, object]]:
        items = self.list_items(include_disabled=True)
        now = _iso_now()
        updated = None
        for index, item in enumerate(items):
            if item["id"] != template_id:
                continue
            next_item = _normalize_item({
                **item,
                **dict(payload or {}),
                "id": item["id"],
                "created_at": item["created_at"],
                "updated_at": now,
            })
            if next_item is None:
                raise HTTPException(status_code=400, detail={"error": "模板名称不能为空"})
            if any(str(existing.get("name") or "") == next_item["name"] and existing["id"] != template_id for existing in items):
                raise HTTPException(status_code=400, detail={"error": "模板名称已存在"})
            items[index] = next_item
            updated = next_item
            break
        if updated is None:
            return None
        _save_items(items)
        return updated

    def delete_item(self, template_id: str) -> bool:
        items = self.list_items(include_disabled=True)
        next_items = [item for item in items if item["id"] != template_id]
        if len(next_items) == len(items):
            return False
        _save_items(next_items)
        shutil.rmtree(_asset_root() / template_id, ignore_errors=True)
        return True

    def replace_asset(self, template_id: str, kind: str, filename: str, fileobj: BinaryIO) -> Optional[dict[str, object]]:
        if kind not in {"reference", "original"}:
            raise HTTPException(status_code=400, detail={"error": "未知模板图片类型"})
        item = self.get_item(template_id)
        if item is None:
            return None
        extension = _get_extension(filename)
        template_dir = _asset_root() / template_id
        template_dir.mkdir(parents=True, exist_ok=True)
        for stale in template_dir.glob(f"{kind}.*"):
            stale.unlink(missing_ok=True)
        rel_path = Path(template_id) / f"{kind}{extension}"
        target = _asset_root() / rel_path
        with target.open("wb") as output:
            shutil.copyfileobj(fileobj, output)
        field = "reference_image_rel" if kind == "reference" else "original_image_rel"
        return self.update_item(template_id, {field: rel_path.as_posix()})

    def delete_asset(self, template_id: str, kind: str) -> Optional[dict[str, object]]:
        if kind not in {"reference", "original"}:
            raise HTTPException(status_code=400, detail={"error": "未知模板图片类型"})
        item = self.get_item(template_id)
        if item is None:
            return None
        field = "reference_image_rel" if kind == "reference" else "original_image_rel"
        rel_path = item.get(field)
        if rel_path:
            _safe_asset_file(template_id, str(rel_path)).unlink(missing_ok=True)
        updated = self.update_item(template_id, {field: None})
        template_dir = _asset_root() / template_id
        if template_dir.is_dir() and not any(template_dir.iterdir()):
            template_dir.rmdir()
        return updated

    def serialize_item(self, item: dict[str, object], base_url: str) -> dict[str, object]:
        return {
            **item,
            "reference_image_url": _asset_url(base_url, item.get("reference_image_rel")),
            "original_image_url": _asset_url(base_url, item.get("original_image_rel")),
        }


image_template_service = ImageTemplateService()
