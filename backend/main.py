"""
main.py — FastAPI application entry point.

- Creates the SQLite tables on startup
- Mounts a /static route so FastAPI can serve the frontend files
- Registers all route groups (projects, tasks, updates)
- Enables CORS so the browser can call the API from any origin (dev-friendly)
"""

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from dotenv import load_dotenv

# Load .env file so ANTHROPIC_API_KEY is available before the routes import
load_dotenv()

from backend.database import create_tables
from backend.routes import projects, tasks, updates, todos, templates
from backend.routes import template_updates, action_items, clients

app = FastAPI(title="Ergo API", version="1.0")

# Allow all origins in development; tighten in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routers
app.include_router(projects.router)
app.include_router(tasks.router)
app.include_router(updates.router)
app.include_router(todos.router)
app.include_router(templates.router)
app.include_router(template_updates.router)
app.include_router(action_items.router)
app.include_router(clients.router)

# Serve the frontend as static files under /app
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/app", StaticFiles(directory=frontend_dir, html=True), name="frontend")

@app.get("/")
def root():
    """Serve the frontend with no-cache headers so browsers always fetch fresh HTML."""
    return FileResponse(
        os.path.join(frontend_dir, "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.on_event("startup")
def startup():
    """Create DB tables when the server starts (idempotent)."""
    create_tables()
