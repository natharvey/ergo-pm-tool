"""
routes/template_updates.py — Template update endpoints (mirrors updates.py for projects).

POST /template-updates/interpret — Claude proposes changes to template tasks (no DB writes)
POST /template-updates/apply    — Applies caller-selected actions to template tasks
"""

import os
import base64
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import List, Optional

import anthropic
from pydantic import BaseModel

from backend.database import get_db, TemplateTask
from backend.models import UpdateResponse, TaskAction

router = APIRouter(tags=["template-updates"])

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def get_client():
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not set in .env")
    return anthropic.Anthropic(api_key=api_key)


OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type":      {"type": "string"},
                    "task_id":   {"type": ["integer", "null"]},
                    "field":     {"type": ["string", "null"]},
                    "value":     {"type": ["string", "null"]},
                    "title":     {"type": ["string", "null"]},
                    "owner":     {"type": ["string", "null"]},
                    "section":   {"type": ["string", "null"]},
                    "parent_id": {"type": ["integer", "null"]},
                },
                "required": ["type"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "actions"],
    "additionalProperties": False,
}


def build_prompt(task_list: str, text: str) -> str:
    image_note = (
        "\nThe user has also attached a screenshot or file — analyse it to understand "
        "the template structure and identify any changes needed."
        if not text else ""
    )
    user_update = f"\nUser update:\n{text}" if text else \
        "\n(No text — base your analysis solely on the attached image.)"

    return f"""You are a project management assistant helping to build reusable project templates.{image_note}

Template tasks have: id, title, owner, weeks (duration in weeks), section, and parent_id.
Valid sections: Kick Off, Discovery & Planning, Integrations, Solution Build, User Acceptance Testing, Training, Go-Live.
Hierarchy: top-level tasks (parent_id null), subtasks (parent_id = task id), minitasks (parent_id = subtask id).

Your job is to propose changes to the template. Return ONLY a JSON object — no extra text:

{{
  "summary": "<one or two sentences explaining what you are proposing>",
  "actions": [
    {{
      "type": "update",
      "task_id": <int>,
      "field": "<title|owner|weeks|section|parent_id>",
      "value": "<new value as string>"
    }},
    {{
      "type": "create",
      "title": "<task title>",
      "owner": "<owner or empty string>",
      "section": "<section name or empty>",
      "parent_id": <int or null>
    }}
  ]
}}

Rules:
- Only include tasks that actually need to change or be created.
- For "update" actions, task_id must match an id from the list below.
- field must be one of: title, owner, weeks, section, parent_id.
- value is always a string (e.g. weeks "3", parent_id "12").
- If nothing needs to change, return an empty actions list.

Current template tasks:
{task_list}
{user_update}"""


@router.post("/template-updates/interpret", response_model=UpdateResponse)
async def interpret_template_update(
    template_id: int = Form(...),
    text: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
):
    tasks = db.query(TemplateTask).filter(TemplateTask.template_id == template_id).all()
    if not tasks:
        raise HTTPException(status_code=404, detail="No tasks found for this template")

    task_list = "\n".join(
        f"- id={t.id} | title={t.title!r} | owner={t.owner!r} "
        f"| weeks={t.weeks} | section={t.section!r} | parent_id={t.parent_id}"
        for t in tasks
    )

    image_data = None
    media_type = None
    if file and file.filename:
        mt = file.content_type or ""
        if mt not in SUPPORTED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {mt}")
        image_data = await file.read()
        media_type = mt

    content = []
    if image_data:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type,
                       "data": base64.standard_b64encode(image_data).decode()},
        })
    content.append({"type": "text", "text": build_prompt(task_list, text)})

    response = get_client().messages.create(
        model="claude-opus-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )

    from pydantic import BaseModel as BM
    class _Action(BM):
        type: str
        task_id: Optional[int] = None
        field: Optional[str] = None
        value: Optional[str] = None
        title: Optional[str] = None
        owner: Optional[str] = None
        section: Optional[str] = None
        parent_id: Optional[int] = None

    class _Out(BM):
        summary: str
        actions: List[_Action]

    parsed = _Out.model_validate_json(response.content[0].text)
    proposed = [TaskAction(type=a.type, task_id=a.task_id, field=a.field, value=a.value,
                           title=a.title, owner=a.owner, section=a.section,
                           parent_id=a.parent_id)
                for a in parsed.actions]
    return UpdateResponse(summary=parsed.summary, actions=proposed)


class TemplateApplyRequest(BaseModel):
    template_id: int
    summary: str = ""
    actions: List[TaskAction]


@router.post("/template-updates/apply", response_model=UpdateResponse)
def apply_template_update(payload: TemplateApplyRequest, db: Session = Depends(get_db)):
    applied = []
    for action in payload.actions:
        if action.type == "update":
            task = db.query(TemplateTask).filter(TemplateTask.id == action.task_id).first()
            if not task or not action.field:
                continue
            field, value = action.field, action.value or ""
            if field == "title":       task.title = value
            elif field == "owner":     task.owner = value
            elif field == "weeks":     task.weeks = int(value) if value else None
            elif field == "section":   task.section = value
            elif field == "parent_id": task.parent_id = int(value) if value else None
            else: continue
            applied.append(TaskAction(type="update", task_id=action.task_id,
                                      field=field, value=value))

        elif action.type == "create":
            if not action.title:
                continue
            new_task = TemplateTask(
                template_id=payload.template_id,
                title=action.title,
                owner=action.owner or "",
                weeks=action.weeks,
                section=action.section or "",
                parent_id=action.parent_id,
            )
            db.add(new_task)
            db.flush()
            applied.append(TaskAction(type="create", title=action.title,
                                      owner=action.owner, section=action.section,
                                      parent_id=action.parent_id))

    db.commit()
    n = len(applied)
    return UpdateResponse(summary=payload.summary or f"Applied {n} change{'s' if n != 1 else ''}.",
                          actions=applied)
