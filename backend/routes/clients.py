"""
routes/clients.py — CRUD endpoints for clients.

GET    /clients          — list all clients
POST   /clients          — create a client
PUT    /clients/{id}     — rename a client
DELETE /clients/{id}     — delete a client (only if no projects assigned)
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from backend.database import get_db, Client, Project
from backend.models import ClientCreate, ClientUpdate, ClientOut

router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("", response_model=List[ClientOut])
def list_clients(db: Session = Depends(get_db)):
    return db.query(Client).order_by(Client.name).all()


@router.post("", response_model=ClientOut)
def create_client(payload: ClientCreate, db: Session = Depends(get_db)):
    client = Client(name=payload.name)
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


@router.put("/{client_id}", response_model=ClientOut)
def update_client(client_id: int, payload: ClientUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    client.name = payload.name
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}")
def delete_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    has_projects = db.query(Project).filter(Project.client_id == client_id).first()
    if has_projects:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete client with existing projects. Move or delete projects first."
        )
    db.delete(client)
    db.commit()
    return {"ok": True}
