/**
 * app.js — Frontend logic for PM Tool.
 *
 * Talks to the FastAPI backend at /projects, /tasks, /updates.
 * All state is kept server-side; we re-fetch after each mutation.
 */

const API = "";   // Same origin

let currentProjectId = null;
let currentTemplateId = null;
// Track which parent tasks have their subtasks expanded (by task id)
const expandedParents = new Set();
// Track which tasks have their todo panel open (by task id)
const expandedTodos = new Set();
// Cache of todos per task id — populated on demand
const todosCache = {};
// Track which template parent tasks have their subtasks expanded
const expandedTemplateParents = new Set();
var dragId = null;
var dragGroup = null;
var dragIsTemplate = false;

const SECTIONS = [
  "Kick Off",
  "Discovery & Planning",
  "Integrations",
  "Solution Build",
  "User Acceptance Testing",
  "Training",
  "Go-Live",
];


// ── Utility ──────────────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function parseDate(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Check YYYY-MM-DD first — before stripping dashes, otherwise "2025-10-03"
  // becomes "20251003" (8 digits) and gets misread as DDMMYYYY.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const s = trimmed.replace(/[\s/\-\.]/g, "");  // strip spaces, slashes, dashes, dots
  let d, m, y;

  if (/^\d{6}$/.test(s)) {
    // DDMMYY  e.g. 010126 → 2026-01-01
    d = s.slice(0, 2); m = s.slice(2, 4); y = "20" + s.slice(4, 6);
  } else if (/^\d{8}$/.test(s)) {
    // DDMMYYYY  e.g. 01012026 → 2026-01-01
    d = s.slice(0, 2); m = s.slice(2, 4); y = s.slice(4, 8);
  } else {
    return null;  // unrecognised
  }

  return y + "-" + m + "-" + d;
}

function fmt(dateStr) {
  if (!dateStr) return "—";
  var d = new Date(dateStr + "T00:00:00");
  var weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  var day     = d.getDate();
  var month   = d.toLocaleDateString(undefined, { month: "short" });
  var year    = String(d.getFullYear()).slice(2);
  return weekday + " " + day + " " + month + " " + year;
}

