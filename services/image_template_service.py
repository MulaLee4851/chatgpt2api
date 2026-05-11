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
REFERENCE_TYPES = {"reference", "original"}
PLACEHOLDER_TYPES = {"text", "textarea", "number", "select"}
STATUS_VALUES = {"active", "draft", "archived"}


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


def _to_float(value: object, default: float = 1.0, minimum: float = 0.0, maximum: float = 2.0) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        normalized = default
    return max(minimum, min(maximum, normalized))


def _to_int(value: object, default: int = 0, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = default
    normalized = max(minimum, normalized)
    if maximum is not None:
        normalized = min(maximum, normalized)
    return normalized


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


def _normalize_tags(value: object) -> list[str]:
    if isinstance(value, str):
        raw_items = value.replace("，", ",").split(",")
    elif isinstance(value, list):
        raw_items = value
    else:
        raw_items = []
    tags: list[str] = []
    for item in raw_items:
        tag = _clean_text(item)
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _normalize_validation(value: object, placeholder_type: str) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    normalized: dict[str, object] = {}
    if placeholder_type == "select":
        options = source.get("options")
        if isinstance(options, str):
            option_values = [item.strip() for item in options.replace("，", ",").split(",") if item.strip()]
        elif isinstance(options, list):
            option_values = [item for item in (_clean_text(option) for option in options) if item]
        else:
            option_values = []
        if option_values:
            normalized["options"] = option_values
    if placeholder_type == "number":
        if source.get("min") not in (None, ""):
            normalized["min"] = _to_int(source.get("min"), minimum=0)
        if source.get("max") not in (None, ""):
            normalized["max"] = _to_int(source.get("max"), minimum=0)
    else:
        if source.get("min_length") not in (None, ""):
            normalized["min_length"] = _to_int(source.get("min_length"), minimum=0)
        if source.get("max_length") not in (None, ""):
            normalized["max_length"] = _to_int(source.get("max_length"), minimum=0)
    regex = _clean_text(source.get("regex"))
    if regex:
        normalized["regex"] = regex
    return normalized


def _normalize_placeholder(value: object, index: int) -> Optional[dict[str, object]]:
    if not isinstance(value, dict):
        return None
    key = _clean_text(value.get("key"))
    if not key:
        return None
    placeholder_type = _clean_text(value.get("type")) or "text"
    if placeholder_type not in PLACEHOLDER_TYPES:
        placeholder_type = "text"
    normalized = {
        "key": key,
        "label": _clean_text(value.get("label")) or key,
        "type": placeholder_type,
        "default_value": _clean_text(value.get("default_value")),
        "required": _to_bool(value.get("required"), False),
        "help": _clean_text(value.get("help")),
        "validation": _normalize_validation(value.get("validation"), placeholder_type),
        "order": _to_int(value.get("order"), default=index, minimum=0),
    }
    return normalized


def _normalize_placeholders(value: object, prompt_text: str, legacy_token: str, legacy_required: bool) -> list[dict[str, object]]:
    items = value if isinstance(value, list) else []
    normalized = [item for index, raw in enumerate(items) if (item := _normalize_placeholder(raw, index)) is not None]
    if normalized:
        seen: set[str] = set()
        unique: list[dict[str, object]] = []
        for item in sorted(normalized, key=lambda current: int(current.get("order") or 0)):
            key = str(item.get("key") or "")
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        return unique
    if legacy_required:
        token = legacy_token or "{{prompt}}"
        key = token.removeprefix("{{").removesuffix("}}").strip() or "prompt"
        return [{
            "key": key,
            "label": key,
            "type": "text",
            "default_value": "",
            "required": True,
            "help": "",
            "validation": {},
            "order": 0,
        }]
    return []


def _normalize_reference(value: object, template_id: str, index: int) -> Optional[dict[str, object]]:
    if not isinstance(value, dict):
        return None
    key = _clean_text(value.get("key"))
    if not key:
        return None
    reference_type = _clean_text(value.get("type")) or "reference"
    if reference_type not in REFERENCE_TYPES:
        reference_type = "reference"
    return {
        "key": key,
        "label": _clean_text(value.get("label")) or key,
        "type": reference_type,
        "required": _to_bool(value.get("required"), False),
        "weight": _to_float(value.get("weight"), default=1.0),
        "help": _clean_text(value.get("help")),
        "asset_rel": _normalize_asset_rel(template_id, value.get("asset_rel")),
        "order": _to_int(value.get("order"), default=index, minimum=0),
    }


def _normalize_references(value: object, template_id: str, legacy_reference_rel: object, legacy_original_rel: object, legacy_requires_user_source_image: bool) -> list[dict[str, object]]:
    items = value if isinstance(value, list) else []
    normalized = [item for index, raw in enumerate(items) if (item := _normalize_reference(raw, template_id, index)) is not None]
    if normalized:
        seen: set[str] = set()
        unique: list[dict[str, object]] = []
        for item in sorted(normalized, key=lambda current: int(current.get("order") or 0)):
            key = str(item.get("key") or "")
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        return unique
    references: list[dict[str, object]] = []
    reference_rel = _normalize_asset_rel(template_id, legacy_reference_rel)
    original_rel = _normalize_asset_rel(template_id, legacy_original_rel)
    if original_rel or legacy_requires_user_source_image:
        references.append({
            "key": "source-image",
            "label": "待处理原图",
            "type": "original",
            "required": legacy_requires_user_source_image,
            "weight": 1.0,
            "help": "",
            "asset_rel": original_rel,
            "order": 0,
        })
    if reference_rel:
        references.append({
            "key": "reference-image",
            "label": "参考图",
            "type": "reference",
            "required": False,
            "weight": 1.0,
            "help": "",
            "asset_rel": reference_rel,
            "order": len(references),
        })
    return references


def _normalize_item(value: object) -> Optional[dict[str, object]]:
    if not isinstance(value, dict):
        return None
    template_id = _clean_text(value.get("id")) or uuid4().hex
    mode = _clean_text(value.get("mode")) or "generate"
    if mode not in {"generate", "edit"}:
        mode = "generate"
    prompts_source = value.get("prompts") if isinstance(value.get("prompts"), dict) else {}
    positive_prompt = _clean_text(prompts_source.get("positive") if prompts_source else value.get("prompt_template"))
    negative_prompt = _clean_text(prompts_source.get("negative"))
    defaults_source = value.get("defaults") if isinstance(value.get("defaults"), dict) else {}
    status = _clean_text(value.get("status"))
    if not status:
        status = "active" if _to_bool(value.get("enabled"), True) else "archived"
    if status not in STATUS_VALUES:
        status = "draft"
    placeholder_token = _clean_text(value.get("placeholder_token")) or "{{prompt}}"
    requires_placeholder = _to_bool(value.get("requires_placeholder"), False)
    requires_user_source_image = _to_bool(value.get("requires_user_source_image"), False)
    item = {
        "id": template_id,
        "name": _clean_text(value.get("name")),
        "description": _clean_text(value.get("description")),
        "mode": mode,
        "prompts": {
            "positive": positive_prompt,
            "negative": negative_prompt,
        },
        "defaults": {
            "count": _to_int(defaults_source.get("count") if defaults_source else value.get("default_count"), default=1, minimum=1, maximum=100),
            "size": _clean_text(defaults_source.get("size") if defaults_source else value.get("default_size")),
        },
        "placeholders": _normalize_placeholders(value.get("placeholders"), positive_prompt, placeholder_token, requires_placeholder),
        "references": _normalize_references(
            value.get("references"),
            template_id,
            value.get("reference_image_rel"),
            value.get("original_image_rel"),
            requires_user_source_image,
        ),
        "cover_image_rel": _normalize_asset_rel(template_id, value.get("cover_image_rel")),
        "tags": _normalize_tags(value.get("tags")),
        "status": status,
        "version": _clean_text(value.get("version")) or "1.0.0",
        "created_by": _clean_text(value.get("created_by")) or None,
        "updated_by": _clean_text(value.get("updated_by")) or None,
        "created_at": _clean_text(value.get("created_at")) or _iso_now(),
        "updated_at": _clean_text(value.get("updated_at")) or _iso_now(),
    }
    if not item["name"] or not positive_prompt:
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
            normalized = [item for item in normalized if item.get("status") == "active"]
        normalized.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return normalized

    def get_item(self, template_id: str) -> Optional[dict[str, object]]:
        template_id = _clean_text(template_id)
        for item in self.list_items(include_disabled=True):
            if item["id"] == template_id:
                return dict(item)
        return None

    def _ensure_unique_name(self, items: list[dict[str, object]], name: str, *, exclude_id: str = "") -> None:
        if any(str(existing.get("name") or "") == name and existing["id"] != exclude_id for existing in items):
            raise HTTPException(status_code=400, detail={"error": "模板名称已存在"})

    def create_item(self, payload: dict[str, object], actor: str | None = None) -> dict[str, object]:
        now = _iso_now()
        items = self.list_items(include_disabled=True)
        item = _normalize_item({
            **dict(payload or {}),
            "id": uuid4().hex,
            "created_at": now,
            "updated_at": now,
            "created_by": _clean_text(actor) or None,
            "updated_by": _clean_text(actor) or None,
        })
        if item is None:
            raise HTTPException(status_code=400, detail={"error": "模板名称和正向提示词不能为空"})
        self._ensure_unique_name(items, str(item["name"]))
        items.append(item)
        _save_items(items)
        return item

    def update_item(self, template_id: str, payload: dict[str, object], actor: str | None = None) -> Optional[dict[str, object]]:
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
                "created_by": item.get("created_by"),
                "updated_at": now,
                "updated_by": _clean_text(actor) or item.get("updated_by"),
            })
            if next_item is None:
                raise HTTPException(status_code=400, detail={"error": "模板名称和正向提示词不能为空"})
            self._ensure_unique_name(items, str(next_item["name"]), exclude_id=template_id)
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

    def _replace_asset(self, template_id: str, relative_name: str, filename: str, fileobj: BinaryIO) -> str:
        extension = _get_extension(filename)
        template_dir = _asset_root() / template_id
        template_dir.mkdir(parents=True, exist_ok=True)
        for stale in template_dir.glob(f"{relative_name}.*"):
            stale.unlink(missing_ok=True)
        rel_path = Path(template_id) / f"{relative_name}{extension}"
        target = _asset_root() / rel_path
        with target.open("wb") as output:
            shutil.copyfileobj(fileobj, output)
        return rel_path.as_posix()

    def replace_cover_asset(self, template_id: str, filename: str, fileobj: BinaryIO, actor: str | None = None) -> Optional[dict[str, object]]:
        item = self.get_item(template_id)
        if item is None:
            return None
        rel_path = self._replace_asset(template_id, "cover", filename, fileobj)
        return self.update_item(template_id, {"cover_image_rel": rel_path}, actor=actor)

    def delete_cover_asset(self, template_id: str, actor: str | None = None) -> Optional[dict[str, object]]:
        item = self.get_item(template_id)
        if item is None:
            return None
        rel_path = item.get("cover_image_rel")
        if rel_path:
            _safe_asset_file(template_id, str(rel_path)).unlink(missing_ok=True)
        updated = self.update_item(template_id, {"cover_image_rel": None}, actor=actor)
        template_dir = _asset_root() / template_id
        if template_dir.is_dir() and not any(template_dir.iterdir()):
            template_dir.rmdir()
        return updated

    def replace_reference_asset(self, template_id: str, reference_key: str, filename: str, fileobj: BinaryIO, actor: str | None = None) -> Optional[dict[str, object]]:
        item = self.get_item(template_id)
        if item is None:
            return None
        references = list(item.get("references") or [])
        next_references: list[dict[str, object]] = []
        matched = False
        safe_key = _clean_text(reference_key)
        for reference in references:
            current = dict(reference)
            if str(current.get("key") or "") != safe_key:
                next_references.append(current)
                continue
            matched = True
            relative_name = f"reference-{safe_key}"
            current["asset_rel"] = self._replace_asset(template_id, relative_name, filename, fileobj)
            next_references.append(current)
        if not matched:
            raise HTTPException(status_code=404, detail={"error": "模板引用槽位不存在"})
        return self.update_item(template_id, {"references": next_references}, actor=actor)

    def delete_reference_asset(self, template_id: str, reference_key: str, actor: str | None = None) -> Optional[dict[str, object]]:
        item = self.get_item(template_id)
        if item is None:
            return None
        references = list(item.get("references") or [])
        next_references: list[dict[str, object]] = []
        matched = False
        safe_key = _clean_text(reference_key)
        for reference in references:
            current = dict(reference)
            if str(current.get("key") or "") != safe_key:
                next_references.append(current)
                continue
            matched = True
            rel_path = current.get("asset_rel")
            if rel_path:
                _safe_asset_file(template_id, str(rel_path)).unlink(missing_ok=True)
            current["asset_rel"] = None
            next_references.append(current)
        if not matched:
            raise HTTPException(status_code=404, detail={"error": "模板引用槽位不存在"})
        updated = self.update_item(template_id, {"references": next_references}, actor=actor)
        template_dir = _asset_root() / template_id
        if template_dir.is_dir() and not any(template_dir.iterdir()):
            template_dir.rmdir()
        return updated

    def replace_asset(self, template_id: str, kind: str, filename: str, fileobj: BinaryIO) -> Optional[dict[str, object]]:
        if kind == "cover":
            return self.replace_cover_asset(template_id, filename, fileobj)
        if kind == "reference":
            return self.replace_reference_asset(template_id, "reference-image", filename, fileobj)
        if kind == "original":
            return self.replace_reference_asset(template_id, "source-image", filename, fileobj)
        raise HTTPException(status_code=400, detail={"error": "未知模板图片类型"})

    def delete_asset(self, template_id: str, kind: str) -> Optional[dict[str, object]]:
        if kind == "cover":
            return self.delete_cover_asset(template_id)
        if kind == "reference":
            return self.delete_reference_asset(template_id, "reference-image")
        if kind == "original":
            return self.delete_reference_asset(template_id, "source-image")
        raise HTTPException(status_code=400, detail={"error": "未知模板图片类型"})

    def serialize_item(self, item: dict[str, object], base_url: str) -> dict[str, object]:
        prompts = dict(item.get("prompts") or {})
        defaults = dict(item.get("defaults") or {})
        placeholders = [dict(placeholder) for placeholder in list(item.get("placeholders") or [])]
        references = []
        for reference in list(item.get("references") or []):
            current = dict(reference)
            current["asset_url"] = _asset_url(base_url, current.get("asset_rel"))
            references.append(current)
        legacy_placeholder = placeholders[0] if placeholders else None
        legacy_original = next((reference for reference in references if reference.get("type") == "original"), None)
        legacy_reference = next((reference for reference in references if reference.get("type") == "reference"), None)
        return {
            **item,
            "prompts": prompts,
            "defaults": defaults,
            "placeholders": placeholders,
            "references": references,
            "cover_image_url": _asset_url(base_url, item.get("cover_image_rel")),
            "prompt_template": _clean_text(prompts.get("positive")),
            "negative_prompt": _clean_text(prompts.get("negative")),
            "default_count": _to_int(defaults.get("count"), default=1, minimum=1, maximum=100),
            "default_size": _clean_text(defaults.get("size")),
            "requires_placeholder": bool(placeholders),
            "placeholder_token": f"{{{{{legacy_placeholder['key']}}}}}" if legacy_placeholder else "{{prompt}}",
            "requires_user_source_image": bool(legacy_original and legacy_original.get("required")),
            "reference_image_rel": legacy_reference.get("asset_rel") if legacy_reference else None,
            "reference_image_url": legacy_reference.get("asset_url") if legacy_reference else None,
            "original_image_rel": legacy_original.get("asset_rel") if legacy_original else None,
            "original_image_url": legacy_original.get("asset_url") if legacy_original else None,
            "enabled": item.get("status") == "active",
        }


image_template_service = ImageTemplateService()
