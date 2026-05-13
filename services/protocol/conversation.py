from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable, Iterator

import tiktoken

from services.account_service import account_service
from services.config import config
from services.log_service import log_service
from services.openai_backend_api import OpenAIBackendAPI
from utils.helper import GPT_WEB_MODEL, IMAGE_MODELS, extract_image_from_message_content
from utils.log import logger


class ImageGenerationError(Exception):
    def __init__(
        self,
        message: str,
        status_code: int = 502,
        error_type: str = "server_error",
        code: str | None = "upstream_error",
        param: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type
        self.code = code
        self.param = param

    def to_openai_error(self) -> dict[str, Any]:
        return {
            "error": {
                "message": str(self),
                "type": self.error_type,
                "param": self.param,
                "code": self.code,
            }
        }


def is_token_invalid_error(message: str) -> bool:
    text = str(message or "").lower()
    return (
        "token_invalidated" in text
        or "token_revoked" in text
        or "authentication token has been invalidated" in text
        or "invalidated oauth token" in text
    )


def image_stream_error_message(message: str) -> str:
    text = str(message or "")
    lower = text.lower()
    if "curl: (35)" in lower or "tls connect error" in lower or "openssl_internal" in lower:
        return "upstream image connection failed, please retry later"
    return text or "image generation failed"


def encode_images(images: Iterable[tuple[bytes, str, str]]) -> list[str]:
    return [base64.b64encode(data).decode("ascii") for data, _, _ in images if data]


def save_image_bytes(image_data: bytes, base_url: str | None = None) -> str:
    config.cleanup_old_images()
    file_hash = hashlib.md5(image_data).hexdigest()
    filename = f"{int(time.time())}_{file_hash}.png"
    relative_dir = Path(time.strftime("%Y"), time.strftime("%m"), time.strftime("%d"))
    file_path = config.images_dir / relative_dir / filename
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(image_data)
    return f"{(base_url or config.base_url)}/images/{relative_dir.as_posix()}/{filename}"


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and str(item.get("type") or "") in {"text", "input_text", "output_text"}:
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return ""


def normalize_messages(messages: object, system: Any = None) -> list[dict[str, Any]]:
    normalized = []
    if config.global_system_prompt:
        normalized.append({"role": "system", "content": config.global_system_prompt})
    system_text = message_text(system)
    if system_text:
        normalized.append({"role": "system", "content": system_text})
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role", "user")
            content = message.get("content", "")
            text = message_text(content)
            images: list[tuple[bytes, str]] = []
            if role == "user":
                images.extend(extract_image_from_message_content(content))
                if isinstance(content, list):
                    for part in content:
                        if not isinstance(part, dict) or part.get("type") != "image":
                            continue
                        data = part.get("data")
                        if isinstance(data, (bytes, bytearray)):
                            images.append((bytes(data), str(part.get("mime") or "image/png")))
            if images:
                parts: list[Any] = []
                if text:
                    parts.append({"type": "text", "text": text})
                for data, mime in images:
                    parts.append({"type": "image", "data": data, "mime": mime})
                normalized.append({"role": role, "content": parts})
            else:
                normalized.append({"role": role, "content": text})
    return normalized


def prompt_with_global_system(prompt: str) -> str:
    return f"{config.global_system_prompt}\n\n{prompt}" if config.global_system_prompt else prompt


def assistant_history_text(messages: list[dict[str, Any]]) -> str:
    return "".join(str(item.get("content") or "") for item in messages if item.get("role") == "assistant")


def assistant_history_messages(messages: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("content") or "") for item in messages if item.get("role") == "assistant" and item.get("content")]


IMAGE_ONLY_INSTRUCTION_ZH = "生成以下照片。直接生成最终图片结果，不要提问，不要返回说明文字，不要请求用户补充信息。"
IMAGE_ONLY_RETRY_INSTRUCTION_ZH = "生成以下照片。这是图片生成请求。请直接输出最终图片，不要追问，不要解释，不要返回文字说明。"
IMAGE_ONLY_INSTRUCTION_EN = "Generate the following image. Output the final image only. Do not ask questions, return explanatory text, or request additional information."
IMAGE_ONLY_RETRY_INSTRUCTION_EN = "Generate the following image. This is an image-generation request. Output the final image only. Do not ask follow-up questions, explain, or return text instead of an image."


