from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, model_validator

from api.support import require_admin, require_identity, resolve_image_base_url
from services.image_template_service import image_template_service


class TemplatePromptsRequest(BaseModel):
    positive: str = ""
    negative: str = ""

    @model_validator(mode="after")
    def validate_fields(self):
        self.positive = str(self.positive or "").strip()
        self.negative = str(self.negative or "").strip()
        if not self.positive:
            raise ValueError("正向提示词不能为空")
        return self


class TemplateDefaultsRequest(BaseModel):
    count: int = Field(default=1, ge=1, le=100)
    size: str = ""

    @model_validator(mode="after")
    def validate_fields(self):
        self.size = str(self.size or "").strip()
        return self


class TemplatePlaceholderValidationRequest(BaseModel):
    min_length: Optional[int] = Field(default=None, ge=0)
    max_length: Optional[int] = Field(default=None, ge=0)
    min: Optional[int] = Field(default=None, ge=0)
    max: Optional[int] = Field(default=None, ge=0)
    regex: str = ""
    options: list[str] = []

    @model_validator(mode="after")
    def validate_fields(self):
        self.regex = str(self.regex or "").strip()
        self.options = [item for item in (str(option or "").strip() for option in self.options) if item]
        return self


class TemplatePlaceholderRequest(BaseModel):
    key: str = ""
    label: str = ""
    type: Literal["text", "textarea", "number", "select"] = "text"
    default_value: str = ""
    required: bool = False
    help: str = ""
    validation: TemplatePlaceholderValidationRequest = Field(default_factory=TemplatePlaceholderValidationRequest)

    @model_validator(mode="after")
    def validate_fields(self):
        self.key = str(self.key or "").strip()
        self.label = str(self.label or "").strip() or self.key
        self.default_value = str(self.default_value or "").strip()
        self.help = str(self.help or "").strip()
        if not self.key:
            raise ValueError("变量 key 不能为空")
        if self.type == "select" and not self.validation.options:
            raise ValueError(f"变量 {self.key} 缺少可选项")
        return self


class TemplateReferenceRequest(BaseModel):
    key: str = ""
    label: str = ""
    type: Literal["reference", "original"] = "reference"
    required: bool = False
    weight: float = Field(default=1.0, ge=0.0, le=2.0)
    help: str = ""
    asset_rel: Optional[str] = None

    @model_validator(mode="after")
    def validate_fields(self):
        self.key = str(self.key or "").strip()
        self.label = str(self.label or "").strip() or self.key
        self.help = str(self.help or "").strip()
        if not self.key:
            raise ValueError("引用 key 不能为空")
        return self


class ImageTemplateRequest(BaseModel):
    name: str = ""
    description: str = ""
    mode: Literal["generate", "edit"] = "generate"
    prompts: TemplatePromptsRequest = Field(default_factory=TemplatePromptsRequest)
    defaults: TemplateDefaultsRequest = Field(default_factory=TemplateDefaultsRequest)
    placeholders: list[TemplatePlaceholderRequest] = []
    references: list[TemplateReferenceRequest] = []
    tags: list[str] = []
    status: Literal["active", "draft", "archived"] = "active"
    version: str = "1.0.0"

    @model_validator(mode="after")
    def validate_fields(self):
        self.name = str(self.name or "").strip()
        self.description = str(self.description or "").strip()
        self.version = str(self.version or "").strip() or "1.0.0"
        self.tags = [item for item in (str(tag or "").strip() for tag in self.tags) if item]
        if not self.name:
            raise ValueError("模板名称不能为空")
        placeholder_keys = [placeholder.key for placeholder in self.placeholders]
        if len(set(placeholder_keys)) != len(placeholder_keys):
            raise ValueError("变量 key 不能重复")
        reference_keys = [reference.key for reference in self.references]
        if len(set(reference_keys)) != len(reference_keys):
            raise ValueError("引用 key 不能重复")
        for placeholder in self.placeholders:
            token = f"{{{{{placeholder.key}}}}}"
            if token not in self.prompts.positive:
                raise ValueError(f"正向提示词缺少变量占位符 {token}")
        return self


class ImageTemplateListResponse(BaseModel):
    items: list[dict[str, object]]


def _actor_label(identity: dict[str, object]) -> str:
    return str(identity.get("name") or identity.get("id") or "管理员").strip() or "管理员"


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-templates")
    async def list_image_templates(request: Request, authorization: Optional[str] = Header(default=None)):
        identity = require_identity(authorization)
        include_disabled = identity.get("role") == "admin"
        items = [
            image_template_service.serialize_item(item, resolve_image_base_url(request))
            for item in image_template_service.list_items(include_disabled=include_disabled)
        ]
        return {"items": items}

    @router.post("/api/image-templates")
    async def create_image_template(
        body: ImageTemplateRequest,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.create_item(body.model_dump(mode="python"), actor=_actor_label(identity))
        base_url = resolve_image_base_url(request)
        return {
            "item": image_template_service.serialize_item(item, base_url),
            "items": [
                image_template_service.serialize_item(current, base_url)
                for current in image_template_service.list_items(include_disabled=True)
            ],
        }

    @router.post("/api/image-templates/{template_id}")
    async def update_image_template(
        template_id: str,
        body: ImageTemplateRequest,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.update_item(template_id, body.model_dump(mode="python"), actor=_actor_label(identity))
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        base_url = resolve_image_base_url(request)
        return {
            "item": image_template_service.serialize_item(item, base_url),
            "items": [
                image_template_service.serialize_item(current, base_url)
                for current in image_template_service.list_items(include_disabled=True)
            ],
        }

    @router.delete("/api/image-templates/{template_id}")
    async def delete_image_template(template_id: str, request: Request, authorization: Optional[str] = Header(default=None)):
        require_admin(authorization)
        if not image_template_service.delete_item(template_id):
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        base_url = resolve_image_base_url(request)
        return {
            "items": [
                image_template_service.serialize_item(current, base_url)
                for current in image_template_service.list_items(include_disabled=True)
            ]
        }

    @router.post("/api/image-templates/{template_id}/assets/{kind}")
    async def upload_image_template_asset(
        template_id: str,
        kind: str,
        request: Request,
        file: UploadFile = File(...),
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.replace_asset(template_id, kind, file.filename or "image.png", file.file)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        item = image_template_service.update_item(template_id, {}, actor=_actor_label(identity)) or item
        base_url = resolve_image_base_url(request)
        return {"item": image_template_service.serialize_item(item, base_url)}

    @router.delete("/api/image-templates/{template_id}/assets/{kind}")
    async def delete_image_template_asset(
        template_id: str,
        kind: str,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.delete_asset(template_id, kind)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        item = image_template_service.update_item(template_id, {}, actor=_actor_label(identity)) or item
        return {"item": image_template_service.serialize_item(item, resolve_image_base_url(request))}

    @router.post("/api/image-templates/{template_id}/references/{reference_key}/asset")
    async def upload_image_template_reference_asset(
        template_id: str,
        reference_key: str,
        request: Request,
        file: UploadFile = File(...),
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.replace_reference_asset(template_id, reference_key, file.filename or "image.png", file.file, actor=_actor_label(identity))
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        return {"item": image_template_service.serialize_item(item, resolve_image_base_url(request))}

    @router.delete("/api/image-templates/{template_id}/references/{reference_key}/asset")
    async def delete_image_template_reference_asset(
        template_id: str,
        reference_key: str,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        identity = require_admin(authorization)
        item = image_template_service.delete_reference_asset(template_id, reference_key, actor=_actor_label(identity))
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        return {"item": image_template_service.serialize_item(item, resolve_image_base_url(request))}

    return router