function badgeHtml(status) {
  return `<span class="badge badge-${status}">${status.replace("_", " ")}</span>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Given a YYYY-MM-DD start and integer weeks, return the Friday of that span.
// Formula: start + (weeks * 7 - 3)  → works perfectly when start is a Monday.
function calcEndDate(startIso, weeks) {
  if (!startIso || !weeks || weeks < 1) return null;
  var d = new Date(startIso + "T00:00:00");
  d.setDate(d.getDate() + weeks * 7 - 3);
  // Use local date parts — toISOString() shifts to UTC and can give the wrong day
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}


// ── Drag-and-drop reordering ──────────────────────────────────────────────────

function onDragStart(e) {
  var row = e.currentTarget;
  dragId = parseInt(row.dataset.id);
  dragGroup = row.dataset.group;
  dragIsTemplate = row.dataset.isTemplate === "true";
  e.dataTransfer.effectAllowed = "move";
  setTimeout(function() { row.classList.add("dragging"); }, 0);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".drop-above, .drop-below").forEach(function(r) {
    r.classList.remove("drop-above", "drop-below");
  });
}

function onDragOver(e) {
  var row = e.currentTarget;
  if (row.dataset.group !== dragGroup) return;
  e.preventDefault();
  document.querySelectorAll(".drop-above, .drop-below").forEach(function(r) {
    r.classList.remove("drop-above", "drop-below");
  });
  if (parseInt(row.dataset.id) === dragId) return;
  var rect = row.getBoundingClientRect();
  row.classList.add(e.clientY < rect.top + rect.height / 2 ? "drop-above" : "drop-below");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drop-above", "drop-below");
}

function onDrop(e) {
  e.preventDefault();
  var targetRow = e.currentTarget;
  var targetId = parseInt(targetRow.dataset.id);
  document.querySelectorAll(".drop-above, .drop-below").forEach(function(r) {
    r.classList.remove("drop-above", "drop-below");
  });
  if (targetRow.dataset.group !== dragGroup || targetId === dragId) return;

  var rect = targetRow.getBoundingClientRect();
  var insertAfter = e.clientY >= rect.top + rect.height / 2;

  var groupRows = Array.from(document.querySelectorAll("tr[data-id]")).filter(function(r) {
    return r.dataset.group === dragGroup;
  });
  var ids = groupRows.map(function(r) { return parseInt(r.dataset.id); });

  var fromIdx = ids.indexOf(dragId);
  ids.splice(fromIdx, 1);
  var targetIdx = ids.indexOf(targetId);
  ids.splice(insertAfter ? targetIdx + 1 : targetIdx, 0, dragId);

  var endpoint = dragIsTemplate ? "/template-tasks/reorder" : "/tasks/reorder";
  api("POST", endpoint, { ids: ids }).then(function() {
    if (dragIsTemplate) loadTemplateTasks();
    else loadTasks();
  }).catch(function(err) {
    alert("Error saving order: " + err.message);
  });
}

// ── Clients ───────────────────────────────────────────────────────────────────

let currentClientId = null;

async function loadClients() {
  const clients = await api("GET", "/clients");
  const sel = document.getElementById("client-select");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select a client —</option>';
  clients.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
  if (prev && clients.find(c => c.id == prev)) {
    sel.value = prev;
  }
}

async function selectClient(id) {
  currentClientId = id ? Number(id) : null;
  const hasClient = !!currentClientId;
  document.getElementById("project-section").style.display      = hasClient ? "block" : "none";
  document.getElementById("btn-rename-client").style.display    = hasClient ? "" : "none";
  document.getElementById("btn-delete-client").style.display    = hasClient ? "" : "none";
  // Reset project selection
  currentProjectId = null;
  document.getElementById("tasks-card").style.display       = "none";
  document.getElementById("update-card").style.display      = "none";
  document.getElementById("manual-task-card").style.display = "none";
  document.getElementById("btn-delete-project").style.display = "none";
  hideCreateProject();
  if (hasClient) await loadProjects();
}

function showCreateClient() {
  document.getElementById("new-client-form").style.display = "block";
  document.getElementById("new-client-name").focus();
}
function hideCreateClient() {
  document.getElementById("new-client-form").style.display = "none";
  document.getElementById("new-client-name").value = "";
}

async function createClient() {
  const name = document.getElementById("new-client-name").value.trim();
  if (!name) return alert("Client name is required.");
  const c = await api("POST", "/clients", { name });
  hideCreateClient();
  await loadClients();
  document.getElementById("client-select").value = c.id;
  await selectClient(c.id);
}

async function renameCurrentClient() {
  if (!currentClientId) return;
  const sel = document.getElementById("client-select");
  const current = sel.options[sel.selectedIndex].textContent;
  const newName = prompt("Rename client:", current);
  if (!newName || newName.trim() === current.trim()) return;
  await api("PUT", `/clients/${currentClientId}`, { name: newName.trim() });
  await loadClients();
  document.getElementById("client-select").value = currentClientId;
}

async function deleteCurrentClient() {
  if (!currentClientId) return;
  const sel = document.getElementById("client-select");
  const name = sel.options[sel.selectedIndex].textContent;
  const entered = prompt(`Type the client name to confirm deletion:\n\n"${name}"`);
  if (entered === null) return;
  if (entered.trim() !== name.trim()) {
    alert("Client name did not match. Deletion cancelled.");
    return;
  }
  try {
    await api("DELETE", `/clients/${currentClientId}`);
  } catch (e) {
    alert(e.message);
    return;
  }
  currentClientId = null;
  document.getElementById("project-section").style.display   = "none";
  document.getElementById("btn-rename-client").style.display = "none";
  document.getElementById("btn-delete-client").style.display = "none";
  await loadClients();
}


// ── Projects ──────────────────────────────────────────────────────────────────

async function loadProjects() {
  const url = currentClientId ? `/projects?client_id=${currentClientId}` : "/projects";
  const projects = await api("GET", url);
  const sel = document.getElementById("project-select");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select a project —</option>';
  projects.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (prev && projects.find(p => p.id == prev)) sel.value = prev;
}

function showCreateProject() {
  document.getElementById("new-project-form").style.display = "block";
  document.getElementById("new-project-name").focus();
}
function hideCreateProject() {
  document.getElementById("new-project-form").style.display = "none";
  document.getElementById("new-project-name").value = "";
  document.getElementById("new-project-desc").value = "";
}

async function createProject() {
  const name = document.getElementById("new-project-name").value.trim();
  const description = document.getElementById("new-project-desc").value.trim();
  const templateIdRaw = document.getElementById("new-project-template").value;
  const template_id = templateIdRaw ? Number(templateIdRaw) : null;
  if (!name) return alert("Project name is required.");
  const p = await api("POST", "/projects", { name, description, template_id, client_id: currentClientId });
  hideCreateProject();
  await loadProjects();
  document.getElementById("project-select").value = p.id;
  await selectProject(p.id);
}

async function deleteCurrentProject() {
  if (!currentProjectId) return;
  const project = (await api("GET", "/projects")).find(p => p.id === currentProjectId);
  if (!project) return;
  const entered = prompt(`Type the project name to confirm deletion:\n\n"${project.name}"`);
  if (entered === null) return;  // cancelled
  if (entered.trim() !== project.name.trim()) {
    alert("Project name did not match. Deletion cancelled.");
    return;
  }
  await api("DELETE", `/projects/${currentProjectId}`);
  currentProjectId = null;
  await loadProjects();
  document.getElementById("tasks-card").style.display = "none";
  document.getElementById("update-card").style.display = "none";
  document.getElementById("manual-task-card").style.display = "none";
  document.getElementById("btn-delete-project").style.display = "none";
}

async function selectProject(id) {
  currentProjectId = id ? Number(id) : null;
  const hasPrj = !!currentProjectId;
  document.getElementById("tasks-card").style.display        = hasPrj ? "block" : "none";
  document.getElementById("update-card").style.display       = hasPrj ? "block" : "none";
  document.getElementById("manual-task-card").style.display  = hasPrj ? "block" : "none";
  document.getElementById("btn-delete-project").style.display = hasPrj ? "inline-flex" : "none";
  // Collapse the manual form when switching projects
  document.getElementById("manual-task-form").style.display = "none";
  document.getElementById("btn-manual-task-toggle").textContent = "+ Add item manually";
  expandedParents.clear();
  expandedTodos.clear();
  Object.keys(todosCache).forEach(k => delete todosCache[k]);
  if (hasPrj) await loadTasks();
}

document.getElementById("project-select").addEventListener("change", e => {
  selectProject(e.target.value);
});


// ── Tasks ─────────────────────────────────────────────────────────────────────

async function loadTasks() {
  if (!currentProjectId) return;
  const tasks = await api("GET", `/projects/${currentProjectId}/tasks`);
  currentTasks = tasks;
  renderTasks(tasks);
  populateParentSelector(tasks);
  _updateOwnerSuggestions(tasks);
}

function _updateOwnerSuggestions(tasks) {
  var owners = [];
  tasks.forEach(function(t) {
    if (t.owner && t.owner.trim() && !owners.includes(t.owner.trim())) {
      owners.push(t.owner.trim());
    }
  });
  owners.sort();
  var dl = document.getElementById("owner-suggestions");
  if (!dl) return;
  dl.innerHTML = owners.map(function(o) {
    return '<option value="' + escHtml(o) + '">';
  }).join("");
}

function populateParentSelector(tasks) {
  var sel = document.getElementById("task-parent");
  var prev = sel.value;
  sel.innerHTML = "<option value=\"\">No parent (top-level task)</option>";

  // Compute depth for each task
  var depthMap = {};
  var idMap = {};
  tasks.forEach(function(t) { idMap[t.id] = t; });
  function getDepth(t) {
    if (depthMap[t.id] !== undefined) return depthMap[t.id];
    if (!t.parent_id) { depthMap[t.id] = 0; return 0; }
    var parent = idMap[t.parent_id];
    depthMap[t.id] = parent ? getDepth(parent) + 1 : 0;
    return depthMap[t.id];
  }
  tasks.forEach(function(t) { getDepth(t); });

  // Show depth-0 (top-level items) only — sub-items cannot be parents
  tasks.filter(function(t) { return depthMap[t.id] === 0; }).forEach(function(t) {
    var opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = "#" + t.id + " " + t.title;
    sel.appendChild(opt);
  });

  if (prev) sel.value = prev;
}

// Re-filter the parent dropdown based on the currently selected section
function filterParentsBySection() {
  var section = document.getElementById("task-section").value;
  var sel = document.getElementById("task-parent");
  sel.innerHTML = "<option value=\"\">No parent (top-level task)</option>";

  if (!currentTasks.length) return;

  // Build depth + id maps
  var idMap = {};
  currentTasks.forEach(function(t) { idMap[t.id] = t; });
  var depthMap = {};
  function getDepth(t) {
    if (depthMap[t.id] !== undefined) return depthMap[t.id];
    if (!t.parent_id) { depthMap[t.id] = 0; return 0; }
    var par = idMap[t.parent_id];
    depthMap[t.id] = par ? getDepth(par) + 1 : 0;
    return depthMap[t.id];
  }
  currentTasks.forEach(function(t) { getDepth(t); });

  var candidates;
  if (!section) {
    // No section chosen — show everything up to depth 1
    candidates = currentTasks.filter(function(t) { return depthMap[t.id] < 2; });
  } else {
    // Top-level tasks in this section
    var topInSection = currentTasks.filter(function(t) {
      return depthMap[t.id] === 0 && t.section === section;
    });
    var topIds = new Set(topInSection.map(function(t) { return t.id; }));
    // Their direct subtasks (depth 1)
    var subsInSection = currentTasks.filter(function(t) {
      return depthMap[t.id] === 1 && topIds.has(t.parent_id);
    });
    candidates = topInSection.concat(subsInSection);
  }

  candidates.forEach(function(t) {
    var opt = document.createElement("option");
    opt.value = t.id;
    var indent = depthMap[t.id] === 1 ? "  \u21b3 " : "";
    opt.textContent = indent + "#" + t.id + " " + t.title;
    sel.appendChild(opt);
  });
}

function todoBtnHtml(taskId) {
  const cached = todosCache[taskId] || [];
  const total = cached.length;
  const done = cached.filter(t => t.done).length;
  const label = total ? ("☑ " + done + "/" + total) : "☑ todos";
  const cls = "btn-todos" + (total ? " has-todos" : "");
  return '<button class="' + cls + '" onclick="toggleTodos(' + taskId + ')" title="To-dos">' + label + "</button>";
}

function projectTaskRowHtml(task, num, level, parentId, hasChildren, isExpanded) {
  var trClass = level >= 1 ? "subtask-row" : "task-row";

  var expandBtn = "";
  if (level === 0 && hasChildren) {
    expandBtn = "<button class=\"btn-expand" + (isExpanded ? " expanded" : "") + "\" onclick=\"toggleTaskExpand(" + task.id + ")\" title=\"" + (isExpanded ? "Collapse sub-items" : "Expand sub-items") + "\">" + (isExpanded ? "&#9660;" : "&#9654;") + "</button> ";
  }

  var titleCell;
  if (level === 0) {
    titleCell = "<div class=\"title-cell-wrap\">"
      + expandBtn
      + "<span class=\"editable-title\" onclick=\"startEditTask(event," + task.id + ")\">" + escHtml(task.title) + "</span>"
      + "</div>";
  } else {
    titleCell = "<span class=\"subtask-indent\"><span class=\"editable-title\" onclick=\"startEditTask(event," + task.id + ")\">" + escHtml(task.title) + "</span></span>";
  }

  var weeks = task.weeks != null ? task.weeks : "";
  var group = parentId ? "p:" + parentId : "s:" + (task.section || "");
  return "<tr data-id=\"" + task.id + "\""
    + " data-group=\"" + escHtml(group) + "\""
    + " data-is-template=\"false\""
    + " draggable=\"true\""
    + " ondragstart=\"onDragStart(event)\""
    + " ondragover=\"onDragOver(event)\""
    + " ondragleave=\"onDragLeave(event)\""
    + " ondrop=\"onDrop(event)\""
    + " ondragend=\"onDragEnd(event)\""
    + (parentId ? " data-parent=\"" + parentId + "\"" : "")
    + " class=\"" + trClass + "\">"
    + "<td>" + escHtml(String(num)) + "</td>"
    + "<td>" + titleCell + "</td>"
    + (level === 0
        ? "<td><span class=\"editable-val\" onclick=\"startEditField(event," + task.id + ",'weeks')\">" + (weeks !== "" ? weeks : "—") + "</span></td>"
          + "<td style=\"white-space:nowrap\"><span class=\"editable-val\" onclick=\"startEditField(event," + task.id + ",'start_date')\">" + fmt(task.start_date) + "</span></td>"
          + "<td style=\"white-space:nowrap\"><span class=\"editable-val\" onclick=\"startEditField(event," + task.id + ",'end_date')\">" + fmt(task.end_date) + "</span></td>"
        : "<td></td><td></td><td></td>")
    + "<td><span class=\"editable-val\" onclick=\"startEditField(event," + task.id + ",'owner')\">" + escHtml(task.owner || "—") + "</span></td>"
    + "<td><span class=\"editable-val\" onclick=\"startEditField(event," + task.id + ",'status')\">" + badgeHtml(task.status) + "</span></td>"
    + "<td style=\"white-space:nowrap;text-align:right\">"
    + "<button class=\"btn-add-inline\" onclick=\"showTypeMenu(event," + task.id + "," + level + ")\" title=\"Add item below\">&#43;</button>"
    + "<button class=\"btn-edit-tmpl\" onclick=\"toggleProjEditPanel(" + task.id + ")\" title=\"Edit\">&#9998;</button>"
    + "<button class=\"btn-task-action\" onclick=\"openTasksPanel(" + task.id + ")\" title=\"Tasks\">&#10003;</button>"
    + "<button class=\"btn-notes" + (task.notes ? " has-notes" : "") + "\" onclick=\"openNotes(" + task.id + ")\" title=\"Notes\">&#128221;</button> "
    + "<button class=\"btn-danger\" onclick=\"deleteTask(" + task.id + ")\">&#10005;</button>"
    + "</td>"
    + "</tr>"
    + projEditPanelHtml(task);
}

function renderTasks(tasks) {
  var tbody = document.getElementById("task-tbody");

  if (!tasks.length) {
    tbody.innerHTML = "<tr><td colspan=\"8\" class=\"empty\">No items yet — add one below.</td></tr>";
    return;
  }

  // Build a map of all children (any level)
  var childrenMap = {};
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.parent_id) {
      if (!childrenMap[t.parent_id]) childrenMap[t.parent_id] = [];
      childrenMap[t.parent_id].push(t);
    }
  }

  // Top-level tasks only
  var topLevel = tasks.filter(function(t) { return !t.parent_id; });

  // Group top-level tasks by section — preserving order of first appearance
  var customBuckets = {};
  var customOrder = [];
  var unsectionedBucket = { name: "", tasks: [] };
  for (var ti = 0; ti < topLevel.length; ti++) {
    var sec = topLevel[ti].section || "";
    if (!sec) {
      unsectionedBucket.tasks.push(topLevel[ti]);
    } else {
      if (!customBuckets[sec]) { customBuckets[sec] = { name: sec, tasks: [] }; customOrder.push(sec); }
      customBuckets[sec].tasks.push(topLevel[ti]);
    }
  }
  var activeBuckets = customOrder.map(function(s) { return customBuckets[s]; });
  if (unsectionedBucket.tasks.length > 0) activeBuckets.push(unsectionedBucket);

  var rows = [];

  function renderLevel(taskList, prefix, level, parentId) {
    for (var i = 0; i < taskList.length; i++) {
      var task = taskList[i];
      var num = prefix ? prefix + "." + (i + 1) : String(i + 1);
      var children = childrenMap[task.id] || [];
      var hasChildren = children.length > 0;
      var isExpanded = expandedParents.has(task.id);
      rows.push(projectTaskRowHtml(task, num, level, parentId, hasChildren, isExpanded));
      // Only top-level items (level 0) can expand to show sub-items; no deeper nesting
      if (level === 0 && hasChildren && isExpanded) {
        renderLevel(children, num, level + 1, task.id);
      }
    }
  }

  for (var ai = 0; ai < activeBuckets.length; ai++) {
    var bucket = activeBuckets[ai];
    rows.push("<tr class=\"section-header-row\"><td colspan=\"8\">" + escHtml(bucket.name) + "</td></tr>");
    renderLevel(bucket.tasks, "", 0, null);
  }

  tbody.innerHTML = rows.join("");
}


function toggleTaskExpand(taskId) {
  if (expandedParents.has(taskId)) {
    expandedParents.delete(taskId);
  } else {
    expandedParents.add(taskId);
  }
  renderTasks(currentTasks);
}


// ── Inline add (+ button) ─────────────────────────────────────────────────────

var _inlineMenu = null;

function showTypeMenu(event, taskId, level) {
  event.stopPropagation();
  closeTypeMenu();
  cancelInlineAdd();

  // Sub-item row: skip the menu, just add another sub-item below
  if (level >= 1) {
    insertInlineRow(taskId, "subitem-sibling", level);
    return;
  }

  var btn  = event.currentTarget;
  var rect = btn.getBoundingClientRect();

  var menu = document.createElement("div");
  menu.className = "inline-type-menu";

  var choices = [{ label: "Item", type: "item" }, { label: "Sub-item", type: "subitem" }];

  menu.innerHTML = choices.map(function(c) {
    return "<button class=\"inline-type-btn\" data-type=\"" + c.type + "\">" + c.label + "</button>";
  }).join("");

  menu.style.top  = (rect.bottom + window.scrollY + 6) + "px";
  menu.style.left = rect.left + "px";
  document.body.appendChild(menu);
  _inlineMenu = menu;

  menu.querySelectorAll(".inline-type-btn").forEach(function(b) {
    b.addEventListener("click", function(e) {
      e.stopPropagation();
      var type = b.dataset.type;
      closeTypeMenu();
      insertInlineRow(taskId, type, level);
    });
  });

  setTimeout(function() {
    document.addEventListener("click", closeTypeMenu, { once: true });
  }, 0);
}

function closeTypeMenu() {
  if (_inlineMenu) { _inlineMenu.remove(); _inlineMenu = null; }
}

function insertInlineRow(taskId, type, clickedLevel) {
  cancelInlineAdd();

  var task    = currentTasks.find(function(t) { return t.id === taskId; });
  var section = task ? (task.section || "") : "";
  var parentId = null;

  if (type === "subitem") {
    parentId = taskId;
    // Expand the parent so children are visible
    if (!expandedParents.has(taskId)) {
      expandedParents.add(taskId);
      renderTasks(currentTasks);
    }
  } else if (type === "subitem-sibling") {
    // Add a sub-item under the same parent as the clicked sub-item
    parentId = task ? task.parent_id : null;
    type = "subitem";
  } else if (clickedLevel >= 1 && task && task.parent_id) {
    // "Item" clicked on a sub-item → same section as the parent item
    var parent = currentTasks.find(function(t) { return t.id === task.parent_id; });
    section = parent ? (parent.section || "") : section;
  }

  // Find the last <tr> that belongs to this task (itself + any visible children)
  var afterRow = _lastRowForTask(taskId);
  if (!afterRow) return;

  var rowClass = type === "subitem" ? "subtask-row" : "task-row";
  var placeholder = type === "subitem" ? "Sub-item title…" : "Item title…";

  var tr = document.createElement("tr");
  tr.id        = "inline-add-row";
  tr.className = rowClass;
  tr.innerHTML = "<td></td>"
    + "<td colspan=\"6\"><input id=\"inline-add-input\" class=\"inline-add-input\" placeholder=\"" + placeholder + "\" /></td>"
    + "<td style=\"white-space:nowrap;text-align:right\">"
    + "<button class=\"btn-primary\" style=\"padding:.22rem .55rem;font-size:.78rem\" "
    +   "onclick=\"submitInlineAdd(" + taskId + ",'" + type + "'," + (parentId || "null") + ",'" + section.replace(/'/g, "\\'") + "')\">Add</button>"
    + "<button class=\"btn-outline\"  style=\"padding:.22rem .55rem;font-size:.78rem;margin-left:.3rem\" "
    +   "onclick=\"cancelInlineAdd()\">✕</button>"
    + "</td>";

  afterRow.insertAdjacentElement("afterend", tr);

  var input = document.getElementById("inline-add-input");
  input.focus();
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter")  submitInlineAdd(taskId, type, parentId, section);
    if (e.key === "Escape") cancelInlineAdd();
  });
}

function _lastRowForTask(taskId) {
  var rows = Array.from(document.querySelectorAll("#task-tbody tr[data-id]"));
  var result = null;
  var inTask = false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.dataset.id == taskId) { result = r; inTask = true; }
    else if (inTask && r.dataset.parent == taskId) { result = r; }
    else if (inTask) { break; }
  }
  return result;
}

function cancelInlineAdd() {
  var row = document.getElementById("inline-add-row");
  if (row) row.remove();
}

async function submitInlineAdd(afterTaskId, type, parentId, section) {
  var input = document.getElementById("inline-add-input");
  var title = input ? input.value.trim() : "";
  if (!title) { input && input.focus(); return; }

  var newTask = await api("POST", "/projects/" + currentProjectId + "/tasks", {
    title:     title,
    section:   section,
    parent_id: parentId || null,
    status:    "not_started",
  });

  if (parentId) expandedParents.add(parentId);
  cancelInlineAdd();

  // Reorder: move newTask to immediately after afterTaskId and all its descendants
  var tasks = await api("GET", "/projects/" + currentProjectId + "/tasks");
  var ids = tasks.map(function(t) { return t.id; });

  // Remove newTask from the end (where it was appended)
  var newIdx = ids.indexOf(newTask.id);
  if (newIdx !== -1) ids.splice(newIdx, 1);

  // Find insertion point: after afterTaskId and all its descendants
  var insertAfter = ids.indexOf(afterTaskId);
  if (insertAfter !== -1) {
    var last = insertAfter;
    for (var i = insertAfter + 1; i < ids.length; i++) {
      var t = tasks.find(function(x) { return x.id === ids[i]; });
      if (t && _isDescendantOf(t, afterTaskId, tasks)) { last = i; } else { break; }
    }
    ids.splice(last + 1, 0, newTask.id);
    await api("POST", "/tasks/reorder", { ids: ids });
  }

  await loadTasks();
}

function _isDescendantOf(task, ancestorId, tasks) {
  if (!task.parent_id) return false;
  if (task.parent_id === ancestorId) return true;
  var parent = tasks.find(function(t) { return t.id === task.parent_id; });
  return parent ? _isDescendantOf(parent, ancestorId, tasks) : false;
}


// ── Todos ─────────────────────────────────────────────────────────────────────

function renderTodoPanelHtml(taskId, todos) {
  const items = todos.map(t => `
    <li class="todo-item${t.done ? " done" : ""}" data-todo-id="${t.id}">
      <input type="checkbox" id="todo-${t.id}" ${t.done ? "checked" : ""}
             onchange="toggleTodoDone(${taskId}, ${t.id}, this.checked)" />
      <label for="todo-${t.id}">${escHtml(t.text)}</label>
      <button class="btn-edit-todo" onclick="startEditTodo(event,${t.id},${taskId})" title="Edit">✎</button>
      <button class="btn-del-todo" onclick="deleteTodo(${taskId}, ${t.id})" title="Remove">✕</button>
    </li>`).join("");

  return `
    <ul class="todo-list">${items || '<li style="color:#9ca3af;font-size:.82rem">No to-dos yet.</li>'}</ul>
    <div class="todo-add-row">
      <input id="todo-input-${taskId}" type="text" placeholder="Add a to-do…"
             onkeydown="if(event.key==='Enter') addTodo(${taskId})" />
      <button onclick="addTodo(${taskId})">+ Add</button>
    </div>`;
}

async function toggleTodos(taskId) {
  if (expandedTodos.has(taskId)) {
    expandedTodos.delete(taskId);
    document.querySelectorAll(`tr[data-todo-panel="${taskId}"]`).forEach(r => r.classList.add("hidden"));
  } else {
    // Fetch todos if not cached
    if (!todosCache[taskId]) {
      todosCache[taskId] = await api("GET", `/tasks/${taskId}/todos`);
    }
    expandedTodos.add(taskId);
    // Re-render panel content with loaded todos then show
    document.querySelectorAll(`tr[data-todo-panel="${taskId}"]`).forEach(r => {
      r.querySelector("td").innerHTML = renderTodoPanelHtml(taskId, todosCache[taskId]);
      r.classList.remove("hidden");
    });
  }
}

async function addTodo(taskId) {
  const input = document.getElementById(`todo-input-${taskId}`);
  const text = input.value.trim();
  if (!text) return;
  const todo = await api("POST", `/tasks/${taskId}/todos`, { text });
  if (!todosCache[taskId]) todosCache[taskId] = [];
  todosCache[taskId].push(todo);
  input.value = "";
  _refreshTodoPanel(taskId);
}

async function toggleTodoDone(taskId, todoId, done) {
  const todo = await api("PUT", `/todos/${todoId}`, { done });
  if (todosCache[taskId]) {
    const idx = todosCache[taskId].findIndex(t => t.id === todoId);
    if (idx !== -1) todosCache[taskId][idx] = todo;
  }
  _refreshTodoPanel(taskId);
}

async function deleteTodo(taskId, todoId) {
  await api("DELETE", `/todos/${todoId}`);
  if (todosCache[taskId]) {
    todosCache[taskId] = todosCache[taskId].filter(t => t.id !== todoId);
  }
  _refreshTodoPanel(taskId);
}

function _refreshTodoPanel(taskId) {
  const todos = todosCache[taskId] || [];
  // Update the panel content
  document.querySelectorAll(`tr[data-todo-panel="${taskId}"] td`).forEach(td => {
    td.innerHTML = renderTodoPanelHtml(taskId, todos);
  });
  // Update the todo button label/style
  const todoCount = todos.length;
  const doneTodos = todos.filter(t => t.done).length;
  document.querySelectorAll(`tr[data-id="${taskId}"] .btn-todos`).forEach(btn => {
    btn.textContent = todoCount ? `☑ ${doneTodos}/${todoCount}` : `☑ todos`;
    btn.className = `btn-todos${todoCount ? " has-todos" : ""}`;
  });
}


// ── Inline editing ────────────────────────────────────────────────────────────

function startEditTask(event, taskId) {
  const span = event.currentTarget;
  const original = span.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.value = original;
  input.className = "inline-edit-input";
  input.onblur = async function() {
    const val = input.value.trim();
    input.remove();
    span.style.display = "";
    if (val && val !== original) {
      await api("PUT", "/tasks/" + taskId, { title: val });
      await loadTasks();
    }
  };
  input.onkeydown = function(e) {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.remove(); span.style.display = ""; }
  };
  span.style.display = "none";
  span.parentNode.insertBefore(input, span);
  input.focus();
  input.select();
}

// Generic click-to-edit for project task cells (weeks, owner, dates, status)
function startEditField(event, taskId, field) {
  var span = event.currentTarget;
  var task = currentTasks.find(function(t) { return t.id === taskId; });
  if (!task) return;

  // Status uses a <select> inline
  if (field === "status") {
    var sel = document.createElement("select");
    sel.innerHTML = ["not_started","in_progress","complete","blocked"].map(function(s) {
      return "<option value=\"" + s + "\"" + (s === task.status ? " selected" : "") + ">" + s.replace("_"," ") + "</option>";
    }).join("");
    sel.className = "inline-edit-input";
    var commit = async function() {
      var val = sel.value;
      sel.remove(); span.style.display = "";
      if (val !== task.status) { await api("PUT", "/tasks/" + taskId, { status: val }); await loadTasks(); }
    };
    sel.onchange = commit;
    sel.onkeydown = function(e) {
      if (e.key === "Escape") { sel.remove(); span.style.display = ""; }
    };
    span.style.display = "none";
    span.parentNode.insertBefore(sel, span);
    sel.focus();
    return;
  }

  var input = document.createElement("input");
  input.className = "inline-edit-input";

  if (field === "weeks") {
    input.type = "number"; input.min = "0"; input.style.width = "60px";
    input.value = task.weeks != null ? task.weeks : "";
  } else if (field === "owner") {
    input.type = "text"; input.style.width = "100px";
    input.setAttribute("list", "owner-suggestions");
    input.value = task.owner || "";
  } else if (field === "start_date" || field === "end_date") {
    input.type = "text"; input.style.width = "110px";
    input.placeholder = "DDMMYY";
    input.value = field === "start_date" ? (task.start_date || "") : (task.end_date || "");
  }

  input.onblur = async function() {
    var raw = input.value.trim();
    input.remove(); span.style.display = "";
    var payload = {};
    if (field === "weeks") {
      var n = raw ? Number(raw) : null;
      if (n === task.weeks) return;
      payload.weeks = n;
    } else if (field === "owner") {
      if (raw === (task.owner || "")) return;
      payload.owner = raw;
    } else {
      var parsed = raw ? parseDate(raw) : null;
      if (raw && !parsed) { alert("Unrecognised date. Use DDMMYY or YYYY-MM-DD."); return; }
      var cur = field === "start_date" ? task.start_date : task.end_date;
      if (parsed === cur) return;
      payload[field] = parsed;
    }
    // Auto-calculate end date when start_date or weeks changes
    if (field === "start_date" && payload.start_date && task.weeks) {
      payload.end_date = calcEndDate(payload.start_date, task.weeks);
    }
    if (field === "weeks" && payload.weeks && task.start_date) {
      payload.end_date = calcEndDate(task.start_date, payload.weeks);
    }
    if (Object.keys(payload).length) { await api("PUT", "/tasks/" + taskId, payload); await loadTasks(); }
  };
  input.onkeydown = function(e) {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.remove(); span.style.display = ""; }
  };
  span.style.display = "none";
  span.parentNode.insertBefore(input, span);
  input.focus();
  input.select();
}

// Full edit panel for project tasks (all fields at once)
function projEditPanelHtml(task) {
  var sectionOptions = [""].concat(SECTIONS).concat(
    currentTasks.map(function(t) { return t.section; })
      .filter(function(s, i, a) { return s && !SECTIONS.includes(s) && a.indexOf(s) === i; })
  ).map(function(s) {
    var sel = s === (task.section || "") ? " selected" : "";
    return "<option value=\"" + escHtml(s) + "\"" + sel + ">" + escHtml(s || "No section") + "</option>";
  }).join("");

  var statusOptions = ["not_started","in_progress","complete","blocked"].map(function(s) {
    return "<option value=\"" + s + "\"" + (s === task.status ? " selected" : "") + ">" + s.replace("_"," ") + "</option>";
  }).join("");

  return "<tr class=\"proj-edit-panel-row hidden\" data-edit-panel=\"" + task.id + "\">"
    + "<td colspan=\"8\"><div class=\"tmpl-edit-panel\">"
    + "<input id=\"pep-title-" + task.id + "\" value=\"" + escHtml(task.title) + "\" placeholder=\"Title *\" />"
    + "<input id=\"pep-owner-" + task.id + "\" value=\"" + escHtml(task.owner || "") + "\" placeholder=\"Owner\" style=\"width:100px\" list=\"owner-suggestions\" />"
    + "<input id=\"pep-weeks-" + task.id + "\" type=\"number\" min=\"0\" value=\"" + (task.weeks != null ? task.weeks : "") + "\" placeholder=\"Weeks\" style=\"width:65px\" oninput=\"autoFillProjEnd(" + task.id + ")\" />"
    + "<input id=\"pep-start-" + task.id + "\" value=\"" + escHtml(task.start_date || "") + "\" placeholder=\"Start (DDMMYY)\" style=\"width:120px\" oninput=\"autoFillProjEnd(" + task.id + ")\" />"
    + "<input id=\"pep-end-" + task.id + "\" value=\"" + escHtml(task.end_date || "") + "\" placeholder=\"End (DDMMYY)\" style=\"width:120px\" />"
    + "<select id=\"pep-status-" + task.id + "\">" + statusOptions + "</select>"
    + "<select id=\"pep-section-" + task.id + "\">" + sectionOptions + "</select>"
    + "<button class=\"btn-primary\" onclick=\"saveProjEdit(" + task.id + ")\">Save</button>"
    + "<button class=\"btn-outline\" onclick=\"toggleProjEditPanel(" + task.id + ")\">Cancel</button>"
    + "</div></td></tr>";
}

function autoFillProjEnd(taskId) {
  var startRaw = document.getElementById("pep-start-" + taskId).value.trim();
  var weeksRaw = document.getElementById("pep-weeks-" + taskId).value;
  if (!startRaw || !weeksRaw) return;
  var startIso = parseDate(startRaw);
  if (!startIso) return;
  var endIso = calcEndDate(startIso, Number(weeksRaw));
  if (endIso) document.getElementById("pep-end-" + taskId).value = endIso;
}

function toggleProjEditPanel(taskId) {
  var row = document.querySelector("tr.proj-edit-panel-row[data-edit-panel=\"" + taskId + "\"]");
  if (row) row.classList.toggle("hidden");
}

async function saveProjEdit(taskId) {
  var title    = document.getElementById("pep-title-"   + taskId).value.trim();
  var owner    = document.getElementById("pep-owner-"   + taskId).value.trim();
  var weeksRaw = document.getElementById("pep-weeks-"   + taskId).value;
  var startRaw = document.getElementById("pep-start-"   + taskId).value.trim();
  var endRaw   = document.getElementById("pep-end-"     + taskId).value.trim();
  var status   = document.getElementById("pep-status-"  + taskId).value;
  var section  = document.getElementById("pep-section-" + taskId).value;

  if (!title) return alert("Title is required.");
  var start = startRaw ? parseDate(startRaw) : null;
  var end   = endRaw   ? parseDate(endRaw)   : null;
  if (startRaw && !start) return alert("Unrecognised start date. Use DDMMYY or YYYY-MM-DD.");
  if (endRaw   && !end)   return alert("Unrecognised end date. Use DDMMYY or YYYY-MM-DD.");

  await api("PUT", "/tasks/" + taskId, {
    title, owner, weeks: weeksRaw ? Number(weeksRaw) : null,
    start_date: start, end_date: end, status, section,
  });
  await loadTasks();
}

function startEditTodo(event, todoId, taskId) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const li = btn.closest("li.todo-item");
  const label = li.querySelector("label");
  const original = label.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.value = original;
  input.className = "inline-edit-input";
  input.onblur = async function() {
    const val = input.value.trim();
    input.remove();
    label.style.display = "";
    btn.style.display = "";
    if (val && val !== original) {
      const updated = await api("PUT", "/todos/" + todoId, { text: val });
      if (todosCache[taskId]) {
        const idx = todosCache[taskId].findIndex(t => t.id === todoId);
        if (idx !== -1) todosCache[taskId][idx] = updated;
      }
      _refreshTodoPanel(taskId);
    }
  };
  input.onkeydown = function(e) {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.remove(); label.style.display = ""; btn.style.display = ""; }
  };
  label.style.display = "none";
  btn.style.display = "none";
  li.insertBefore(input, label);
  input.focus();
  input.select();
}


async function addTask() {
  var title    = document.getElementById("task-title").value.trim();
  var weeks    = document.getElementById("task-weeks").value;
  var startRaw = document.getElementById("task-start").value.trim();
  var endRaw   = document.getElementById("task-end").value.trim();
  var owner    = document.getElementById("task-owner").value.trim();
  var status   = document.getElementById("task-status").value;
  var section  = document.getElementById("task-section").value;
  var parentId = document.getElementById("task-parent").value || null;

  if (!title) return alert("Item title is required.");

  var start = startRaw ? parseDate(startRaw) : null;
  var end   = endRaw   ? parseDate(endRaw)   : null;
  if (startRaw && !start) return alert("Unrecognised start date. Use DDMMYY (e.g. 010126) or YYYY-MM-DD.");
  if (endRaw   && !end)   return alert("Unrecognised end date. Use DDMMYY (e.g. 010126) or YYYY-MM-DD.");

  await api("POST", "/projects/" + currentProjectId + "/tasks", {
    title: title,
    weeks: weeks ? Number(weeks) : null,
    start_date: start,
    end_date: end,
    owner: owner,
    status: status,
    section: section,
    parent_id: parentId ? Number(parentId) : null,
  });

  ["task-title", "task-weeks", "task-start", "task-end", "task-owner"].forEach(function(id) {
    document.getElementById(id).value = "";
  });
  document.getElementById("task-status").value = "not_started";
  document.getElementById("task-section").value = "";
  document.getElementById("task-parent").value = "";

  await loadTasks();
}

async function deleteTask(taskId) {
  if (!confirm("Delete this task?")) return;
  await api("DELETE", `/tasks/${taskId}`);
  await loadTasks();
}


// ── Voice / speech-to-text ────────────────────────────────────────────────────

var micRecognition = null;
var micActive = false;
var micTextareaId = null;
var micBtnId = null;
var micBaseText = "";

function toggleMic(textareaId, btnId) {
  if (micActive) {
    stopMic();
    return;
  }

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Speech recognition is not supported in this browser. Try Chrome or Safari.");
    return;
  }

  // Stop any other mic that may have been running
  if (micRecognition) { try { micRecognition.stop(); } catch(e) {} }

  micTextareaId = textareaId;
  micBtnId = btnId;
  micBaseText = document.getElementById(textareaId).value;
  micActive = true;

  micRecognition = new SpeechRecognition();
  micRecognition.continuous = true;
  micRecognition.interimResults = true;
  micRecognition.lang = "en-US";

  micRecognition.onresult = function(e) {
    var finalChunk = "";
    var interim = "";
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalChunk += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    if (finalChunk) {
      micBaseText += (micBaseText && !micBaseText.endsWith(" ") ? " " : "") + finalChunk.trim();
    }
    document.getElementById(micTextareaId).value = micBaseText + (interim ? " " + interim : "");
  };

  micRecognition.onend = function() {
    // Restart automatically while mic is still active (browser sometimes stops mid-session)
    if (micActive) {
      try { micRecognition.start(); } catch(e) { stopMic(); }
    }
  };

  micRecognition.onerror = function(e) {
    if (e.error !== "aborted" && e.error !== "no-speech") stopMic();
  };

  micRecognition.start();

  var btn = document.getElementById(btnId);
  btn.classList.add("mic-active");
  btn.innerHTML = "&#9632; Stop";
  btn.title = "Stop recording";
}

function stopMic() {
  micActive = false;
  if (micRecognition) {
    try { micRecognition.stop(); } catch(e) {}
    micRecognition = null;
  }
  var btn = document.getElementById(micBtnId);
  if (btn) {
    btn.classList.remove("mic-active");
    btn.innerHTML = "&#127908; Speak";
    btn.title = "Start voice input";
  }
}


// ── Project-wide tasks panel ─────────────────────────────────────────────────

const STATUS_ORDER = ["not_started", "in_progress", "blocked", "complete"];
const expandedStatusSections = new Set(["not_started", "in_progress", "blocked"]);

async function openProjectTasksPanel() {
  if (!currentProjectId) return;
  // Reuse the tasks panel in "project" mode
  tasksPanelTaskId = null;
  editingActionId  = null;

  var projects = await api("GET", "/projects?client_id=" + (currentClientId || ""));
  var proj = projects.find(function(p) { return p.id === currentProjectId; });
  document.getElementById("tasks-panel-title").textContent = proj ? proj.name : "Project";

  document.getElementById("tasks-add-area").style.display = "none";

  var items = await api("GET", "/projects/" + currentProjectId + "/all-action-items");
  _renderProjectTasks(items);

  document.getElementById("tasks-panel").classList.add("open");
  document.getElementById("tasks-overlay").classList.add("open");
}

function _renderProjectTasks(items) {
  var list = document.getElementById("tasks-list");
  if (!items.length) {
    list.innerHTML = "<div class=\"tasks-empty\">No tasks yet. Add them from individual items.</div>";
    return;
  }

  // Group by status
  var groups = {};
  STATUS_ORDER.forEach(function(s) { groups[s] = []; });
  items.forEach(function(item) {
    if (groups[item.status]) groups[item.status].push(item);
    else groups["not_started"].push(item);
  });

  // Sort each group by due_date (earliest first, null last)
  STATUS_ORDER.forEach(function(s) {
    groups[s].sort(function(a, b) {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    });
  });

  var html = "";
  STATUS_ORDER.forEach(function(s) {
    if (!groups[s].length) return;
    var isOpen = expandedStatusSections.has(s);
    html += "<div class=\"status-section\">"
      + "<button class=\"status-section-header" + (isOpen ? " open" : "") + "\" onclick=\"toggleStatusSection('" + s + "')\">"
      + "<span class=\"status-section-arrow\">" + (isOpen ? "&#9660;" : "&#9654;") + "</span>"
      + "<span>" + STATUS_LABELS[s] + "</span>"
      + "<span class=\"status-section-count\">" + groups[s].length + "</span>"
      + "</button>"
      + "<div class=\"status-section-body\" style=\"display:" + (isOpen ? "flex" : "none") + "\">";

    groups[s].forEach(function(item) {
      html += "<div class=\"action-item\" data-id=\"" + item.id + "\">"
        + "<div class=\"action-item-header\">"
        + "<span class=\"action-item-title\">" + escHtml(item.title) + "</span>"
        + "<span class=\"action-priority " + PRIORITY_CLASS[item.priority] + "\">" + PRIORITY_LABELS[item.priority] + "</span>"
        + "</div>"
        + "<div class=\"action-item-tag\">"
        + escHtml(item.item_title)
        + (item.sub_item_title ? "<span class=\"tag-sep\">›</span>" + escHtml(item.sub_item_title) : "")
        + "</div>"
        + "<div class=\"action-item-meta\">"
        + (item.owner ? "<span>" + escHtml(item.owner) + "</span>" : "")
        + (item.due_date ? "<span class=\"action-meta-sep\">·</span><span>Due " + fmt(item.due_date) + "</span>" : "")
        + "</div>"
        + (item.description ? "<div class=\"action-item-desc\">" + escHtml(item.description) + "</div>" : "")
        + "<div class=\"action-item-btns\">"
        + "<button class=\"btn-action-edit\" onclick=\"openTasksPanel(" + item.task_id + ")\" title=\"Open item tasks\">&#9998;</button>"
        + "<button class=\"btn-action-status\" onclick=\"cycleProjectActionStatus(" + item.id + ")\" title=\"Cycle status\">&#8635;</button>"
        + "</div>"
        + "</div>";
    });

    html += "</div></div>";
  });

  document.getElementById("tasks-list").innerHTML = html;
}

function toggleStatusSection(status) {
  if (expandedStatusSections.has(status)) {
    expandedStatusSections.delete(status);
  } else {
    expandedStatusSections.add(status);
  }
  // Re-fetch and re-render
  if (currentProjectId) {
    api("GET", "/projects/" + currentProjectId + "/all-action-items").then(_renderProjectTasks);
  }
}

async function cycleProjectActionStatus(itemId) {
  var list = document.getElementById("tasks-list");
  var card = list.querySelector(".action-item[data-id=\"" + itemId + "\"]");
  var currentStatus = "not_started";
  // Find current status from rendered content
  STATUS_ORDER.forEach(function(s) {
    var section = list.querySelector(".status-section-header." + s.replace("_","-"));
    if (section && section.nextElementSibling && section.nextElementSibling.querySelector("[data-id=\"" + itemId + "\"]")) {
      currentStatus = s;
    }
  });
  var next = ACTION_STATUS_CYCLE[(ACTION_STATUS_CYCLE.indexOf(currentStatus) + 1) % ACTION_STATUS_CYCLE.length];
  await api("PUT", "/action-items/" + itemId, { status: next });
  var items = await api("GET", "/projects/" + currentProjectId + "/all-action-items");
  _renderProjectTasks(items);
}


// ── Tasks panel ──────────────────────────────────────────────────────────────

let tasksPanelTaskId = null;
let tasksPanelItems  = [];
let editingActionId  = null;

const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High" };
const PRIORITY_CLASS  = { low: "pri-low", medium: "pri-med", high: "pri-high" };
const STATUS_LABELS   = { not_started: "Not started", in_progress: "In progress", complete: "Complete", blocked: "Blocked" };

async function openTasksPanel(taskId) {
  tasksPanelTaskId = taskId;
  editingActionId  = null;
  var task = currentTasks.find(function(t) { return t.id === taskId; });
  document.getElementById("tasks-panel-title").textContent = task ? task.title : "";
  document.getElementById("tasks-add-area").style.display = "";
  hideTaskActionForm();
  await _loadAndRenderActions();
  document.getElementById("tasks-panel").classList.add("open");
  document.getElementById("tasks-overlay").classList.add("open");
}

function closeTasksPanel() {
  document.getElementById("tasks-panel").classList.remove("open");
  document.getElementById("tasks-overlay").classList.remove("open");
  tasksPanelTaskId = null;
}

async function _loadAndRenderActions() {
  if (!tasksPanelTaskId) return;
  tasksPanelItems = await api("GET", "/tasks/" + tasksPanelTaskId + "/action-items");
  _renderActionItems();
}

function _renderActionItems() {
  var list = document.getElementById("tasks-list");
  if (!tasksPanelItems.length) {
    list.innerHTML = "<div class=\"tasks-empty\">No tasks yet — add one below.</div>";
    return;
  }
  list.innerHTML = tasksPanelItems.map(function(item) {
    return "<div class=\"action-item\" data-id=\"" + item.id + "\">"
      + "<div class=\"action-item-header\">"
      + "<span class=\"action-item-title\">" + escHtml(item.title) + "</span>"
      + "<span class=\"action-priority " + PRIORITY_CLASS[item.priority] + "\">" + PRIORITY_LABELS[item.priority] + "</span>"
      + "</div>"
      + "<div class=\"action-item-meta\">"
      + "<span class=\"action-status\">" + STATUS_LABELS[item.status] + "</span>"
      + (item.owner ? "<span class=\"action-meta-sep\">·</span><span>" + escHtml(item.owner) + "</span>" : "")
      + (item.due_date ? "<span class=\"action-meta-sep\">·</span><span>Due " + fmt(item.due_date) + "</span>" : "")
      + "</div>"
      + (item.description ? "<div class=\"action-item-desc\">" + escHtml(item.description) + "</div>" : "")
      + "<div class=\"action-item-btns\">"
      + "<button class=\"btn-action-edit\" onclick=\"startEditAction(" + item.id + ")\" title=\"Edit\">&#9998;</button>"
      + "<button class=\"btn-action-status\" onclick=\"cycleActionStatus(" + item.id + ")\" title=\"Cycle status\">&#8635;</button>"
      + "<button class=\"btn-danger\" onclick=\"deleteActionItem(" + item.id + ")\" title=\"Delete\">&#10005;</button>"
      + "</div>"
      + "</div>";
  }).join("");
}

function showTaskActionForm(prefill) {
  editingActionId = null;
  document.getElementById("ta-title").value       = prefill ? prefill.title       : "";
  document.getElementById("ta-priority").value    = prefill ? prefill.priority    : "medium";
  document.getElementById("ta-status").value      = prefill ? prefill.status      : "not_started";
  document.getElementById("ta-owner").value       = prefill ? prefill.owner       : "";
  document.getElementById("ta-due").value         = prefill ? (prefill.due_date || "") : "";
  document.getElementById("ta-description").value = prefill ? prefill.description : "";
  document.getElementById("btn-add-task-action").style.display = "none";
  document.getElementById("task-action-form").style.display   = "block";
  document.getElementById("ta-title").focus();
}

function hideTaskActionForm() {
  editingActionId = null;
  document.getElementById("task-action-form").style.display   = "none";
  document.getElementById("btn-add-task-action").style.display = "block";
}

function startEditAction(itemId) {
  var item = tasksPanelItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  editingActionId = itemId;
  showTaskActionForm(item);
}

async function saveTaskAction() {
  var title = document.getElementById("ta-title").value.trim();
  if (!title) return alert("Task title is required.");
  var payload = {
    title:       title,
    priority:    document.getElementById("ta-priority").value,
    status:      document.getElementById("ta-status").value,
    owner:       document.getElementById("ta-owner").value.trim(),
    due_date:    parseDate(document.getElementById("ta-due").value) || null,
    description: document.getElementById("ta-description").value.trim(),
  };
  if (editingActionId) {
    await api("PUT", "/action-items/" + editingActionId, payload);
  } else {
    await api("POST", "/tasks/" + tasksPanelTaskId + "/action-items", payload);
  }
  hideTaskActionForm();
  await _loadAndRenderActions();
}

async function deleteActionItem(itemId) {
  if (!confirm("Delete this task?")) return;
  await api("DELETE", "/action-items/" + itemId);
  await _loadAndRenderActions();
}

const ACTION_STATUS_CYCLE = ["not_started", "in_progress", "complete", "blocked"];
async function cycleActionStatus(itemId) {
  var item = tasksPanelItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  var next = ACTION_STATUS_CYCLE[(ACTION_STATUS_CYCLE.indexOf(item.status) + 1) % ACTION_STATUS_CYCLE.length];
  await api("PUT", "/action-items/" + itemId, { status: next });
  await _loadAndRenderActions();
}


// ── Plain-English update ──────────────────────────────────────────────────────

let currentTasks = [];           // kept in sync by loadTasks so review panel can look up titles
let currentTemplateTasks = [];   // kept in sync by loadTemplateTasks
let pendingActions = []; // proposed actions waiting for user confirmation

// ── Notes panel ──────────────────────────────────────────────────────────────

let notesTaskId = null;
let notesSaveTimer = null;
let notesData = []; // [{title: string, body: string}]
var notesAIResult = null;
var polishingSectionIdx = 0;

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function _parseNotes(str) {
  if (!str || !str.trim()) return [{ title: "", body: "" }];
  try {
    var parsed = JSON.parse(str);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch(e) {}
  return [{ title: "", body: str }]; // legacy plain text
}

function _serializeNotes() {
  return JSON.stringify(notesData);
}

function _hasNotesContent() {
  return notesData.some(function(s) { return (s.title + s.body).trim(); });
}

function _renderNotesSections() {
  var container = document.getElementById("notes-sections-container");
  container.innerHTML = notesData.map(function(section, idx) {
    return '<div class="notes-section" data-idx="' + idx + '">'
      + '<div class="notes-section-header">'
      + '<input class="notes-section-title" placeholder="Section title…" value="' + escHtml(section.title) + '" '
      + 'oninput="onNotesTitleInput(' + idx + ',this.value)" />'
      + '<button class="btn-polish-section" onclick="cleanSectionWithAI(' + idx + ')" title="Polish with AI">&#10024;</button>'
      + (notesData.length > 1
          ? '<button class="btn-delete-notes-section" onclick="deleteNotesSection(' + idx + ')" title="Remove">&#10005;</button>'
          : '')
      + '</div>'
      + '<textarea class="notes-section-body" placeholder="Write notes here…" '
      + 'oninput="onNotesBodyInput(' + idx + ',this.value); autoResizeTextarea(this)">' + escHtml(section.body) + '</textarea>'
      + '</div>';
  }).join('');
  // Auto-size all textareas after render
  container.querySelectorAll(".notes-section-body").forEach(function(ta) {
    autoResizeTextarea(ta);
  });
}

function onNotesTitleInput(idx, value) {
  notesData[idx].title = value;
  _scheduleNotesSave();
}

function onNotesBodyInput(idx, value) {
  notesData[idx].body = value;
  _scheduleNotesSave();
}

function _scheduleNotesSave() {
  var status = document.getElementById("notes-status");
  status.textContent = "";
  status.className = "notes-status";
  if (notesSaveTimer) clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(_saveNotes, 900);
}

function addNotesSection() {
  notesData.push({ title: "", body: "" });
  _renderNotesSections();
  var container = document.getElementById("notes-sections-container");
  var bodies = container.querySelectorAll(".notes-section-body");
  if (bodies.length) bodies[bodies.length - 1].focus();
  _scheduleNotesSave();
}

function deleteNotesSection(idx) {
  notesData.splice(idx, 1);
  if (!notesData.length) notesData = [{ title: "", body: "" }];
  _renderNotesSections();
  _scheduleNotesSave();
}

function openNotes(taskId) {
  var task = currentTasks.find(function(t) { return t.id === taskId; });
  if (!task) return;
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
    notesSaveTimer = null;
    if (notesTaskId && notesTaskId !== taskId) _saveNotesSilent(notesTaskId);
  }
  notesTaskId = taskId;
  document.getElementById("notes-panel-title").textContent = task.title;
  document.getElementById("notes-status").textContent = "";
  document.getElementById("notes-status").className = "notes-status";

  notesData = _parseNotes(task.notes);
  _renderNotesSections();

  // Sub-items notes — only for top-level items
  var subDiv = document.getElementById("notes-subitems");
  var children = currentTasks.filter(function(t) { return t.parent_id === taskId; });
  if (children.length > 0) {
    var html = '<div class="notes-subitems-header">Sub-item notes</div>';
    children.forEach(function(child) {
      var childSections = _parseNotes(child.notes);
      var hasContent = childSections.some(function(s) { return (s.title + s.body).trim(); });
      html += '<div class="notes-subitem-entry" onclick="openNotes(' + child.id + ')">'
        + '<div class="notes-subitem-title">' + escHtml(child.title) + '</div>';
      if (hasContent) {
        html += childSections.filter(function(s) { return (s.title + s.body).trim(); }).map(function(s) {
          return '<div class="notes-subitem-section">'
            + (s.title ? '<div class="notes-subitem-section-title">' + escHtml(s.title) + '</div>' : '')
            + (s.body  ? '<div class="notes-subitem-body">' + escHtml(s.body.trim()) + '</div>' : '')
            + '</div>';
        }).join('');
      } else {
        html += '<div class="notes-subitem-empty">No notes yet</div>';
      }
      html += '</div>';
    });
    subDiv.innerHTML = html;
    subDiv.style.display = "block";
  } else {
    subDiv.innerHTML = "";
    subDiv.style.display = "none";
  }

  document.getElementById("notes-panel").classList.add("open");
  document.getElementById("notes-overlay").classList.add("open");
  var firstBody = document.querySelector(".notes-section-body");
  if (firstBody) firstBody.focus();
}

function closeNotes() {
  if (notesTaskId) {
    var text = _serializeNotes();
    var task = currentTasks.find(function(t) { return t.id === notesTaskId; });
    if (task && task.notes !== text) {
      task.notes = text;
      _updateNotesBtn(notesTaskId, _hasNotesContent());
      api("PUT", "/tasks/" + notesTaskId, { notes: text });
    }
  }
  if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
  document.getElementById("notes-panel").classList.remove("open");
  document.getElementById("notes-overlay").classList.remove("open");
  notesTaskId = null;
}

async function _saveNotes() {
  notesSaveTimer = null;
  if (!notesTaskId) return;
  var text = _serializeNotes();
  var statusEl = document.getElementById("notes-status");
  statusEl.textContent = "Saving\u2026";
  statusEl.className = "notes-status saving";
  try {
    await api("PUT", "/tasks/" + notesTaskId, { notes: text });
    var task = currentTasks.find(function(t) { return t.id === notesTaskId; });
    if (task) task.notes = text;
    _updateNotesBtn(notesTaskId, _hasNotesContent());
    statusEl.textContent = "Saved";
    statusEl.className = "notes-status saved";
    setTimeout(function() {
      if (statusEl.className === "notes-status saved") { statusEl.textContent = ""; statusEl.className = "notes-status"; }
    }, 2000);
  } catch(e) {
    statusEl.textContent = "Error saving";
    statusEl.className = "notes-status error";
  }
}

function _saveNotesSilent(taskId) {
  var text = _serializeNotes();
  var task = currentTasks.find(function(t) { return t.id === taskId; });
  if (task && task.notes !== text) {
    task.notes = text;
    _updateNotesBtn(taskId, _hasNotesContent());
    api("PUT", "/tasks/" + taskId, { notes: text });
  }
}

async function cleanSectionWithAI(idx) {
  if (!notesTaskId) return;
  var text = notesData[idx] ? notesData[idx].body.trim() : "";
  if (!text) return alert("Write some notes in this section first.");

  polishingSectionIdx = idx;

  // Dim the polish button while working
  var container = document.getElementById("notes-sections-container");
  var btns = container.querySelectorAll(".btn-polish-section");
  var btn = btns[idx];
  if (btn) { btn.disabled = true; btn.textContent = "…"; }

  document.getElementById("notes-ai-preview").style.display = "none";

  try {
    var result = await api("POST", "/tasks/" + notesTaskId + "/notes/clean", { notes: text });
    notesAIResult = result.cleaned;
    document.getElementById("notes-ai-preview-text").textContent = result.cleaned;
    document.getElementById("notes-ai-preview").style.display = "block";
  } catch(e) {
    alert("AI polish failed: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "✨"; }
  }
}

function acceptAIClean() {
  if (!notesAIResult) return;
  if (notesData[polishingSectionIdx]) notesData[polishingSectionIdx].body = notesAIResult;
  notesAIResult = null;
  document.getElementById("notes-ai-preview").style.display = "none";
  _renderNotesSections();
  if (notesSaveTimer) clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(_saveNotes, 300);
}

function discardAIClean() {
  notesAIResult = null;
  document.getElementById("notes-ai-preview").style.display = "none";
}

function _updateNotesBtn(taskId, hasContent) {
  document.querySelectorAll("tr[data-id=\"" + taskId + "\"] .btn-notes").forEach(function(btn) {
    btn.className = "btn-notes" + (hasContent ? " has-notes" : "");
  });
}
let pendingSummary = ""; // Claude's summary for the pending actions

// File picker helpers
function onFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById("file-name-display").textContent = file.name;
  document.getElementById("btn-clear-file").style.display = "inline-flex";
}
function clearFile() {
  document.getElementById("update-file").value = "";
  document.getElementById("file-name-display").textContent = "";
  document.getElementById("btn-clear-file").style.display = "none";
}

async function submitUpdate() {
  const text = document.getElementById("update-text").value.trim();
  const fileInput = document.getElementById("update-file");
  const file = fileInput.files[0];

  if (!text && !file) return alert("Please enter an update or attach an image.");
  if (!currentProjectId) return alert("Select a project first.");

  const btn = document.getElementById("btn-submit-update");
  document.getElementById("update-result").style.display = "none";
  document.getElementById("review-panel").style.display = "none";

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Analysing\u2026';

  try {
    const fd = new FormData();
    fd.append("project_id", currentProjectId);
    fd.append("text", text);
    if (file) fd.append("file", file);

    const res = await fetch("/updates/interpret", { method: "POST", body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "HTTP " + res.status);
    }
    const result = await res.json();

    if (!result.actions.length) {
      showAppliedResult(result.summary, []);
      return;
    }

    pendingActions = result.actions;
    pendingSummary = result.summary;
    showReviewPanel(result.summary, result.actions);

  } catch (err) {
    const resultBox = document.getElementById("update-result");
    document.getElementById("result-summary").textContent = "Error: " + err.message;
    document.getElementById("change-list").innerHTML = "";
    resultBox.classList.add("error");
    resultBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Analyse &amp; propose changes";
  }
}

function renderEditableAction(a, i, tasks, isTemplate) {
  var cb = "<input type=\"checkbox\" checked data-idx=\"" + i + "\" />";

  if (a.type === "update") {
    var task = tasks.find(function(t) { return t.id === a.task_id; });
    var taskName = task ? ("\u201c" + escHtml(task.title) + "\u201d") : "task #" + a.task_id;
    var inputType = (a.field === "weeks") ? "number" : "text";
    return "<div class=\"review-action-item\">"
      + cb
      + "<span class=\"review-action-label\">Change <strong>" + escHtml(a.field || "") + "</strong> of " + taskName + " \u2192 </span>"
      + "<input type=\"" + inputType + "\" class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"value\" value=\"" + escHtml(a.value || "") + "\" />"
      + "</div>";
  }

  // create action — editable fields depend on project vs template
  var row = "<div class=\"review-action-item review-action-create\">"
    + cb
    + "<span class=\"review-action-label\">Create item:</span>"
    + "<input class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"title\" placeholder=\"Title *\" value=\"" + escHtml(a.title || "") + "\" />"
    + "<input class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"owner\" placeholder=\"Owner\" value=\"" + escHtml(a.owner || "") + "\" style=\"width:90px\" />"
    + "<input type=\"number\" class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"weeks\" placeholder=\"Wks\" value=\"" + (a.weeks != null ? a.weeks : "") + "\" style=\"width:60px\" />"
    + "<input class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"section\" placeholder=\"Section\" value=\"" + escHtml(a.section || "") + "\" style=\"width:110px\" />";
  if (!isTemplate) {
    row += "<input class=\"review-edit-val\" data-idx=\"" + i + "\" data-key=\"status\" placeholder=\"Status\" value=\"" + escHtml(a.status || "not_started") + "\" style=\"width:100px\" />";
  }
  row += "</div>";
  return row;
}

function collectEditedActions(pendingArr, containerSelector) {
  // Returns a copy of pendingArr with any user edits applied from the form inputs
  return pendingArr.map(function(a, i) {
    var edited = Object.assign({}, a);
    document.querySelectorAll(containerSelector + " .review-edit-val[data-idx=\"" + i + "\"]").forEach(function(inp) {
      var key = inp.dataset.key;
      var val = inp.value.trim();
      if (key === "weeks") {
        edited.weeks = val !== "" ? Number(val) : null;
      } else if (key === "parent_id") {
        edited.parent_id = val ? Number(val) : null;
      } else {
        edited[key] = val;
      }
    });
    return edited;
  });
}

function showReviewPanel(summary, actions) {
  document.getElementById("review-summary").textContent = summary;
  var container = document.getElementById("review-actions");
  container.innerHTML = actions.map(function(a, i) {
    return renderEditableAction(a, i, currentTasks, false);
  }).join("");
  document.getElementById("review-panel").style.display = "block";
}

function cancelReview() {
  document.getElementById("review-panel").style.display = "none";
  pendingActions = [];
}

async function applyConfirmed() {
  var editedActions = collectEditedActions(pendingActions, "#review-actions");
  const checkboxes = document.querySelectorAll("#review-actions input[type=checkbox]");
  const selected = [];
  checkboxes.forEach(function(cb) {
    if (cb.checked) selected.push(editedActions[parseInt(cb.dataset.idx)]);
  });

  if (!selected.length) return alert("No changes selected.");

  const btn = document.getElementById("btn-apply-confirmed");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Applying\u2026';

  try {
    const result = await api("POST", "/updates/apply", {
      project_id: currentProjectId,
      summary: pendingSummary,
      actions: selected,
    });

    document.getElementById("review-panel").style.display = "none";
    showAppliedResult(result.summary, result.actions);

    result.actions
      .filter(function(a) { return a.type === "create" && a.parent_id; })
      .forEach(function(a) { expandedParents.add(a.parent_id); });

    await loadTasks();

  } catch (err) {
    alert("Error applying changes: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Apply selected";
  }
}

function showAppliedResult(summary, actions) {
  const resultBox = document.getElementById("update-result");
  resultBox.classList.remove("error");
  document.getElementById("result-summary").textContent = summary;

  const ul = document.getElementById("change-list");
  if (!actions.length) {
    ul.innerHTML = "<li>No changes were needed.</li>";
  } else {
    ul.innerHTML = actions.map(function(a) {
      if (a.type === "create") {
        const sub = a.parent_id ? " (sub-item of #" + a.parent_id + ")" : "";
        return "<li>Created item: <strong>" + escHtml(a.title || "") + "</strong>" + sub + "</li>";
      }
      return "<li>Task #" + a.task_id + ": <strong>" + escHtml(a.field || "") + "</strong> \u2192 " + escHtml(a.value || "") + "</li>";
    }).join("");
  }
  resultBox.style.display = "block";
}


// ── Templates ─────────────────────────────────────────────────────────────────

async function loadTemplates() {
  const templates = await api("GET", "/templates");
  // Populate main template selector
  const sel = document.getElementById("template-select");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select a template —</option>';
  templates.forEach(function(t) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (prev && templates.find(function(t) { return t.id == prev; })) sel.value = prev;

  // Populate the new-project template dropdown
  const projSel = document.getElementById("new-project-template");
  const projPrev = projSel.value;
  projSel.innerHTML = '<option value="">No template</option>';
  templates.forEach(function(t) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    projSel.appendChild(opt);
  });
  if (projPrev && templates.find(function(t) { return t.id == projPrev; })) projSel.value = projPrev;
}

async function selectTemplate(id) {
  currentTemplateId = id ? Number(id) : null;
  const hasTmpl = !!currentTemplateId;
  document.getElementById("template-tasks-area").style.display    = hasTmpl ? "block" : "none";
  document.getElementById("btn-delete-template").style.display    = hasTmpl ? "inline-flex" : "none";
  document.getElementById("tmpl-update-card").style.display       = hasTmpl ? "block" : "none";
  document.getElementById("manual-tmpl-task-card").style.display  = hasTmpl ? "block" : "none";
  // Collapse the manual form when switching templates
  document.getElementById("manual-tmpl-task-form").style.display = "none";
  document.getElementById("btn-manual-tmpl-task-toggle").textContent = "+ Add item manually";
  expandedTemplateParents.clear();
  if (hasTmpl) await loadTemplateTasks();
}

document.getElementById("template-select").addEventListener("change", function(e) {
  selectTemplate(e.target.value);
});

function showCreateTemplate() {
  document.getElementById("new-template-form").style.display = "block";
  document.getElementById("new-template-name").focus();
}

function hideCreateTemplate() {
  document.getElementById("new-template-form").style.display = "none";
  document.getElementById("new-template-name").value = "";
}

async function createTemplate() {
  const name = document.getElementById("new-template-name").value.trim();
  if (!name) return alert("Template name is required.");
  const t = await api("POST", "/templates", { name, description: "" });
  hideCreateTemplate();
  await loadTemplates();
  document.getElementById("template-select").value = t.id;
  await selectTemplate(t.id);
}

async function deleteCurrentTemplate() {
  if (!currentTemplateId) return;
  if (!confirm("Delete this template and all its tasks?")) return;
  await api("DELETE", "/templates/" + currentTemplateId);
  currentTemplateId = null;
  document.getElementById("template-tasks-area").style.display = "none";
  document.getElementById("btn-delete-template").style.display = "none";
  await loadTemplates();
}

async function loadTemplateTasks() {
  if (!currentTemplateId) return;
  const tasks = await api("GET", "/templates/" + currentTemplateId + "/tasks");
  currentTemplateTasks = tasks;
  renderTemplateTasks(tasks);
  populateTemplateParentSelector(tasks);
  updateSectionDatalist(tasks);
}

function updateSectionDatalist(tasks) {
  // Add any custom sections (not in default SECTIONS) to the select
  var sel = document.getElementById("tmpl-task-section");
  if (!sel) return;
  var existing = new Set(SECTIONS);
  tasks.forEach(function(t) { if (t.section) existing.add(t.section); });
  // Remove old custom options (those not in SECTIONS and not __new__)
  Array.from(sel.options).forEach(function(opt) {
    if (opt.value && opt.value !== "__new__" && !SECTIONS.includes(opt.value)) {
      opt.remove();
    }
  });
  // Insert custom sections before the __new__ option
  var newOpt = sel.querySelector("option[value='__new__']");
  existing.forEach(function(s) {
    if (!SECTIONS.includes(s)) {
      var opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      sel.insertBefore(opt, newOpt);
    }
  });
}

function onTmplSectionChange(sel) {
  var custom = document.getElementById("tmpl-task-section-custom");
  if (sel.value === "__new__") {
    custom.style.display = "";
    custom.focus();
  } else {
    custom.style.display = "none";
    custom.value = "";
  }
}

function populateTemplateParentSelector(tasks) {
  var sel = document.getElementById("tmpl-task-parent");
  var prev = sel.value;
  sel.innerHTML = "<option value=\"\">No parent (top-level item)</option>";

  // Only top-level items can be parents — no sub-item nesting
  tasks.filter(function(t) { return !t.parent_id; }).forEach(function(t) {
    var opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.title;
    sel.appendChild(opt);
  });

  if (prev) sel.value = prev;
}

function templateTaskRowHtml(task, num, level, parentId) {
  var trClass = level >= 1 ? "subtask-row" : "task-row";

  var titleCell;
  if (level === 0) {
    titleCell = "<span class=\"editable-title\" onclick=\"startEditTemplateTask(event," + task.id + ")\">" + escHtml(task.title) + "</span>";
  } else {
    titleCell = "<span class=\"subtask-indent\"><span class=\"editable-title\" onclick=\"startEditTemplateTask(event," + task.id + ")\">" + escHtml(task.title) + "</span></span>";
  }

  var weeks = task.weeks != null ? task.weeks : "";
  var group = parentId ? "p:" + parentId : "s:" + (task.section || "");
  return "<tr data-id=\"" + task.id + "\""
    + " data-group=\"" + escHtml(group) + "\""
    + " data-is-template=\"true\""
    + " draggable=\"true\""
    + " ondragstart=\"onDragStart(event)\""
    + " ondragover=\"onDragOver(event)\""
    + " ondragleave=\"onDragLeave(event)\""
    + " ondrop=\"onDrop(event)\""
    + " ondragend=\"onDragEnd(event)\""
    + (parentId ? " data-parent=\"" + parentId + "\"" : "")
    + " class=\"" + trClass + "\">"
    + "<td>" + escHtml(String(num)) + "</td>"
    + "<td>" + titleCell + "</td>"
    + "<td>" + weeks + "</td>"
    + "<td>" + escHtml(task.owner || "—") + "</td>"
    + "<td style=\"white-space:nowrap\">"
    + "<button class=\"btn-edit-tmpl\" onclick=\"toggleTmplEditPanel(" + task.id + ")\" title=\"Edit\">&#9998;</button>"
    + "<button class=\"btn-danger\" onclick=\"deleteTemplateTask(" + task.id + ")\">&#10005;</button>"
    + "</td>"
    + "</tr>"
    + tmplEditPanelHtml(task);
}

function tmplEditPanelHtml(task) {
  var sectionOptions = ["", ...SECTIONS, ...currentTemplateTasks
    .map(function(t) { return t.section; })
    .filter(function(s, i, a) { return s && !SECTIONS.includes(s) && a.indexOf(s) === i; })
  ].map(function(s) {
    var sel = s === (task.section || "") ? " selected" : "";
    var label = s || "No section";
    return "<option value=\"" + escHtml(s) + "\"" + sel + ">" + escHtml(label) + "</option>";
  }).join("");

  var parentOptions = "<option value=\"\">No parent (top-level)</option>"
    + currentTemplateTasks.filter(function(t) {
        // allow depth-0 and depth-1 as parents, but not self or descendants
        if (t.id === task.id) return false;
        var depth = 0, cur = t;
        while (cur.parent_id) {
          cur = currentTemplateTasks.find(function(x) { return x.id === cur.parent_id; }) || {};
          depth++;
        }
        return depth < 2;
      }).map(function(t) {
        var sel = t.id === task.parent_id ? " selected" : "";
        return "<option value=\"" + t.id + "\"" + sel + ">" + escHtml(t.title) + "</option>";
      }).join("");

  return "<tr class=\"tmpl-edit-panel-row hidden\" data-edit-panel=\"" + task.id + "\">"
    + "<td colspan=\"5\">"
    + "<div class=\"tmpl-edit-panel\">"
    + "<input id=\"tep-title-" + task.id + "\" value=\"" + escHtml(task.title) + "\" placeholder=\"Title *\" />"
    + "<input id=\"tep-owner-" + task.id + "\" value=\"" + escHtml(task.owner || "") + "\" placeholder=\"Owner\" />"
    + "<input id=\"tep-weeks-" + task.id + "\" type=\"number\" min=\"0\" value=\"" + (task.weeks != null ? task.weeks : "") + "\" placeholder=\"Weeks\" style=\"width:70px\" />"
    + "<select id=\"tep-section-" + task.id + "\">" + sectionOptions + "</select>"
    + "<select id=\"tep-parent-" + task.id + "\">" + parentOptions + "</select>"
    + "<button class=\"btn-primary\" onclick=\"saveTmplEdit(" + task.id + ")\">Save</button>"
    + "<button class=\"btn-outline\" onclick=\"toggleTmplEditPanel(" + task.id + ")\">Cancel</button>"
    + "</div>"
    + "</td></tr>";
}

function renderTemplateTasks(tasks) {
  var tbody = document.getElementById("template-task-tbody");

  if (!tasks.length) {
    tbody.innerHTML = "<tr><td colspan=\"5\" class=\"empty\">No items yet — add one below.</td></tr>";
    return;
  }

  var childrenMap = {};
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.parent_id) {
      if (!childrenMap[t.parent_id]) childrenMap[t.parent_id] = [];
      childrenMap[t.parent_id].push(t);
    }
  }

  var topLevel = tasks.filter(function(t) { return !t.parent_id; });

  var sectionBuckets = [];
  var sectionIndex = {};
  for (var si = 0; si < SECTIONS.length; si++) {
    sectionBuckets.push({ name: SECTIONS[si], tasks: [] });
    sectionIndex[SECTIONS[si]] = si;
  }
  // Custom sections (not in SECTIONS) get their own named buckets
  var customBuckets = {};
  var customOrder = [];
  var unsectionedBucket = { name: "", tasks: [] };
  for (var ti = 0; ti < topLevel.length; ti++) {
    var sec = topLevel[ti].section || "";
    if (!sec) {
      unsectionedBucket.tasks.push(topLevel[ti]);
    } else if (sectionIndex.hasOwnProperty(sec)) {
      sectionBuckets[sectionIndex[sec]].tasks.push(topLevel[ti]);
    } else {
      if (!customBuckets[sec]) { customBuckets[sec] = { name: sec, tasks: [] }; customOrder.push(sec); }
      customBuckets[sec].tasks.push(topLevel[ti]);
    }
  }
  var activeBuckets = sectionBuckets.filter(function(b) { return b.tasks.length > 0; });
  customOrder.forEach(function(s) { activeBuckets.push(customBuckets[s]); });
  if (unsectionedBucket.tasks.length > 0) activeBuckets.push(unsectionedBucket);

  var rows = [];

  function renderLevel(taskList, prefix, level, parentId) {
    for (var i = 0; i < taskList.length; i++) {
      var task = taskList[i];
      var num = prefix ? prefix + "." + (i + 1) : String(i + 1);
      rows.push(templateTaskRowHtml(task, num, level, parentId));
      var children = childrenMap[task.id] || [];
      // Only top-level items (level 0) render sub-items; no deeper nesting
      if (level === 0 && children.length > 0) {
        renderLevel(children, num, level + 1, task.id);
      }
    }
  }

  for (var ai = 0; ai < activeBuckets.length; ai++) {
    var bucket = activeBuckets[ai];
    if (bucket.name) {
      rows.push("<tr class=\"section-header-row\" data-section=\"" + escHtml(bucket.name) + "\"><td colspan=\"5\">"
        + "<span class=\"section-name-editable\" onclick=\"startEditTemplateSection(event)\" title=\"Click to rename section\">" + escHtml(bucket.name) + "</span>"
        + "</td></tr>");
    }
    renderLevel(bucket.tasks, "", 0, null);
  }

  tbody.innerHTML = rows.join("");
}


function startEditTemplateSection(event) {
  var span = event.currentTarget;
  var oldName = span.closest("tr").dataset.section;
  var input = document.createElement("input");
  input.type = "text";
  input.value = oldName;
  input.style.cssText = "border:1px solid #6366f1;border-radius:4px;padding:.2rem .4rem;"
    + "font-size:.78rem;font-weight:600;font-family:inherit;letter-spacing:.08em;"
    + "text-transform:uppercase;color:#1a1a2e;background:#fff;outline:none;min-width:160px;";
  input.onblur = async function() {
    var newName = input.value.trim();
    input.remove();
    span.style.display = "";
    if (newName && newName !== oldName) {
      await renameTemplateSection(oldName, newName);
    }
  };
  input.onkeydown = function(e) {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.remove(); span.style.display = ""; }
  };
  span.style.display = "none";
  span.parentNode.insertBefore(input, span);
  input.focus();
  input.select();
}

async function renameTemplateSection(oldName, newName) {
  // Update every template task that belongs to oldName section
  var toUpdate = currentTemplateTasks.filter(function(t) { return t.section === oldName; });
  await Promise.all(toUpdate.map(function(t) {
    return api("PUT", "/template-tasks/" + t.id, { section: newName });
  }));
  await loadTemplateTasks();
}

function startEditTemplateTask(event, taskId) {
  var span = event.currentTarget;
  var original = span.textContent;
  var input = document.createElement("input");
  input.type = "text";
  input.value = original;
  input.className = "inline-edit-input";
  input.onblur = async function() {
    var val = input.value.trim();
    input.remove();
    span.style.display = "";
    if (val && val !== original) {
      await api("PUT", "/template-tasks/" + taskId, { title: val });
      await loadTemplateTasks();
    }
  };
  input.onkeydown = function(e) {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.remove(); span.style.display = ""; }
  };
  span.style.display = "none";
  span.parentNode.insertBefore(input, span);
  input.focus();
  input.select();
}

async function addTemplateTask() {
  var title    = document.getElementById("tmpl-task-title").value.trim();
  var weeks    = document.getElementById("tmpl-task-weeks").value;
  var owner    = document.getElementById("tmpl-task-owner").value.trim();
  var sectionSel = document.getElementById("tmpl-task-section").value;
  var section = sectionSel === "__new__"
    ? document.getElementById("tmpl-task-section-custom").value.trim()
    : sectionSel;
  var parentId = document.getElementById("tmpl-task-parent").value || null;

  if (!title) return alert("Item title is required.");

  await api("POST", "/templates/" + currentTemplateId + "/tasks", {
    title: title,
    weeks: weeks ? Number(weeks) : null,
    owner: owner,
    section: section,
    parent_id: parentId ? Number(parentId) : null,
  });

  document.getElementById("tmpl-task-title").value = "";
  document.getElementById("tmpl-task-weeks").value = "";
  document.getElementById("tmpl-task-owner").value = "";
  document.getElementById("tmpl-task-section").value = "";
  document.getElementById("tmpl-task-section-custom").style.display = "none";
  document.getElementById("tmpl-task-section-custom").value = "";
  document.getElementById("tmpl-task-parent").value = "";

  await loadTemplateTasks();
}

function toggleTmplEditPanel(taskId) {
  var row = document.querySelector("tr[data-edit-panel=\"" + taskId + "\"]");
  if (row) row.classList.toggle("hidden");
}

async function saveTmplEdit(taskId) {
  var title   = document.getElementById("tep-title-"   + taskId).value.trim();
  var owner   = document.getElementById("tep-owner-"   + taskId).value.trim();
  var weeksRaw= document.getElementById("tep-weeks-"   + taskId).value;
  var section = document.getElementById("tep-section-" + taskId).value;
  var parentId= document.getElementById("tep-parent-"  + taskId).value;

  if (!title) return alert("Title is required.");

  await api("PUT", "/template-tasks/" + taskId, {
    title:     title,
    owner:     owner,
    weeks:     weeksRaw !== "" ? Number(weeksRaw) : null,
    section:   section,
    parent_id: parentId ? Number(parentId) : null,
  });
  await loadTemplateTasks();
}

async function deleteTemplateTask(taskId) {
  if (!confirm("Delete this template task?")) return;
  await api("DELETE", "/template-tasks/" + taskId);
  await loadTemplateTasks();
}


// ── Template plain-English update ─────────────────────────────────────────────

let tmplPendingActions = [];
let tmplPendingSummary = "";

function onTmplFileSelected(input) {
  var file = input.files[0];
  if (!file) return;
  document.getElementById("tmpl-file-name-display").textContent = file.name;
  document.getElementById("btn-tmpl-clear-file").style.display = "inline-flex";
}

function clearTmplFile() {
  document.getElementById("tmpl-update-file").value = "";
  document.getElementById("tmpl-file-name-display").textContent = "";
  document.getElementById("btn-tmpl-clear-file").style.display = "none";
}

async function submitTemplateUpdate() {
  var text = document.getElementById("tmpl-update-text").value.trim();
  var fileInput = document.getElementById("tmpl-update-file");
  var file = fileInput.files[0];

  if (!text && !file) return alert("Please enter an update or attach an image.");
  if (!currentTemplateId) return alert("Select a template first.");

  var btn = document.getElementById("btn-tmpl-submit-update");
  document.getElementById("tmpl-update-result").style.display = "none";
  document.getElementById("tmpl-review-panel").style.display = "none";

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Analysing\u2026';

  try {
    var fd = new FormData();
    fd.append("template_id", currentTemplateId);
    fd.append("text", text);
    if (file) fd.append("file", file);

    var res = await fetch("/template-updates/interpret", { method: "POST", body: fd });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.detail || "HTTP " + res.status);
    }
    var result = await res.json();

    if (!result.actions.length) {
      showAppliedTemplateResult(result.summary, []);
      return;
    }

    tmplPendingActions = result.actions;
    tmplPendingSummary = result.summary;
    // Snapshot current tasks for description lookups
    currentTemplateTasks = await api("GET", "/templates/" + currentTemplateId + "/tasks");
    showTemplateReviewPanel(result.summary, result.actions);

  } catch (err) {
    var resultBox = document.getElementById("tmpl-update-result");
    document.getElementById("tmpl-result-summary").textContent = "Error: " + err.message;
    document.getElementById("tmpl-change-list").innerHTML = "";
    resultBox.classList.add("error");
    resultBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Analyse &amp; propose changes";
  }
}

function describeTmplAction(a) {
  if (a.type === "create") {
    var sub = a.parent_id ? " (sub-item of #" + a.parent_id + ")" : "";
    return "Create item: <strong>" + escHtml(a.title || "") + "</strong>" + sub;
  }
  var task = currentTemplateTasks.find(function(t) { return t.id === a.task_id; });
  var name = task ? ("\u201c" + escHtml(task.title) + "\u201d") : "task #" + a.task_id;
  return "Change <strong>" + escHtml(a.field || "") + "</strong> of " + name
    + " \u2192 <strong>" + escHtml(a.value || "") + "</strong>";
}

function showTemplateReviewPanel(summary, actions) {
  document.getElementById("tmpl-review-summary").textContent = summary;
  var container = document.getElementById("tmpl-review-actions");
  container.innerHTML = actions.map(function(a, i) {
    return renderEditableAction(a, i, currentTemplateTasks, true);
  }).join("");
  document.getElementById("tmpl-review-panel").style.display = "block";
}

function cancelTemplateReview() {
  document.getElementById("tmpl-review-panel").style.display = "none";
  tmplPendingActions = [];
}

async function applyTemplateConfirmed() {
  var editedActions = collectEditedActions(tmplPendingActions, "#tmpl-review-actions");
  var checkboxes = document.querySelectorAll("#tmpl-review-actions input[type=checkbox]");
  var selected = [];
  checkboxes.forEach(function(cb) {
    if (cb.checked) selected.push(editedActions[parseInt(cb.dataset.idx)]);
  });

  if (!selected.length) return alert("No changes selected.");

  var btn = document.getElementById("btn-tmpl-apply-confirmed");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Applying\u2026';

  try {
    var result = await api("POST", "/template-updates/apply", {
      template_id: currentTemplateId,
      summary: tmplPendingSummary,
      actions: selected,
    });

    document.getElementById("tmpl-review-panel").style.display = "none";
    showAppliedTemplateResult(result.summary, result.actions);
    await loadTemplateTasks();

  } catch (err) {
    alert("Error applying changes: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Apply selected";
  }
}

function showAppliedTemplateResult(summary, actions) {
  var resultBox = document.getElementById("tmpl-update-result");
  resultBox.classList.remove("error");
  document.getElementById("tmpl-result-summary").textContent = summary;

  var ul = document.getElementById("tmpl-change-list");
  if (!actions.length) {
    ul.innerHTML = "<li>No changes were needed.</li>";
  } else {
    ul.innerHTML = actions.map(function(a) {
      if (a.type === "create") {
        var sub = a.parent_id ? " (sub-item of #" + a.parent_id + ")" : "";
        return "<li>Created item: <strong>" + escHtml(a.title || "") + "</strong>" + sub + "</li>";
      }
      return "<li>Task #" + a.task_id + ": <strong>" + escHtml(a.field || "") + "</strong> \u2192 " + escHtml(a.value || "") + "</li>";
    }).join("");
  }
  resultBox.style.display = "block";
}


// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById("pane-projects").style.display  = tab === "projects"  ? "block" : "none";
  document.getElementById("pane-templates").style.display = tab === "templates" ? "block" : "none";
  document.getElementById("tab-projects").classList.toggle("active",  tab === "projects");
  document.getElementById("tab-templates").classList.toggle("active", tab === "templates");
}


// ── Manual task entry toggles ─────────────────────────────────────────────────

function toggleManualTask() {
  var form = document.getElementById("manual-task-form");
  var btn  = document.getElementById("btn-manual-task-toggle");
  var open = form.style.display !== "none";
  form.style.display = open ? "none" : "block";
  btn.textContent    = open ? "+ Add item manually" : "− Close";
}

function toggleManualTemplateTask() {
  var form = document.getElementById("manual-tmpl-task-form");
  var btn  = document.getElementById("btn-manual-tmpl-task-toggle");
  var open = form.style.display !== "none";
  form.style.display = open ? "none" : "block";
  btn.textContent    = open ? "+ Add item manually" : "− Close";
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Auto-fill end date in the add-task form when start or weeks changes
function _tryAutoFillAddForm() {
  var startRaw  = document.getElementById("task-start").value.trim();
  var weeksRaw  = document.getElementById("task-weeks").value;
  var endInput  = document.getElementById("task-end");
  if (!startRaw || !weeksRaw) return;
  var startIso  = parseDate(startRaw);
  if (!startIso) return;
  var endIso    = calcEndDate(startIso, Number(weeksRaw));
  if (endIso)   endInput.value = endIso;
}
document.getElementById("task-start").addEventListener("input",   _tryAutoFillAddForm);
document.getElementById("task-weeks").addEventListener("input",   _tryAutoFillAddForm);
document.getElementById("task-section").addEventListener("change", filterParentsBySection);

loadClients();
loadTemplates();