def detect_prompt_language(prompt: str) -> str:
    cjk_count = len(re.findall(r"[一-鿿]", prompt))
    latin_count = len(re.findall(r"[A-Za-z]", prompt))
    return "zh" if cjk_count >= max(1, latin_count // 2) else "en"


def build_image_prompt(prompt: str, size: str | None, strict_image_only: bool = False) -> str:
    base_prompt = prompt.strip()
    language = detect_prompt_language(base_prompt)
    parts = [base_prompt] if base_prompt else []
    if size:
        if size not in {"1:1", "16:9", "9:16", "4:3", "3:4"}:
            parts.append(
                f"输出图片，宽高比为 {size}。" if language == "zh" else f"Output an image with a {size} aspect ratio."
            )
        else:
            parts.append({
                "zh": {
                    "1:1": "输出为 1:1 正方形构图，主体居中，适合正方形画幅。",
                    "16:9": "输出为 16:9 横屏构图，适合宽画幅展示。",
                    "9:16": "输出为 9:16 竖屏构图，适合竖版画幅展示。",
                    "4:3": "输出为 4:3 比例，兼顾宽度与高度，适合展示画面细节。",
                    "3:4": "输出为 3:4 比例，纵向构图，适合人物肖像或竖向场景。",
                },
                "en": {
                    "1:1": "Output a 1:1 square composition with the subject centered.",
                    "16:9": "Output a 16:9 landscape composition suited for a wide frame.",
                    "9:16": "Output a 9:16 portrait composition suited for a vertical frame.",
                    "4:3": "Output a 4:3 composition that balances width and height for scene detail.",
                    "3:4": "Output a 3:4 portrait composition suited for people or vertical scenes.",
                },
            }[language][size])
    parts.append(
        (IMAGE_ONLY_RETRY_INSTRUCTION_ZH if strict_image_only else IMAGE_ONLY_INSTRUCTION_ZH)
        if language == "zh"
        else (IMAGE_ONLY_RETRY_INSTRUCTION_EN if strict_image_only else IMAGE_ONLY_INSTRUCTION_EN)
    )
    return "\n\n".join(part for part in parts if part)


def _truncate_text(value: object, limit: int = 1000) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


DEBUG_EVENT_TAIL_LIMIT = 12
DEBUG_TEXT_LIMIT = 1200
ASYNC_IMAGE_POLL_TIMEOUT_SECS = max(300, int(config.image_poll_timeout_secs or 120))


def _clip_debug_value(value: Any, depth: int = 0) -> Any:
    if depth >= 4:
        return _truncate_text(value, 240)
    if isinstance(value, dict):
        clipped: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if key_text in {"b64_json", "data", "image_bytes"}:
                clipped[key_text] = "<omitted>"
                continue
            clipped[key_text] = _clip_debug_value(item, depth + 1)
        return clipped
    if isinstance(value, list):
        if len(value) > 8:
            value = value[-8:]
        return [_clip_debug_value(item, depth + 1) for item in value]
    if isinstance(value, str):
        if value.startswith("data:"):
            return "<data-url omitted>"
        return _truncate_text(value, DEBUG_TEXT_LIMIT)
    return value


def _append_debug_event(bucket: list[dict[str, Any]], item: dict[str, Any]) -> None:
    bucket.append(_clip_debug_value(item))
    if len(bucket) > DEBUG_EVENT_TAIL_LIMIT:
        del bucket[:-DEBUG_EVENT_TAIL_LIMIT]


def _extract_async_image_task_id(raw_events_tail: list[dict[str, Any]]) -> str:
    for event in reversed(raw_events_tail):
        if not isinstance(event, dict):
            continue
        metadata = None
        if isinstance(event.get("metadata"), dict):
            metadata = event.get("metadata")
        else:
            value = event.get("v")
            if isinstance(value, dict):
                message = value.get("message")
                if isinstance(message, dict):
                    maybe_metadata = message.get("metadata")
                    if isinstance(maybe_metadata, dict):
                        metadata = maybe_metadata
        if not isinstance(metadata, dict):
            continue
        task_id = str(metadata.get("image_gen_task_id") or "").strip()
        if task_id:
            return task_id
    return ""


def _log_image_debug_snapshot(
    request: ConversationRequest,
    *,
    conversation_id: str,
    file_ids: list[str],
    sediment_ids: list[str],
    message: str,
    last: dict[str, Any],
    raw_events_tail: list[dict[str, Any]],
    parsed_events_tail: list[dict[str, Any]],
    reason: str,
) -> None:
    log_service.add(
        "image_upstream_debug",
        "图片请求回退为文本",
        {
            "reason": reason,
            "conversation_id": conversation_id,
            "account_id": request.account_id,
            "model": request.model,
            "prompt_excerpt": _truncate_text(request.prompt, 600),
            "tool_invoked": last.get("tool_invoked"),
            "turn_use_case": last.get("turn_use_case"),
            "blocked": bool(last.get("blocked")),
            "message": _truncate_text(message, DEBUG_TEXT_LIMIT),
            "file_ids": file_ids,
            "sediment_ids": sediment_ids,
            "image_retry_count": request.image_retry_count,
            "raw_events_tail": raw_events_tail,
            "parsed_events_tail": parsed_events_tail,
        },
    )


def encoding_for_model(model: str):
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        try:
            return tiktoken.get_encoding("o200k_base")
        except KeyError:
            return tiktoken.get_encoding("cl100k_base")


def count_message_tokens(messages: list[dict[str, Any]], model: str) -> int:
    encoding = encoding_for_model(model)
    total = 0
    for message in messages:
        total += 3
        for key, value in message.items():
            if not isinstance(value, str):
                continue
            total += len(encoding.encode(value))
            if key == "name":
                total += 1
    return total + 3


def count_text_tokens(text: str, model: str) -> int:
    return len(encoding_for_model(model).encode(text))


def format_image_result(
    items: list[dict[str, Any]],
    prompt: str,
    response_format: str,
    base_url: str | None = None,
    created: int | None = None,
    message: str = "",
) -> dict[str, Any]:
    data: list[dict[str, Any]] = []
    for item in items:
        b64_json = str(item.get("b64_json") or "").strip()
        if not b64_json:
            continue
        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt
        if response_format == "b64_json":
            data.append({
                "b64_json": b64_json,
                "url": save_image_bytes(base64.b64decode(b64_json), base_url),
                "revised_prompt": revised_prompt,
            })
        else:
            data.append({
                "url": save_image_bytes(base64.b64decode(b64_json), base_url),
                "revised_prompt": revised_prompt,
            })
    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}
    if message and not data:
        result["message"] = message
    return result


