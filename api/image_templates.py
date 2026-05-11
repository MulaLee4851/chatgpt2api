from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, model_validator

from api.support import require_admin, require_identity, resolve_image_base_url
from services.image_template_service import image_template_service


class ImageTemplateRequest(BaseModel):
    name: str = ""
    description: str = ""
    mode: str = "generate"
    prompt_template: str = ""
    default_count: int = Field(default=1, ge=1, le=100)
    default_size: str = ""
    requires_placeholder: bool = False
    placeholder_token: str = "{{prompt}}"
    requires_user_source_image: bool = False
    enabled: bool = True

    @model_validator(mode="after")
    def validate_fields(self):
        self.name = str(self.name or "").strip()
        self.description = str(self.description or "").strip()
        self.prompt_template = str(self.prompt_template or "").strip()
        self.default_size = str(self.default_size or "").strip()
        self.placeholder_token = str(self.placeholder_token or "").strip() or "{{prompt}}"
        self.mode = str(self.mode or "generate").strip() or "generate"
        if self.mode not in {"generate", "edit"}:
            raise ValueError("模板模式不正确")
        if not self.name:
            raise ValueError("模板名称不能为空")
        if not self.prompt_template:
            raise ValueError("模板提示词不能为空")
        if self.requires_placeholder and self.placeholder_token not in self.prompt_template:
            raise ValueError("模板提示词中缺少占位符")
        return self


class ImageTemplateListResponse(BaseModel):
    items: list[dict[str, object]]


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
        require_admin(authorization)
        item = image_template_service.create_item(body.model_dump(mode="python"))
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
        require_admin(authorization)
        item = image_template_service.update_item(template_id, body.model_dump(mode="python"))
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
        require_admin(authorization)
        item = image_template_service.replace_asset(template_id, kind, file.filename or "image.png", file.file)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        base_url = resolve_image_base_url(request)
        return {"item": image_template_service.serialize_item(item, base_url)}

    @router.delete("/api/image-templates/{template_id}/assets/{kind}")
    async def delete_image_template_asset(
        template_id: str,
        kind: str,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        require_admin(authorization)
        item = image_template_service.delete_asset(template_id, kind)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "模板不存在，可能已经被删除"})
        return {"item": image_template_service.serialize_item(item, resolve_image_base_url(request))}

    return router
