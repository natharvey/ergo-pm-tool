"""
routes/projects.py — CRUD endpoints for projects.

POST /projects          — create a new project
GET  /projects          — list all projects
DELETE /projects/{id}   — delete a project (and its tasks)
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from backend.database import get_db, Project, Task, TemplateTask
from backend.models import ProjectCreate, ProjectOut, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=ProjectOut)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    project = Project(name=payload.name, description=payload.description or "", client_id=payload.client_id)
    db.add(project)
    db.commit()
    db.refresh(project)

    # If a template was specified, copy its tasks to this new project
    if payload.template_id:
        template_tasks = (
            db.query(TemplateTask)
            .filter(TemplateTask.template_id == payload.template_id)
            .order_by(TemplateTask.id)
            .all()
        )
        # First pass: create all tasks, build mapping {template_task_id: new_task_id}
        id_map = {}
        for tt in template_tasks:
            new_task = Task(
                project_id=project.id,
                title=tt.title,
                owner=tt.owner or "",
                weeks=tt.weeks,
                status=tt.status or "not_started",
                section=tt.section or "",
                parent_id=None,  # set in second pass
            )
            db.add(new_task)
            db.flush()  # get new_task.id without committing
            id_map[tt.id] = new_task.id

        # Second pass: remap parent_ids using the mapping dict
        for tt in template_tasks:
            if tt.parent_id and tt.parent_id in id_map:
                new_task_id = id_map[tt.id]
                task = db.query(Task).filter(Task.id == new_task_id).first()
                if task:
                    task.parent_id = id_map[tt.parent_id]

        db.commit()

    return project


@router.get("", response_model=List[ProjectOut])
def list_projects(client_id: Optional[int] = Query(default=None), db: Session = Depends(get_db)):
    q = db.query(Project)
    if client_id is not None:
        q = q.filter(Project.client_id == client_id)
    return q.order_by(Project.id).all()


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if payload.name is not None:
        project.name = payload.name
    if payload.client_id is not None:
        project.client_id = payload.client_id
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(project)
    db.commit()
    return {"ok": True}