@dataclass
class ConversationRequest:
    model: str = "auto"
    prompt: str = ""
    messages: list[dict[str, Any]] | None = None
    images: list[str] | None = None
    n: int = 1
    size: str | None = None
    response_format: str = "b64_json"
    base_url: str | None = None
    message_as_error: bool = False
    image_retry_count: int = 0
    account_id: str = ""


@dataclass
class ConversationState:
    text: str = ""
    conversation_id: str = ""
    file_ids: list[str] = field(default_factory=list)
    sediment_ids: list[str] = field(default_factory=list)
    blocked: bool = False
    tool_invoked: bool | None = None
    turn_use_case: str = ""
    content_references: list[dict[str, Any]] = field(default_factory=list)
    safe_urls: list[str] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    inline_links: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ImageOutput:
    kind: str
    model: str
    index: int
    total: int
    created: int = field(default_factory=lambda: int(time.time()))
    text: str = ""
    upstream_event_type: str = ""
    data: list[dict[str, Any]] = field(default_factory=list)

    def to_chunk(self) -> dict[str, Any]:
        chunk: dict[str, Any] = {
            "object": "image.generation.chunk",
            "created": self.created,
            "model": self.model,
            "index": self.index,
            "total": self.total,
            "progress_text": self.text,
            "upstream_event_type": self.upstream_event_type,
            "data": [],
        }
        if self.kind == "message":
            chunk.update({
                "object": "image.generation.message",
                "message": self.text,
            })
            chunk.pop("progress_text", None)
            chunk.pop("upstream_event_type", None)
        elif self.kind == "result":
            chunk.update({
                "object": "image.generation.result",
                "data": self.data,
            })
            chunk.pop("progress_text", None)
            chunk.pop("upstream_event_type", None)
        return chunk


def assistant_message_text(message: dict[str, Any]) -> str:
    content = message.get("content") or {}
    parts = content.get("parts") or []
    if not isinstance(parts, list):
        return ""
    return "".join(part for part in parts if isinstance(part, str))


def strip_history(text: str, history_text: str = "") -> str:
    text = str(text or "")
    history_text = str(history_text or "")
    while history_text and text.startswith(history_text):
        text = text[len(history_text):]
    return text


def assistant_text(event: dict[str, Any], current_text: str = "", history_text: str = "") -> str:
    for candidate in (event, event.get("v")):
        if not isinstance(candidate, dict):
            continue
        message = candidate.get("message")
        if not isinstance(message, dict):
            continue
        role = str((message.get("author") or {}).get("role") or "").strip().lower()
        if role != "assistant":
            continue
        text = assistant_message_text(message)
        if text:
            return strip_history(text, history_text)
    return apply_text_patch(event, current_text, history_text)


def event_assistant_text(event: dict[str, Any], history_text: str = "") -> str:
    for candidate in (event, event.get("v")):
        if not isinstance(candidate, dict):
            continue
        message = candidate.get("message")
        if isinstance(message, dict) and (message.get("author") or {}).get("role") == "assistant":
            return strip_history(assistant_message_text(message), history_text)
    return ""


def apply_text_patch(event: dict[str, Any], current_text: str = "", history_text: str = "") -> str:
    if event.get("p") == "/message/content/parts/0":
        return apply_patch_op(event, current_text, history_text)

    operations = event.get("v")
    if isinstance(operations, str) and current_text and not event.get("p") and not event.get("o"):
        return current_text + operations

    if event.get("o") == "patch" and isinstance(operations, list):
        text = current_text
        for item in operations:
            if isinstance(item, dict):
                text = apply_text_patch(item, text, history_text)
        return text

    if not isinstance(operations, list):
        return current_text

    text = current_text
    for item in operations:
        if isinstance(item, dict):
            text = apply_text_patch(item, text, history_text)
    return text


