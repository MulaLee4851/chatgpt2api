from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.image_inputs import parse_image_edit_request

from api.support import (
    consume_identity_images,
    consume_identity_tokens,
    ensure_identity_can_use_chat,
    ensure_identity_can_use_image,
    require_identity,
    resolve_image_base_url,
)
from services.content_filter import check_request, request_text
from services.log_service import LoggedCall
from services.protocol import (
    anthropic_v1_messages,
    openai_v1_chat_complete,
    openai_v1_image_edit,
    openai_v1_image_generations,
    openai_v1_models,
    openai_v1_response,
)
from services.protocol.conversation import count_message_tokens, count_text_tokens


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: Optional[str] = None
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: Optional[bool] = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: Optional[str] = None
    prompt: Optional[str] = None
    n: Optional[int] = None
    stream: Optional[bool] = None
    modalities: Optional[list[str]] = None
    messages: Optional[list[dict[str, object]]] = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: Optional[str] = None
    input: object = None
    tools: Optional[list[dict[str, object]]] = None
    tool_choice: object = None
    stream: Optional[bool] = None


class AnthropicMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: Optional[str] = None
    messages: Optional[list[dict[str, object]]] = None
    system: object = None
    stream: Optional[bool] = None


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def _safe_consume_tokens(identity: dict[str, object], total_tokens: int) -> None:
    try:
        consume_identity_tokens(identity, total_tokens)
    except Exception:
        return


