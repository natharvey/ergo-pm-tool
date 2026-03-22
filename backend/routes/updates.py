"""
routes/updates.py — Project update endpoints.

POST /updates/interpret
  - Accepts multipart form: project_id, text (optional), file (optional image)
  - Calls Claude (with vision if image attached)
  - Returns proposed actions WITHOUT applying them

POST /updates/apply
  - Accepts JSON: { project_id, actions }
  - Applies the caller-selected subset of actions to the DB
"""

import os
import base64
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from datetime import date
from typing import List, Optional

import anthropic
from pydantic import BaseModel

from backend.database import get_db, Task
from backend.models import UpdateResponse, TaskAction

router = APIRouter(tags=["updates"])

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def get_client():
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not set in .env")
    return anthropic.Anthropic(api_key=api_key)


# ── Shared Claude output schema ───────────────────────────────────────────────

class ClaudeAction(BaseModel):
    type: str
    task_id: Optional[int] = None
    field: Optional[str] = None
    value: Optional[str] = None
    title: Optional[str] = None
    owner: Optional[str] = None
    weeks: Optional[int] = None
    section: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = None
    parent_id: Optional[int] = None


class ClaudeOutput(BaseModel):
    summary: str
    actions: List[ClaudeAction]


OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type":       {"type": "string"},
                    "task_id":    {"type": ["integer", "null"]},
                    "field":      {"type": ["string", "null"]},
                    "value":      {"type": ["string", "null"]},
                    "title":      {"type": ["string", "null"]},
                    "owner":      {"type": ["string", "null"]},
                    "weeks":      {"type": ["integer", "null"]},
                    "section":    {"type": ["string", "null"]},
                    "start_date": {"type": ["string", "null"]},
                    "end_date":   {"type": ["string", "null"]},
                    "status":     {"type": ["string", "null"]},
                    "parent_id":  {"type": ["integer", "null"]},
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
    has_image = "[image attached]" in text or not text
    image_note = (
        "\nThe user has also attached a screenshot or file — analyse it to understand "
        "the current state of the project and identify any discrepancies or changes needed."
        if has_image else ""
    )
    user_update = f"\nUser update:\n{text}" if text else "\n(No text — base your analysis solely on the attached image.)"
    return f"""You are a project management assistant.{image_note}

Your job is to:
1. Identify existing tasks that need changes based on the user's update and/or attached image.
2. Identify any new tasks or subtasks that should be created.
3. Return ONLY a JSON object matching this exact schema — no extra text:

{{
  "summary": "<one or two sentences explaining what you are proposing>",
  "actions": [
    {{
      "type": "update",
      "task_id": <int>,
      "field": "<status|start_date|end_date|owner|title|weeks|section|parent_id>",
      "value": "<new value as string>"
    }},
    {{
      "type": "create",
      "title": "<task title>",
      "owner": "<owner or empty string>",
      "weeks": <integer duration in weeks, or null>,
      "section": "<section name or empty string>",
      "start_date": "<YYYY-MM-DD or null>",
      "end_date": "<YYYY-MM-DD or null>",
      "status": "<not_started|in_progress|complete|blocked>",
      "parent_id": <parent task id as int, or null for a top-level task>
    }}
  ]
}}

Rules:
- Dates must be in YYYY-MM-DD format, or null if not specified.
- Status must be one of: not_started, in_progress, complete, blocked.
- Only include tasks that actually need to change or be created.
- For "update" actions, task_id must match an id from the task list below.
- For "create" actions, set parent_id to an existing task's id to make it a subtask.
- If nothing needs to change, return an empty actions list.

Current tasks:
{task_list}
{user_update}"""