def apply_patch_op(operation: dict[str, Any], current_text: str, history_text: str = "") -> str:
    op = operation.get("o")
    value = str(operation.get("v") or "")
    if op == "append":
        return current_text + value
    if op == "replace":
        return strip_history(value, history_text)
    return current_text


def add_unique(values: list[str], candidates: list[str]) -> None:
    for candidate in candidates:
        if candidate and candidate not in values:
            values.append(candidate)


def ensure_list_size(values: list[Any], size: int) -> None:
    while len(values) <= size:
        values.append({})


def parse_path_segments(path: str) -> list[str]:
    return [segment for segment in str(path or "").split("/") if segment]


def set_nested_value(container: Any, path: list[str], value: Any, op: str) -> Any:
    if not path:
        return value
    current = container if isinstance(container, (list, dict)) else [] if path[0].isdigit() else {}
    segment = path[0]
    is_index = segment.isdigit()
    if len(path) == 1:
        if is_index:
            if not isinstance(current, list):
                current = []
            index = int(segment)
            ensure_list_size(current, index)
            existing = current[index]
            if op == "append":
                if isinstance(existing, list) and isinstance(value, list):
                    existing.extend(value)
                    current[index] = existing
                elif isinstance(existing, str) and isinstance(value, str):
                    current[index] = existing + value
                elif isinstance(existing, dict) and isinstance(value, dict):
                    merged = dict(existing)
                    merged.update(value)
                    current[index] = merged
                elif existing in (None, {}, [], ""):
                    current[index] = value
                else:
                    current[index] = value
            elif op == "remove":
                current[index] = {} if isinstance(existing, dict) else [] if isinstance(existing, list) else None
            else:
                current[index] = value
            return current
        if not isinstance(current, dict):
            current = {}
        existing = current.get(segment)
        if op == "append":
            if isinstance(existing, list) and isinstance(value, list):
                current[segment] = [*existing, *value]
            elif isinstance(existing, str) and isinstance(value, str):
                current[segment] = existing + value
            elif isinstance(existing, dict) and isinstance(value, dict):
                merged = dict(existing)
                merged.update(value)
                current[segment] = merged
            elif existing in (None, {}, [], ""):
                current[segment] = value
            else:
                current[segment] = value
        elif op == "remove":
            current.pop(segment, None)
        else:
            current[segment] = value
        return current

    if is_index:
        if not isinstance(current, list):
            current = []
        index = int(segment)
        ensure_list_size(current, index)
        next_segment = path[1]
        child = current[index]
        if not isinstance(child, (list, dict)):
            child = [] if next_segment.isdigit() else {}
        current[index] = set_nested_value(child, path[1:], value, op)
        return current

    if not isinstance(current, dict):
        current = {}
    next_segment = path[1]
    child = current.get(segment)
    if not isinstance(child, (list, dict)):
        child = [] if next_segment.isdigit() else {}
    current[segment] = set_nested_value(child, path[1:], value, op)
    return current


def extract_ref_index(ref: dict[str, Any]) -> str:
    turn_index = ref.get("turn_index")
    ref_type = str(ref.get("ref_type") or "").strip()
    ref_index = ref.get("ref_index")
    if ref_type == "search" and isinstance(turn_index, int) and isinstance(ref_index, int):
        return f"turn{turn_index}search{ref_index}"
    return ""


def normalize_source_item(item: dict[str, Any], safe_urls: list[str]) -> dict[str, Any] | None:
    title = str(item.get("title") or "").strip()
    item_safe_urls = [str(url).strip() for url in item.get("safe_urls") or [] if str(url).strip()]
    url = str(item.get("url") or "").strip()
    preferred_url = item_safe_urls[0] if item_safe_urls else next((safe_url for safe_url in safe_urls if safe_url == url or safe_url.rstrip("?utm_source=chatgpt.com") == url.rstrip("?utm_source=chatgpt.com")), "") or url
    if not preferred_url:
        return None
    ref_indices = [ref_index for ref_index in (extract_ref_index(ref) for ref in item.get("refs") or []) if ref_index]
    return {
        "id": preferred_url,
        "title": title or preferred_url,
        "url": preferred_url,
        "attribution": str(item.get("attribution") or "").strip() or None,
        "snippet": str(item.get("snippet") or "").strip() or None,
        "ref_indices": ref_indices,
    }


def extract_markdown_link(value: str) -> tuple[str, str] | None:
    text = str(value or "").strip()
    match = re.match(r"^\[([^\]]+)\]\((https?://[^)]+)\)$", text)
    if not match:
        return None
    label = str(match.group(1) or "").strip()
    url = str(match.group(2) or "").strip()
    if not label or not url:
        return None
    return label, url


