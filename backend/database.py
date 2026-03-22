"""
database.py — SQLite setup using SQLAlchemy.

Defines the ORM table models and creates the database engine.
All tables are created automatically on startup via create_all().
"""

from sqlalchemy import create_engine, Column, Integer, String, Boolean, Date, ForeignKey, DateTime, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker, relationship, backref
from datetime import datetime

# SQLite file — use /app/data inside Docker, local file otherwise
import os as _os
_db_dir = "/app/data" if _os.path.isdir("/app/data") else "."
DATABASE_URL = f"sqlite:///{_db_dir}/pm_tool.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Client(Base):
    """A client that owns one or more projects."""
    __tablename__ = "clients"

    id         = Column(Integer, primary_key=True, index=True)
    name       = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    projects = relationship("Project", back_populates="client")


class Project(Base):
    """A top-level container for a set of tasks."""
    __tablename__ = "projects"

    id          = Column(Integer, primary_key=True, index=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    client_id   = Column(Integer, ForeignKey("clients.id"), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="projects")
    tasks  = relationship("Task", back_populates="project", cascade="all, delete-orphan")


class Task(Base):
    """An individual work item belonging to a project."""
    __tablename__ = "tasks"

    id         = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    title      = Column(String, nullable=False)
    owner      = Column(String, default="")
    start_date = Column(Date, nullable=True)
    end_date   = Column(Date, nullable=True)
    weeks      = Column(Integer, nullable=True)
    # status values: not_started | in_progress | complete | blocked
    status     = Column(String, default="not_started")
    # section groups tasks under a named phase heading
    section    = Column(String, default="", nullable=True)
    # parent_id is null for top-level tasks; set to another task's id for subtasks
    parent_id  = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    position   = Column(Integer, nullable=True)
    notes      = Column(String, nullable=True)

    project  = relationship("Project", back_populates="tasks")
    # Self-referential: remote_side=[id] tells SQLAlchemy that `id` is the "one" side
    subtasks = relationship("Task", backref=backref("parent", remote_side="Task.id"),
                            foreign_keys=[parent_id])
    todos        = relationship("TodoItem", back_populates="task", cascade="all, delete-orphan")
    action_items = relationship("ActionItem", back_populates="task", cascade="all, delete-orphan")


class TodoItem(Base):
    """A checklist item belonging to a task."""
    __tablename__ = "todos"

    id      = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False)
    text    = Column(String, nullable=False)
    done    = Column(Boolean, default=False, nullable=False)

    task = relationship("Task", back_populates="todos")


class ActionItem(Base):
    """A structured task/action item associated with a project item or sub-item."""
    __tablename__ = "action_items"

    id          = Column(Integer, primary_key=True, index=True)
    task_id     = Column(Integer, ForeignKey("tasks.id"), nullable=False)
    title       = Column(String, nullable=False)
    # priority: low | medium | high
    priority    = Column(String, default="medium")
    due_date    = Column(Date, nullable=True)
    owner       = Column(String, default="")
    # status: not_started | in_progress | complete | blocked
    status      = Column(String, default="not_started")
    description = Column(String, default="")
    created_at  = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="action_items")


