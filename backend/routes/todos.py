"""
routes/todos.py — CRUD endpoints for per-task todo items.

POST   /tasks/{task_id}/todos   — add a todo to a task
GET    /tasks/{task_id}/todos   — list todos for a task
PUT    /todos/{todo_id}         — update text or done state
DELETE /todos/{todo_id}         — delete a todo
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from backend.database import get_db, TodoItem, Task
from backend.models import TodoCreate, TodoUpdate, TodoOut

router = APIRouter(tags=["todos"])


@router.post("/tasks/{task_id}/todos", response_model=TodoOut)
def create_todo(task_id: int, payload: TodoCreate, db: Session = Depends(get_db)):
    if not db.query(Task).filter(Task.id == task_id).first():
        raise HTTPException(status_code=404, detail="Task not found")
    todo = TodoItem(task_id=task_id, text=payload.text, done=False)
    db.add(todo)
    db.commit()
    db.refresh(todo)
    return todo


@router.get("/tasks/{task_id}/todos", response_model=List[TodoOut])
def list_todos(task_id: int, db: Session = Depends(get_db)):
    return db.query(TodoItem).filter(TodoItem.task_id == task_id).order_by(TodoItem.id).all()


@router.put("/todos/{todo_id}", response_model=TodoOut)
def update_todo(todo_id: int, payload: TodoUpdate, db: Session = Depends(get_db)):
    todo = db.query(TodoItem).filter(TodoItem.id == todo_id).first()
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if payload.text is not None:
        todo.text = payload.text
    if payload.done is not None:
        todo.done = payload.done
    db.commit()
    db.refresh(todo)
    return todo


@router.delete("/todos/{todo_id}")
def delete_todo(todo_id: int, db: Session = Depends(get_db)):
    todo = db.query(TodoItem).filter(TodoItem.id == todo_id).first()
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    db.delete(todo)
    db.commit()
    return {"ok": True}