def normalize_inline_link(reference: dict[str, Any], fallback_safe_urls: list[str]) -> dict[str, Any] | None:
    if str(reference.get("type") or "") != "alt_text":
        return None
    alt_link = extract_markdown_link(str(reference.get("alt") or ""))
    if not alt_link:
        return None
    label, url = alt_link
    safe_urls = [str(item).strip() for item in reference.get("safe_urls") or fallback_safe_urls if str(item).strip()]
    preferred_url = next((safe_url for safe_url in safe_urls if safe_url == url or safe_url.rstrip("?utm_source=chatgpt.com") == url.rstrip("?utm_source=chatgpt.com")), "") or url
    ref_indices = [ref_index for ref_index in (extract_ref_index(ref) for ref in reference.get("refs") or []) if ref_index]
    return {
        "id": preferred_url,
        "label": label,
        "url": preferred_url,
        "ref_indices": ref_indices,
    }


def rebuild_sources(state: ConversationState) -> None:
    sources: list[dict[str, Any]] = []
    inline_links: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_inline_links: set[tuple[str, str]] = set()
    for reference in state.content_references:
        if not isinstance(reference, dict):
            continue
        normalized_inline_link = normalize_inline_link(reference, state.safe_urls)
        if normalized_inline_link:
            inline_key = (str(normalized_inline_link.get("label") or ""), str(normalized_inline_link.get("url") or ""))
            if inline_key not in seen_inline_links:
                seen_inline_links.add(inline_key)
                inline_links.append(normalized_inline_link)
        if str(reference.get("type") or "") != "grouped_webpages":
            continue
        items: list[dict[str, Any]] = []
        for raw_item in reference.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            normalized_item = normalize_source_item(raw_item, [str(url) for url in reference.get("safe_urls") or state.safe_urls if str(url)])
            if not normalized_item:
                continue
            normalized_url = str(normalized_item.get("url") or "")
            if normalized_url in seen_urls:
                continue
            seen_urls.add(normalized_url)
            items.append(normalized_item)
        if items:
            sources.append({"type": "grouped_webpages", "items": items})
    state.sources = sources
    state.inline_links = inline_links


def update_content_reference_state(state: ConversationState, operation: dict[str, Any]) -> None:
    path_segments = parse_path_segments(str(operation.get("p") or ""))
    if not path_segments:
        return
    if path_segments[:2] == ["message", "metadata"] and path_segments[2:3] == ["safe_urls"]:
        value = operation.get("v")
        if operation.get("o") == "append" and isinstance(value, list):
            add_unique(state.safe_urls, [str(item).strip() for item in value if str(item).strip()])
        elif operation.get("o") == "replace" and isinstance(value, list):
            state.safe_urls = [str(item).strip() for item in value if str(item).strip()]
        return
    if path_segments[:3] != ["message", "metadata", "content_references"]:
        return
    relative_path = path_segments[3:]
    op = str(operation.get("o") or "")
    value = operation.get("v")
    if not relative_path:
        if op == "append" and isinstance(value, list):
            state.content_references.extend(item for item in value if isinstance(item, dict))
        elif op == "replace" and isinstance(value, list):
            state.content_references = [item for item in value if isinstance(item, dict)]
        return
    state.content_references = set_nested_value(state.content_references, relative_path, value, op)


def update_source_state(state: ConversationState, event: dict[str, Any]) -> None:
    operations = event.get("v") if event.get("o") == "patch" and isinstance(event.get("v"), list) else None
    if operations is None and event.get("p"):
        operations = [event]
    if not operations:
        for candidate in (event, event.get("v")):
            if not isinstance(candidate, dict):
                continue
            message = candidate.get("message")
            if not isinstance(message, dict):
                continue
            author = message.get("author") or {}
            if str(author.get("role") or "").strip().lower() != "assistant":
                continue
            metadata = message.get("metadata") or {}
            references = metadata.get("content_references")
            if isinstance(references, list):
                state.content_references = [item for item in references if isinstance(item, dict)]
            safe_urls = metadata.get("safe_urls")
            if isinstance(safe_urls, list):
                state.safe_urls = [str(item).strip() for item in safe_urls if str(item).strip()]
        rebuild_sources(state)
        return
    for operation in operations:
        if isinstance(operation, dict):
            update_content_reference_state(state, operation)
    rebuild_sources(state)


def extract_conversation_ids(payload: str) -> tuple[str, list[str], list[str]]:
    conversation_match = re.search(r'"conversation_id"\s*:\s*"([^"]+)"', payload)
    conversation_id = conversation_match.group(1) if conversation_match else ""
    file_ids = re.findall(r"(file[-_][A-Za-z0-9]+)", payload)
    sediment_ids = re.findall(r"sediment://([A-Za-z0-9_-]+)", payload)
    return conversation_id, file_ids, sediment_ids


def _asset_ids_from_text(value: Any) -> tuple[list[str], list[str]]:
    text = str(value or "")
    return (
        re.findall(r"(file[-_][A-Za-z0-9]+)", text),
        re.findall(r"sediment://([A-Za-z0-9_-]+)", text),
    )


