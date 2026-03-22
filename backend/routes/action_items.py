"""
routes/action_items.py — CRUD endpoints for action items (tasks on project items).

GET    /tasks/{task_id}/action-items     — list action items for a project item
POST   /tasks/{task_id}/action-items     — create an action item
PUT    /action-items/{id}                — update an action item
DELETE /action-items/{id}               — delete an action item
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import date

from backend.database import get_db, ActionItem, Task
from backend.models import ActionItemCreate, ActionItemUpdate, ActionItemOut, ActionItemWithContext

router = APIRouter(tags=["action_items"])


@router.get("/projects/{project_id}/all-action-items", response_model=List[ActionItemWithContext])
def list_all_action_items(project_id: int, db: Session = Depends(get_db)):
    tasks = db.query(Task).filter(Task.project_id == project_id).all()
    task_map = {t.id: t for t in tasks}
    task_ids = list(task_map.keys())
    if not task_ids:
        return []
    items = db.query(ActionItem).filter(ActionItem.task_id.in_(task_ids)).all()
    result = []
    for item in items:
        task = task_map.get(item.task_id)
        parent = task_map.get(task.parent_id) if task and task.parent_id else None
        result.append(ActionItemWithContext(
            id=item.id,
            task_id=item.task_id,
            title=item.title,
            priority=item.priority,
            due_date=item.due_date,
            owner=item.owner,
            status=item.status,
            description=item.description,
            item_title=parent.title if parent else (task.title if task else ""),
            sub_item_title=task.title if parent else None,
        ))
    return result


@router.get("/tasks/{task_id}/action-items", response_model=List[ActionItemOut])
def list_action_items(task_id: int, db: Session = Depends(get_db)):
    if not db.query(Task).filter(Task.id == task_id).first():
        raise HTTPException(status_code=404, detail="Task not found")
    return db.query(ActionItem).filter(ActionItem.task_id == task_id).order_by(ActionItem.id).all()


@router.post("/tasks/{task_id}/action-items", response_model=ActionItemOut)
def create_action_item(task_id: int, payload: ActionItemCreate, db: Session = Depends(get_db)):
    if not db.query(Task).filter(Task.id == task_id).first():
        raise HTTPException(status_code=404, detail="Task not found")
    item = ActionItem(
        task_id=task_id,
        title=payload.title,
        priority=payload.priority or "medium",
        due_date=payload.due_date,
        owner=payload.owner or "",
        status=payload.status or "not_started",
        description=payload.description or "",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/action-items/{item_id}", response_model=ActionItemOut)
def update_action_item(item_id: int, payload: ActionItemUpdate, db: Session = Depends(get_db)):
    item = db.query(ActionItem).filter(ActionItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Action item not found")
    if payload.title is not None:
        item.title = payload.title
    if payload.priority is not None:
        item.priority = payload.priority
    if payload.due_date is not None:
        item.due_date = payload.due_date
    if payload.owner is not None:
        item.owner = payload.owner
    if payload.status is not None:
        item.status = payload.status
    if payload.description is not None:
        item.description = payload.description
    db.commit()
    db.refresh(item)
    return item


@router.delete("/action-items/{item_id}")
def delete_action_item(item_id: int, db: Session = Depends(get_db)):
    item = db.query(ActionItem).filter(ActionItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Action item not found")
    db.delete(item)
    db.commit()
    return {"ok": True}