class ProjectTemplate(Base):
    """A reusable project template with a predefined set of tasks."""
    __tablename__ = "templates"

    id          = Column(Integer, primary_key=True, index=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")

    tasks = relationship("TemplateTask", back_populates="template", cascade="all, delete-orphan")


class TemplateTask(Base):
    """A task definition belonging to a project template."""
    __tablename__ = "template_tasks"

    id          = Column(Integer, primary_key=True, index=True)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    title       = Column(String, nullable=False)
    owner       = Column(String, default="")
    status      = Column(String, default="not_started")
    weeks       = Column(Integer, nullable=True)
    parent_id   = Column(Integer, ForeignKey("template_tasks.id"), nullable=True)

    section     = Column(String, default="", nullable=True)
    position    = Column(Integer, nullable=True)

    template = relationship("ProjectTemplate", back_populates="tasks")
    subtasks = relationship("TemplateTask", backref=backref("parent", remote_side="TemplateTask.id"),
                            foreign_keys=[parent_id])


def get_db():
    """FastAPI dependency: yields a DB session, closes it when done."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    """Create all tables if they don't already exist, and run any needed migrations."""
    Base.metadata.create_all(bind=engine)
    _migrate()


def _migrate():
    """Add new columns/tables to existing DB without wiping data (safe to run repeatedly)."""
    inspector = inspect(engine)
    existing_cols = {c["name"] for c in inspector.get_columns("tasks")}
    with engine.connect() as conn:
        if "parent_id" not in existing_cols:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id)"))
            conn.commit()
        if "section" not in existing_cols:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN section TEXT DEFAULT ''"))
            conn.commit()
        if "weeks" not in existing_cols:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN weeks INTEGER"))
            conn.commit()
        if "notes" not in existing_cols:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN notes TEXT"))
            conn.commit()
    # Create todos table if it doesn't exist yet (create_all handles new tables)
    Base.metadata.tables["todos"].create(bind=engine, checkfirst=True)
    # Create template tables
    Base.metadata.tables["templates"].create(bind=engine, checkfirst=True)
    Base.metadata.tables["template_tasks"].create(bind=engine, checkfirst=True)
    # Migrate template_tasks table
    inspector2 = inspect(engine)
    tmpl_task_cols = {c["name"] for c in inspector2.get_columns("template_tasks")}
    with engine.connect() as conn:
        if "section" not in tmpl_task_cols:
            conn.execute(text("ALTER TABLE template_tasks ADD COLUMN section TEXT DEFAULT ''"))
            conn.commit()
        if "weeks" not in tmpl_task_cols:
            conn.execute(text("ALTER TABLE template_tasks ADD COLUMN weeks INTEGER"))
            conn.commit()
    # Add position columns for drag-and-drop ordering
    task_cols = {c["name"] for c in inspect(engine).get_columns("tasks")}
    if "position" not in task_cols:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN position INTEGER"))
            conn.execute(text("UPDATE tasks SET position = id * 10"))
            conn.commit()
    tmpl_task_cols2 = {c["name"] for c in inspect(engine).get_columns("template_tasks")}
    if "position" not in tmpl_task_cols2:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE template_tasks ADD COLUMN position INTEGER"))
            conn.execute(text("UPDATE template_tasks SET position = id * 10"))
            conn.commit()
    # Create clients table and add client_id to projects
    Base.metadata.tables["clients"].create(bind=engine, checkfirst=True)
    project_cols = {c["name"] for c in inspect(engine).get_columns("projects")}
    if "client_id" not in project_cols:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN client_id INTEGER REFERENCES clients(id)"))
            conn.commit()
    # Create action_items table if it doesn't exist yet
    Base.metadata.tables["action_items"].create(bind=engine, checkfirst=True)
    # Pre-seed default templates if table is empty
    _seed_templates()


def _seed_templates():
    """Insert default templates if the templates table is empty."""
    db = SessionLocal()
    try:
        if db.query(ProjectTemplate).count() > 0:
            return

        seed_data = [
            {
                "name": "Access",
                "description": "Standard access implementation project",
                "tasks": [
                    {"title": "Discovery & scoping", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Environment setup", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Configuration", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Testing", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Go-live", "owner": "", "status": "not_started", "parent_id": None},
                ],
            },
            {
                "name": "Advocate CARE",
                "description": "Advocate CARE implementation project",
                "tasks": [
                    {"title": "Kickoff & planning", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Data mapping", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Integration setup", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "UAT", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Training", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Go-live", "owner": "", "status": "not_started", "parent_id": None},
                ],
            },
            {
                "name": "Advocate IR",
                "description": "Advocate IR implementation project",
                "tasks": [
                    {"title": "Requirements gathering", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "System configuration", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Integration & testing", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "User acceptance testing", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Go-live & hypercare", "owner": "", "status": "not_started", "parent_id": None},
                ],
            },
            {
                "name": "Advocate Flex",
                "description": "Advocate Flex implementation project",
                "tasks": [
                    {"title": "Scoping & design", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Build & configure", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Testing & QA", "owner": "", "status": "not_started", "parent_id": None},
                    {"title": "Deployment", "owner": "", "status": "not_started", "parent_id": None},
                ],
            },
        ]

        for tmpl_data in seed_data:
            tmpl = ProjectTemplate(name=tmpl_data["name"], description=tmpl_data["description"])
            db.add(tmpl)
            db.flush()  # get tmpl.id
            for task_data in tmpl_data["tasks"]:
                task = TemplateTask(
                    template_id=tmpl.id,
                    title=task_data["title"],
                    owner=task_data["owner"],
                    status=task_data["status"],
                    parent_id=task_data["parent_id"],
                )
                db.add(task)
        db.commit()
    finally:
        db.close()