def extract_event_asset_ids(event: dict[str, Any]) -> tuple[list[str], list[str]]:
    file_ids: list[str] = []
    sediment_ids: list[str] = []
    for candidate in (event, event.get("v")):
        if not isinstance(candidate, dict):
            continue
        message = candidate.get("message")
        if not isinstance(message, dict):
            continue
        author = message.get("author") or {}
        if str(author.get("role") or "") != "tool":
            continue
        content = message.get("content") or {}
        parts = content.get("parts") or []
        if not isinstance(parts, list):
            continue
        for part in parts:
            if isinstance(part, dict):
                for key in ("asset_pointer", "url", "text"):
                    extracted_file_ids, extracted_sediment_ids = _asset_ids_from_text(part.get(key))
                    add_unique(file_ids, extracted_file_ids)
                    add_unique(sediment_ids, extracted_sediment_ids)
            elif isinstance(part, str):
                extracted_file_ids, extracted_sediment_ids = _asset_ids_from_text(part)
                add_unique(file_ids, extracted_file_ids)
                add_unique(sediment_ids, extracted_sediment_ids)
    return file_ids, sediment_ids


def update_conversation_state(state: ConversationState, payload: str, event: dict[str, Any] | None = None) -> None:
    conversation_id, file_ids, sediment_ids = extract_conversation_ids(payload)
    if conversation_id and not state.conversation_id:
        state.conversation_id = conversation_id
    add_unique(state.file_ids, file_ids)
    add_unique(state.sediment_ids, sediment_ids)
    if isinstance(event, dict):
        event_file_ids, event_sediment_ids = extract_event_asset_ids(event)
        add_unique(state.file_ids, event_file_ids)
        add_unique(state.sediment_ids, event_sediment_ids)
    if not isinstance(event, dict):
        return
    state.conversation_id = str(event.get("conversation_id") or state.conversation_id)
    value = event.get("v")
    if isinstance(value, dict):
        state.conversation_id = str(value.get("conversation_id") or state.conversation_id)
    if event.get("type") == "moderation":
        moderation = event.get("moderation_response")
        if isinstance(moderation, dict) and moderation.get("blocked") is True:
            state.blocked = True
    if event.get("type") == "server_ste_metadata":
        metadata = event.get("metadata")
        if isinstance(metadata, dict):
            if isinstance(metadata.get("tool_invoked"), bool):
                state.tool_invoked = metadata["tool_invoked"]
            state.turn_use_case = str(metadata.get("turn_use_case") or state.turn_use_case)
    update_source_state(state, event)


def conversation_base_event(event_type: str, state: ConversationState, **extra: Any) -> dict[str, Any]:
    return {
        "type": event_type,
        "text": state.text,
        "conversation_id": state.conversation_id,
        "file_ids": list(state.file_ids),
        "sediment_ids": list(state.sediment_ids),
        "blocked": state.blocked,
        "tool_invoked": state.tool_invoked,
        "turn_use_case": state.turn_use_case,
        "sources": [dict(source) for source in state.sources],
        "inline_links": [dict(link) for link in state.inline_links],
        **extra,
    }


def iter_conversation_payloads(payloads: Iterator[str], history_text: str = "",
                               history_messages: list[str] | None = None) -> Iterator[dict[str, Any]]:
    state = ConversationState()
    history_messages = history_messages or []
    history_index = 0
    for payload in payloads:
        # print(f"[upstream_sse] {payload}", flush=True)
        if not payload:
            continue
        if payload == "[DONE]":
            yield conversation_base_event("conversation.done", state, done=True)
            break
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            update_conversation_state(state, payload)
            yield conversation_base_event("conversation.raw", state, payload=payload)
            continue
        if not isinstance(event, dict):
            yield conversation_base_event("conversation.event", state, raw=event)
            continue
        update_conversation_state(state, payload, event)
        if history_index < len(history_messages) and event_assistant_text(event, history_text) == history_messages[history_index]:
            history_index += 1
            state.text = ""
            continue
        next_text = assistant_text(event, state.text, history_text)
        if next_text != state.text:
            delta = next_text[len(state.text):] if next_text.startswith(state.text) else next_text
            state.text = next_text
            yield conversation_base_event("conversation.delta", state, raw=event, delta=delta)
            continue
        yield conversation_base_event("conversation.event", state, raw=event)


def conversation_events(
    backend: OpenAIBackendAPI,
    messages: list[dict[str, Any]] | None = None,
    model: str = "auto",
    prompt: str = "",
    images: list[str] | None = None,
    size: str | None = None,
    strict_image_only: bool = False,
) -> Iterator[dict[str, Any]]:
    normalized = normalize_messages(messages or ([{"role": "user", "content": prompt}] if prompt else []))
    image_model = str(model or "").strip() in IMAGE_MODELS
    history_text = "" if image_model else assistant_history_text(normalized)
    history_messages = [] if image_model else assistant_history_messages(normalized)
    final_prompt = prompt_with_global_system(build_image_prompt(prompt, size, strict_image_only)) if image_model else prompt
    payloads = backend.stream_conversation(
        messages=normalized,
        model=model,
        prompt=final_prompt,
        images=images if image_model else None,
        system_hints=["picture_v2"] if image_model else None,
    )
    yield from iter_conversation_payloads(payloads, history_text, history_messages)