def _safe_consume_images(identity: dict[str, object], image_count: int) -> None:
    try:
        consume_identity_images(identity, image_count)
    except Exception:
        return


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: Optional[str] = Header(default=None)):
        require_identity(authorization)
        try:
            return await run_in_threadpool(openai_v1_models.list_models)
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: Optional[str] = Header(default=None),
    ):
        identity = require_identity(authorization)
        ensure_identity_can_use_image(identity, body.n)
        payload = body.model_dump(mode="python")
        payload["base_url"] = resolve_image_base_url(request)
        call = LoggedCall(identity, "/v1/images/generations", body.model, "文生图", request_text=body.prompt)
        await filter_or_log(call, body.prompt)
        consumed = {"images": 0}

        def on_result(result: dict[str, object]) -> None:
            images = result.get("data")
            if isinstance(images, list):
                consumed["images"] = len(images)
                _safe_consume_images(identity, consumed["images"])

        def on_stream_item(item: dict[str, object]) -> None:
            if str(item.get("object") or "") != "image.generation.result":
                return
            images = item.get("data")
            if isinstance(images, list):
                consumed["images"] += len(images)

        def on_stream_finish() -> None:
            _safe_consume_images(identity, consumed["images"])

        return await call.run(
            openai_v1_image_generations.handle,
            payload,
            on_result=on_result,
            on_stream_item=on_stream_item if body.stream else None,
            on_stream_finish=on_stream_finish if body.stream else None,
        )

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: Optional[str] = Header(default=None),
            image: Optional[list[UploadFile]] = File(default=None),
            image_list: Optional[list[UploadFile]] = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: Optional[str] = Form(default=None),
            response_format: str = Form(default="b64_json"),
            stream: Optional[bool] = Form(default=None),
    ):
        identity = require_identity(authorization)
        payload, image_sources = await parse_image_edit_request(request)
        prompt = str(payload["prompt"])
        model = str(payload["model"])
        call = LoggedCall(identity, "/v1/images/edits", model, "图生图", request_text=prompt)
        if n < 1 or n > 4:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
        ensure_identity_can_use_image(identity, n)
        await filter_or_log(call, prompt)
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": n,
            "size": size,
            "response_format": response_format,
            "stream": stream,
            "base_url": resolve_image_base_url(request),
        }
        consumed = {"images": 0}

        def on_result(result: dict[str, object]) -> None:
            data = result.get("data")
            if isinstance(data, list):
                consumed["images"] = len(data)
                _safe_consume_images(identity, consumed["images"])

        def on_stream_item(item: dict[str, object]) -> None:
            if str(item.get("object") or "") != "image.generation.result":
                return
            data = item.get("data")
            if isinstance(data, list):
                consumed["images"] += len(data)

        def on_stream_finish() -> None:
            _safe_consume_images(identity, consumed["images"])

        return await call.run(
            openai_v1_image_edit.handle,
            payload,
            on_result=on_result,
            on_stream_item=on_stream_item if stream else None,
            on_stream_finish=on_stream_finish if stream else None,
        )

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: Optional[str] = Header(default=None)):
        identity = require_identity(authorization)
        ensure_identity_can_use_chat(identity)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("prompt"), payload.get("messages"))
        call = LoggedCall(identity, "/v1/chat/completions", model, "文本生成", request_text=request_preview)
        await filter_or_log(call, request_preview)
        model_name, messages = openai_v1_chat_complete.text_chat_parts(payload)
        streamed_text: list[str] = []

        def on_result(result: dict[str, object]) -> None:
            usage = result.get("usage")
            total_tokens = int((usage or {}).get("total_tokens") or 0) if isinstance(usage, dict) else 0
            _safe_consume_tokens(identity, total_tokens)

        def on_stream_item(item: dict[str, object]) -> None:
            choices = item.get("choices")
            first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
            delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
            content = str(delta.get("content") or "")
            if content:
                streamed_text.append(content)

        def on_stream_finish() -> None:
            total_tokens = count_message_tokens(messages, model_name) + count_text_tokens("".join(streamed_text), model_name)
            _safe_consume_tokens(identity, total_tokens)

        return await call.run(
            openai_v1_chat_complete.handle,
            payload,
            on_result=on_result,
            on_stream_item=on_stream_item if body.stream else None,
            on_stream_finish=on_stream_finish if body.stream else None,
        )

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: Optional[str] = Header(default=None)):
        identity = require_identity(authorization)
        ensure_identity_can_use_chat(identity)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("input"), payload.get("instructions"))
        call = LoggedCall(identity, "/v1/responses", model, "Responses", request_text=request_preview)
        await filter_or_log(call, request_preview)
        messages = openai_v1_response.messages_from_input(payload.get("input"), payload.get("instructions"))
        streamed_text: list[str] = []

        def on_result(result: dict[str, object]) -> None:
            output = result.get("output")
            content_parts: list[str] = []
            if isinstance(output, list):
                for item in output:
                    if not isinstance(item, dict):
                        continue
                    for block in item.get("content") or []:
                        if isinstance(block, dict) and str(block.get("type") or "") == "output_text":
                            text = str(block.get("text") or "")
                            if text:
                                content_parts.append(text)
            total_tokens = count_message_tokens(messages, model) + count_text_tokens("".join(content_parts), model)
            _safe_consume_tokens(identity, total_tokens)

        def on_stream_item(item: dict[str, object]) -> None:
            if str(item.get("type") or "") != "response.output_text.delta":
                return
            delta = str(item.get("delta") or "")
            if delta:
                streamed_text.append(delta)

        def on_stream_finish() -> None:
            total_tokens = count_message_tokens(messages, model) + count_text_tokens("".join(streamed_text), model)
            _safe_consume_tokens(identity, total_tokens)

        return await call.run(
            openai_v1_response.handle,
            payload,
            on_result=on_result,
            on_stream_item=on_stream_item if body.stream else None,
            on_stream_finish=on_stream_finish if body.stream else None,
        )

    @router.post("/v1/messages")
    async def create_message(
            body: AnthropicMessageRequest,
            authorization: Optional[str] = Header(default=None),
            x_api_key: Optional[str] = Header(default=None, alias="x-api-key"),
            anthropic_version: Optional[str] = Header(default=None, alias="anthropic-version"),
    ):
        identity = require_identity(authorization or (f"Bearer {x_api_key}" if x_api_key else None))
        ensure_identity_can_use_chat(identity)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("system"), payload.get("messages"), payload.get("tools"))
        call = LoggedCall(identity, "/v1/messages", model, "Messages", request_text=request_preview)
        await filter_or_log(call, request_preview)
        request = anthropic_v1_messages.message_request(payload)
        streamed_text: list[str] = []

        def on_result(result: dict[str, object]) -> None:
            usage = result.get("usage")
            input_tokens = int((usage or {}).get("input_tokens") or 0) if isinstance(usage, dict) else 0
            output_tokens = int((usage or {}).get("output_tokens") or 0) if isinstance(usage, dict) else 0
            _safe_consume_tokens(identity, input_tokens + output_tokens)

        def on_stream_item(item: dict[str, object]) -> None:
            if str(item.get("type") or "") != "content_block_delta":
                return
            delta = item.get("delta")
            if not isinstance(delta, dict):
                return
            if str(delta.get("type") or "") != "text_delta":
                return
            text = str(delta.get("text") or "")
            if text:
                streamed_text.append(text)

        def on_stream_finish() -> None:
            total_tokens = count_message_tokens(request.messages, request.model) + count_text_tokens("".join(streamed_text), request.model)
            _safe_consume_tokens(identity, total_tokens)

        return await call.run(
            anthropic_v1_messages.handle,
            payload,
            sse="anthropic",
            on_result=on_result,
            on_stream_item=on_stream_item if body.stream else None,
            on_stream_finish=on_stream_finish if body.stream else None,
        )

    return router
