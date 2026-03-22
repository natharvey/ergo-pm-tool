"""
routes/templates.py — CRUD endpoints for project templates.

GET    /templates                — list all templates
POST   /templates                — create a template
DELETE /templates/{id}           — delete a template
GET    /templates/{id}/tasks     — list tasks for a template
POST   /templates/{id}/tasks     — add a task to a template
PUT    /template-tasks/{id}      — update a template task
DELETE /template-tasks/{id}      — delete a template task
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import List

from backend.database import get_db, ProjectTemplate, TemplateTask
from backend.models import (
    TemplateCreate, TemplateOut,
    TemplateTaskCreate, TemplateTaskUpdate, TemplateTaskOut, ReorderRequest,
)

router = APIRouter(tags=["templates"])


# ── Templates ──────────────────────────────────────────────────────────────────

@router.get("/templates", response_model=List[TemplateOut])
def list_templates(db: Session = Depends(get_db)):
    return db.query(ProjectTemplate).order_by(ProjectTemplate.id).all()


@router.post("/templates", response_model=TemplateOut)
def create_template(payload: TemplateCreate, db: Session = Depends(get_db)):
    tmpl = ProjectTemplate(name=payload.name, description=payload.description or "")
    db.add(tmpl)
    db.commit()
    db.refresh(tmpl)
    return tmpl


@router.delete("/templates/{template_id}")
def delete_template(template_id: int, db: Session = Depends(get_db)):
    tmpl = db.query(ProjectTemplate).filter(ProjectTemplate.id == template_id).first()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")
    db.delete(tmpl)
    db.commit()
    return {"ok": True}


# ── Template tasks ─────────────────────────────────────────────────────────────

@router.get("/templates/{template_id}/tasks", response_model=List[TemplateTaskOut])
def list_template_tasks(template_id: int, db: Session = Depends(get_db)):
    tmpl = db.query(ProjectTemplate).filter(ProjectTemplate.id == template_id).first()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")
    return db.query(TemplateTask).filter(TemplateTask.template_id == template_id).order_by(text("position ASC NULLS LAST"), TemplateTask.id).all()


@router.post("/templates/{template_id}/tasks", response_model=TemplateTaskOut)
def add_template_task(template_id: int, payload: TemplateTaskCreate, db: Session = Depends(get_db)):
    tmpl = db.query(ProjectTemplate).filter(ProjectTemplate.id == template_id).first()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")
    max_pos = db.query(func.max(TemplateTask.position)).filter(
        TemplateTask.template_id == template_id,
        TemplateTask.parent_id == payload.parent_id,
    ).scalar() or 0
    task = TemplateTask(
        template_id=template_id,
        title=payload.title,
        owner=payload.owner or "",
        weeks=payload.weeks,
        status=payload.status or "not_started",
        section=payload.section or "",
        parent_id=payload.parent_id,
        position=max_pos + 10,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.post("/template-tasks/reorder")
def reorder_template_tasks(payload: ReorderRequest, db: Session = Depends(get_db)):
    for i, task_id in enumerate(payload.ids):
        task = db.query(TemplateTask).filter(TemplateTask.id == task_id).first()
        if task:
            task.position = i * 10
    db.commit()
    return {"ok": True}


@router.put("/template-tasks/{task_id}", response_model=TemplateTaskOut)
def update_template_task(task_id: int, payload: TemplateTaskUpdate, db: Session = Depends(get_db)):
    task = db.query(TemplateTask).filter(TemplateTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Template task not found")
    if payload.title is not None:
        task.title = payload.title
    if payload.owner is not None:
        task.owner = payload.owner
    if payload.weeks is not None:
        task.weeks = payload.weeks
    if payload.status is not None:
        task.status = payload.status
    if payload.section is not None:
        task.section = payload.section
    if payload.parent_id is not None:
        task.parent_id = payload.parent_id
    db.commit()
    db.refresh(task)
    return task


@router.delete("/template-tasks/{task_id}")
def delete_template_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(TemplateTask).filter(TemplateTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Template task not found")
    db.delete(task)
    db.commit()
    return {"ok": True}