def text_backend() -> OpenAIBackendAPI:
    return OpenAIBackendAPI(access_token=account_service.get_text_access_token())


def gpt_web_text_backend() -> OpenAIBackendAPI:
    return OpenAIBackendAPI(access_token=account_service.get_text_access_token(), route_mode=GPT_WEB_MODEL)


def stream_text_deltas(backend: OpenAIBackendAPI, request: ConversationRequest) -> Iterator[str]:
    attempted_tokens: set[str] = set()
    token = getattr(backend, "access_token", "")
    emitted = False
    while True:
        if token and token in attempted_tokens:
            raise RuntimeError("no available text account")
        if token:
            attempted_tokens.add(token)
        try:
            active_backend = OpenAIBackendAPI(access_token=token)
            for event in conversation_events(active_backend, messages=request.messages, model=request.model, prompt=request.prompt):
                if event.get("type") != "conversation.delta":
                    continue
                delta = str(event.get("delta") or "")
                if delta:
                    emitted = True
                    yield delta
            account_service.mark_text_used(token)
            return
        except Exception as exc:
            error_message = str(exc)
            if token and not emitted and is_token_invalid_error(error_message):
                account_service.remove_invalid_token(token, "text_stream")
                token = account_service.get_text_access_token(attempted_tokens)
                if token:
                    continue
            raise


def collect_text(backend: OpenAIBackendAPI, request: ConversationRequest) -> str:
    return "".join(stream_text_deltas(backend, request))


def stream_image_outputs(
        backend: OpenAIBackendAPI,
        request: ConversationRequest,
        index: int = 1,
        total: int = 1,
) -> Iterator[ImageOutput]:
    last: dict[str, Any] = {}
    raw_events_tail: list[dict[str, Any]] = []
    parsed_events_tail: list[dict[str, Any]] = []
    for event in conversation_events(
            backend,
            prompt=request.prompt,
            model=request.model,
            images=request.images or [],
            size=request.size,
            strict_image_only=request.image_retry_count > 0,
    ):
        last = event
        event_type = str(event.get("type") or "")
        if event_type == "conversation.delta":
            _append_debug_event(parsed_events_tail, {
                "type": event_type,
                "delta": event.get("delta"),
            })
            if isinstance(event.get("raw"), dict):
                _append_debug_event(raw_events_tail, event.get("raw") or {})
            yield ImageOutput(
                kind="progress",
                model=request.model,
                index=index,
                total=total,
                text=str(event.get("delta") or ""),
                upstream_event_type="conversation.delta",
            )
            continue
        if event_type == "conversation.event":
            raw = event.get("raw")
            if isinstance(raw, dict):
                _append_debug_event(raw_events_tail, raw)
            _append_debug_event(parsed_events_tail, {
                "type": event_type,
                "conversation_id": event.get("conversation_id"),
                "file_ids": event.get("file_ids"),
                "sediment_ids": event.get("sediment_ids"),
                "tool_invoked": event.get("tool_invoked"),
                "turn_use_case": event.get("turn_use_case"),
                "text": event.get("text"),
            })
            raw_type = str(raw.get("type") or "") if isinstance(raw, dict) else ""
            yield ImageOutput(
                kind="progress",
                model=request.model,
                index=index,
                total=total,
                upstream_event_type=raw_type,
            )

    conversation_id = str(last.get("conversation_id") or "")
    file_ids = [str(item) for item in last.get("file_ids") or []]
    sediment_ids = [str(item) for item in last.get("sediment_ids") or []]
    message = str(last.get("text") or "").strip()
    async_image_task_id = _extract_async_image_task_id(raw_events_tail)
    has_async_image_pending = bool(async_image_task_id)
    is_text_response = last.get("tool_invoked") is False or last.get("turn_use_case") == "text"
    logger.info({
        "event": "image_stream_resolve_start",
        "conversation_id": conversation_id,
        "account_id": request.account_id,
        "file_ids": file_ids,
        "sediment_ids": sediment_ids,
        "tool_invoked": last.get("tool_invoked"),
        "turn_use_case": last.get("turn_use_case"),
        "async_image_task_id": async_image_task_id,
    })
    if message and not file_ids and not sediment_ids and (last.get("blocked") or is_text_response):
        should_retry = bool(message) and not last.get("blocked") and is_text_response and request.image_retry_count < 1
        if should_retry:
            logger.info({
                "event": "image_stream_retry_on_text_response",
                "conversation_id": conversation_id,
                "retry_count": request.image_retry_count + 1,
                "turn_use_case": last.get("turn_use_case"),
            })
            yield from stream_image_outputs(
                backend,
                replace(request, image_retry_count=request.image_retry_count + 1),
                index=index,
                total=total,
            )
            return
        error_text = message
        if is_text_response and not last.get("blocked"):
            error_text = f"上游未生成图片，而是返回补充说明：{message}"
        _log_image_debug_snapshot(
            request,
            conversation_id=conversation_id,
            file_ids=file_ids,
            sediment_ids=sediment_ids,
            message=message,
            last=last,
            raw_events_tail=raw_events_tail,
            parsed_events_tail=parsed_events_tail,
            reason="text_fallback",
        )
        yield ImageOutput(kind="message", model=request.model, index=index, total=total, text=error_text)
        return

    image_urls = backend.resolve_conversation_image_urls(conversation_id, file_ids, sediment_ids)
    if not image_urls and has_async_image_pending and conversation_id:
        logger.info({
            "event": "image_stream_async_poll_retry",
            "conversation_id": conversation_id,
            "account_id": request.account_id,
            "async_image_task_id": async_image_task_id,
            "timeout_secs": ASYNC_IMAGE_POLL_TIMEOUT_SECS,
        })
        image_urls = backend.resolve_conversation_image_urls(
            conversation_id,
            file_ids,
            sediment_ids,
            poll_timeout_secs=ASYNC_IMAGE_POLL_TIMEOUT_SECS,
        )
    if image_urls:
        image_items = [
            {"b64_json": base64.b64encode(image_data).decode("ascii")}
            for image_data in backend.download_image_bytes(image_urls)
        ]
        data = format_image_result(
            image_items,
            request.prompt,
            request.response_format,
            request.base_url,
            int(time.time()),
        )["data"]
        if data:
            yield ImageOutput(kind="result", model=request.model, index=index, total=total, data=data)
        return

    if message:
        text = message
        if is_text_response:
            text = f"上游未生成图片，而是返回补充说明：{message}"
        _log_image_debug_snapshot(
            request,
            conversation_id=conversation_id,
            file_ids=file_ids,
            sediment_ids=sediment_ids,
            message=message,
            last=last,
            raw_events_tail=raw_events_tail,
            parsed_events_tail=parsed_events_tail,
            reason="message_without_assets",
        )
        yield ImageOutput(kind="message", model=request.model, index=index, total=total, text=text)


