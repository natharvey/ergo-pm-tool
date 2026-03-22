"""
models.py — Pydantic schemas for request/response validation.
"""

from pydantic import BaseModel
from typing import Optional, List
from datetime import date


# ── Client schemas ─────────────────────────────────────────────────────────────

class ClientCreate(BaseModel):
    name: str

class ClientUpdate(BaseModel):
    name: str

class ClientOut(BaseModel):
    id: int
    name: str

    model_config = {"from_attributes": True}


# ── Project schemas ────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    template_id: Optional[int] = None
    client_id:   Optional[int] = None


class ProjectUpdate(BaseModel):
    name:      Optional[str] = None
    client_id: Optional[int] = None


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str
    client_id: Optional[int] = None

    model_config = {"from_attributes": True}


# ── Task schemas ───────────────────────────────────────────────────────────────

class TaskCreate(BaseModel):
    title: str
    owner: Optional[str] = ""
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    weeks: Optional[int] = None
    status: Optional[str] = "not_started"
    section: Optional[str] = None
    parent_id: Optional[int] = None   # null = top-level task


class TaskOut(BaseModel):
    id: int
    project_id: int
    title: str
    owner: str
    start_date: Optional[date]
    end_date: Optional[date]
    weeks: Optional[int] = None
    status: str
    section: Optional[str] = None
    parent_id: Optional[int]
    position: Optional[int] = None
    notes: Optional[str] = None

    model_config = {"from_attributes": True}


# ── Task update schema ─────────────────────────────────────────────────────────

class TaskUpdate(BaseModel):
    """All fields optional so partial patches work (e.g. title-only edit)."""
    title:      Optional[str]  = None
    owner:      Optional[str]  = None
    start_date: Optional[date] = None
    end_date:   Optional[date] = None
    weeks:      Optional[int]  = None
    status:     Optional[str]  = None
    section:    Optional[str]  = None
    parent_id:  Optional[int]  = None
    notes:      Optional[str]  = None


# ── Action item schemas ────────────────────────────────────────────────────────

class ActionItemCreate(BaseModel):
    title:       str
    priority:    Optional[str] = "medium"   # low | medium | high
    due_date:    Optional[date] = None
    owner:       Optional[str] = ""
    status:      Optional[str] = "not_started"
    description: Optional[str] = ""


class ActionItemUpdate(BaseModel):
    title:       Optional[str] = None
    priority:    Optional[str] = None
    due_date:    Optional[date] = None
    owner:       Optional[str] = None
    status:      Optional[str] = None
    description: Optional[str] = None


class ActionItemOut(BaseModel):
    id:          int
    task_id:     int
    title:       str
    priority:    str
    due_date:    Optional[date]
    owner:       str
    status:      str
    description: str

    model_config = {"from_attributes": True}


class ActionItemWithContext(ActionItemOut):
    item_title:     str
    sub_item_title: Optional[str] = None


# ── Todo schemas ───────────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    text: str


class TodoUpdate(BaseModel):
    done: Optional[bool] = None
    text: Optional[str] = None


class TodoOut(BaseModel):
    id: int
    task_id: int
    text: str
    done: bool

    model_config = {"from_attributes": True}


# ── Template schemas ───────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    description: Optional[str] = ""


class TemplateOut(BaseModel):
    id: int
    name: str
    description: str

    model_config = {"from_attributes": True}


class TemplateTaskCreate(BaseModel):
    title: str
    owner: Optional[str] = ""
    weeks: Optional[int] = None
    status: Optional[str] = "not_started"
    section: Optional[str] = None
    parent_id: Optional[int] = None


class TemplateTaskUpdate(BaseModel):
    title: Optional[str] = None
    owner: Optional[str] = None
    weeks: Optional[int] = None
    status: Optional[str] = None
    section: Optional[str] = None
    parent_id: Optional[int] = None


class TemplateTaskOut(BaseModel):
    id: int
    template_id: int
    title: str
    owner: str
    weeks: Optional[int] = None
    status: str
    section: Optional[str] = None
    parent_id: Optional[int]
    position: Optional[int] = None

    model_config = {"from_attributes": True}


# ── Update interpretation schemas ─────────────────────────────────────────────

class ReorderRequest(BaseModel):
    ids: List[int]


class UpdateRequest(BaseModel):
    """Plain-English update submitted by the user."""
    project_id: int
    text: str


class TaskAction(BaseModel):
    """
    A single action Claude wants to take. Two types:
      - type="update": modify a field on an existing task
      - type="create": add a brand new task
    """
    type: str                        # "update" | "create"
    # --- update fields ---
    task_id: Optional[int] = None    # required for type=update
    field:   Optional[str] = None    # status | start_date | end_date | owner | title | parent_id
    value:   Optional[str] = None    # new value as string
    # --- create fields ---
    title:      Optional[str] = None
    owner:      Optional[str] = None
    section:    Optional[str] = None
    weeks:      Optional[int] = None
    start_date: Optional[str] = None
    end_date:   Optional[str] = None
    status:     Optional[str] = None
    parent_id:  Optional[int] = None  # set to a task id to create as subtask


class UpdateResponse(BaseModel):
    """The full result of processing a plain-English update."""
    summary: str
    actions: List[TaskAction]