def call_claude(prompt: str, image_data: Optional[bytes], media_type: Optional[str]) -> ClaudeOutput:
    content = []
    if image_data:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.standard_b64encode(image_data).decode("utf-8"),
            },
        })
    content.append({"type": "text", "text": prompt})

    response = get_client().messages.create(
        model="claude-opus-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    return ClaudeOutput.model_validate_json(response.content[0].text)


def apply_actions(actions: List, project_id: int, db: Session) -> List[TaskAction]:
    """Apply a list of ClaudeAction or TaskAction dicts to the DB. Returns what was applied."""
    applied = []
    for action in actions:
        # Support both Pydantic objects and plain dicts
        a = action if isinstance(action, dict) else action.model_dump()
        atype = a.get("type")

        if atype == "update":
            task = db.query(Task).filter(Task.id == a.get("task_id")).first()
            if not task or not a.get("field"):
                continue
            field, value = a["field"], a.get("value") or ""
            if field == "status":
                task.status = value
            elif field == "start_date":
                task.start_date = date.fromisoformat(value) if value else None
            elif field == "end_date":
                task.end_date = date.fromisoformat(value) if value else None
            elif field == "owner":
                task.owner = value
            elif field == "title":
                task.title = value
            elif field == "weeks":
                task.weeks = int(value) if value else None
            elif field == "section":
                task.section = value
            elif field == "parent_id":
                task.parent_id = int(value) if value else None
            else:
                continue
            applied.append(TaskAction(type="update", task_id=a["task_id"], field=field, value=value))

        elif atype == "create":
            if not a.get("title"):
                continue
            new_task = Task(
                project_id=project_id,
                title=a["title"],
                owner=a.get("owner") or "",
                weeks=a.get("weeks"),
                section=a.get("section") or "",
                start_date=date.fromisoformat(a["start_date"]) if a.get("start_date") else None,
                end_date=date.fromisoformat(a["end_date"]) if a.get("end_date") else None,
                status=a.get("status") or "not_started",
                parent_id=a.get("parent_id"),
            )
            db.add(new_task)
            db.flush()
            applied.append(TaskAction(type="create", title=a["title"], owner=a.get("owner"),
                                      status=a.get("status"), parent_id=a.get("parent_id")))
    db.commit()
    return applied


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/updates/interpret", response_model=UpdateResponse)
async def interpret_update(
    project_id: int = Form(...),
    text: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
):
    """Call Claude to propose changes — does NOT write to the DB."""
    tasks = db.query(Task).filter(Task.project_id == project_id).all()
    if not tasks:
        raise HTTPException(status_code=404, detail="No tasks found for this project")

    task_list = "\n".join(
        f"- id={t.id} | title={t.title!r} | owner={t.owner!r} | weeks={t.weeks}"
        f"| section={t.section!r} | start={t.start_date} | end={t.end_date}"
        f"| status={t.status} | parent_id={t.parent_id}"
        for t in tasks
    )

    image_data = None
    media_type = None
    if file and file.filename:
        mt = file.content_type or ""
        if mt not in SUPPORTED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {mt}. Use JPEG, PNG, GIF or WEBP.")
        image_data = await file.read()
        media_type = mt

    prompt = build_prompt(task_list, text)
    parsed = call_claude(prompt, image_data, media_type)

    # Return proposed actions — nothing written to DB yet
    proposed = [TaskAction(**a.model_dump()) for a in parsed.actions]
    return UpdateResponse(summary=parsed.summary, actions=proposed)


class ApplyRequest(BaseModel):
    project_id: int
    summary: str = ""
    actions: List[TaskAction]


@router.post("/updates/apply", response_model=UpdateResponse)
def apply_update(payload: ApplyRequest, db: Session = Depends(get_db)):
    """Apply the caller-selected subset of proposed actions to the DB."""
    if not db.query(Task).filter(Task.project_id == payload.project_id).first():
        raise HTTPException(status_code=404, detail="Project not found")

    applied = apply_actions(payload.actions, payload.project_id, db)
    n = len(applied)
    summary = payload.summary or f"Applied {n} change{'s' if n != 1 else ''}."
    return UpdateResponse(summary=summary, actions=applied)