def stream_image_outputs_with_pool(request: ConversationRequest) -> Iterator[ImageOutput]:
    if str(request.model or "").strip() not in IMAGE_MODELS:
        raise ImageGenerationError("unsupported image model,supported models: " + ", ".join(IMAGE_MODELS))

    emitted = False
    last_error = ""
    for index in range(1, request.n + 1):
        while True:
            try:
                token = account_service.get_available_access_token()
            except RuntimeError as exc:
                if emitted:
                    return
                raise ImageGenerationError(str(exc) or "image generation failed") from exc

            emitted_for_token = False
            returned_message = False
            returned_result = False
            try:
                account = account_service.get_account(token) or {}
                request.account_id = str(account.get("user_id") or "")
                backend = OpenAIBackendAPI(access_token=token)
                for output in stream_image_outputs(backend, request, index, request.n):
                    if output.kind == "message" and request.message_as_error:
                        raise ImageGenerationError(
                            output.text or "Image generation was rejected by upstream policy.",
                            status_code=400,
                            error_type="invalid_request_error",
                            code="content_policy_violation",
                        )
                    emitted = True
                    emitted_for_token = True
                    returned_message = output.kind == "message"
                    returned_result = returned_result or output.kind == "result"
                    yield output
                if returned_message or not returned_result:
                    account_service.mark_image_result(token, False)
                    return
                account_service.mark_image_result(token, True)
                break
            except ImageGenerationError:
                account_service.mark_image_result(token, False)
                raise
            except Exception as exc:
                account_service.mark_image_result(token, False)
                last_error = str(exc)
                logger.warning({"event": "image_stream_fail", "request_token": token, "error": last_error})
                if not emitted_for_token and is_token_invalid_error(last_error):
                    account_service.remove_invalid_token(token, "image_stream")
                    continue
                raise ImageGenerationError(image_stream_error_message(last_error)) from exc

    if not emitted:
        raise ImageGenerationError(image_stream_error_message(last_error))


def stream_image_chunks(outputs: Iterable[ImageOutput]) -> Iterator[dict[str, Any]]:
    for output in outputs:
        yield output.to_chunk()


def collect_image_outputs(outputs: Iterable[ImageOutput]) -> dict[str, Any]:
    created = None
    data: list[dict[str, Any]] = []
    message = ""
    progress_parts: list[str] = []
    for output in outputs:
        created = created or output.created
        if output.kind == "progress" and output.text:
            progress_parts.append(output.text)
        elif output.kind == "message":
            message = output.text
        elif output.kind == "result":
            data.extend(output.data)

    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}
    if not data:
        text = message or "".join(progress_parts).strip()
        if text:
            result["message"] = text
    return result
