"""
routes/tasks.py — CRUD endpoints for tasks.

POST   /projects/{id}/tasks      — create a task in a project
GET    /projects/{id}/tasks      — list all tasks for a project
PUT    /tasks/{id}               — update a task (any fields)
DELETE /tasks/{id}               — delete a task
"""

import os
import anthropic
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import List
from datetime import date
from pydantic import BaseModel

from backend.database import get_db, Task, Project
from backend.models import TaskCreate, TaskUpdate, TaskOut, ReorderRequest


class NotesCleanRequest(BaseModel):
    notes: str

router = APIRouter(tags=["tasks"])


@router.post("/projects/{project_id}/tasks", response_model=TaskOut)
def create_task(project_id: int, payload: TaskCreate, db: Session = Depends(get_db)):
    # Make sure the parent project exists
    if not db.query(Project).filter(Project.id == project_id).first():
        raise HTTPException(status_code=404, detail="Project not found")

    max_pos = db.query(func.max(Task.position)).filter(
        Task.project_id == project_id,
        Task.parent_id == payload.parent_id,
    ).scalar() or 0

    task = Task(
        project_id=project_id,
        title=payload.title,
        owner=payload.owner or "",
        start_date=payload.start_date,
        end_date=payload.end_date,
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


@router.get("/projects/{project_id}/tasks", response_model=List[TaskOut])
def list_tasks(project_id: int, db: Session = Depends(get_db)):
    return db.query(Task).filter(Task.project_id == project_id).order_by(text("position ASC NULLS LAST"), Task.id).all()


@router.put("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: int, payload: TaskUpdate, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if payload.title is not None:
        task.title = payload.title
    if payload.owner is not None:
        task.owner = payload.owner
    if payload.start_date is not None:
        task.start_date = payload.start_date
    if payload.end_date is not None:
        task.end_date = payload.end_date
    if payload.weeks is not None:
        task.weeks = payload.weeks
    if payload.status is not None:
        task.status = payload.status
    if payload.section is not None:
        task.section = payload.section
    if payload.parent_id is not None:
        task.parent_id = payload.parent_id
    if payload.notes is not None:
        task.notes = payload.notes

    db.commit()
    db.refresh(task)
    return task


@router.post("/tasks/reorder")
def reorder_tasks(payload: ReorderRequest, db: Session = Depends(get_db)):
    for i, task_id in enumerate(payload.ids):
        task = db.query(Task).filter(Task.id == task_id).first()
        if task:
            task.position = i * 10
    db.commit()
    return {"ok": True}


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/notes/clean")
async def clean_task_notes(task_id: int, payload: NotesCleanRequest, db: Session = Depends(get_db)):
    """Send the task's notes to Claude and return a cleaned-up version."""
    if not db.query(Task).filter(Task.id == task_id).first():
        raise HTTPException(status_code=404, detail="Task not found")
    if not payload.notes or not payload.notes.strip():
        raise HTTPException(status_code=400, detail="No notes to clean")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=2048,
        messages=[{
            "role": "user",
            "content": (
                "Clean up and improve the following notes. Keep all key information "
                "but make them clearer, better structured, and more professional. "
                "Return only the cleaned notes text — no preamble, no commentary:\n\n"
                + payload.notes
            ),
        }],
    )
    return {"cleaned": response.content[0].text}
