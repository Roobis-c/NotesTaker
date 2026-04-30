// ══════════════════════════════════════════════════════
// script.js
// All application logic. Depends on firebase.js being
// loaded first (provides: subscribeToNotes, saveNote,
// deleteNote, deleteAllNotes, nowTimestamp).
// ══════════════════════════════════════════════════════

// ── State ───────────────────────────────────────────────
let notes = [];            // in-memory cache synced from Firestore
let currentNoteId  = null;
let isEditing      = false;
let pendingDeleteId = null;

let autoSaveTimer      = null;
let searchDebounceTimer = null;
let syncHideTimer      = null;
let unsubscribe        = null; // Firestore listener cleanup fn

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Convert a Firestore Timestamp or plain ms number → Date
function tsToDate(ts) {
  if (!ts) return null;
  return ts?.toDate ? ts.toDate() : new Date(ts);
}

function formatDate(ts) {
  const d = tsToDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateFull(ts) {
  const d = tsToDate(ts);
  if (!d) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || "";
}

// ══════════════════════════════════════════════════════
// SYNC INDICATOR
// ══════════════════════════════════════════════════════
function showSync(state, msg) {
  const el  = document.getElementById("syncIndicator");
  const txt = document.getElementById("syncText");
  if (!el || !txt) return;
  clearTimeout(syncHideTimer);
  el.className  = "visible " + state;
  txt.textContent = msg;
  if (state === "saved" || state === "error") {
    syncHideTimer = setTimeout(() => { el.className = ""; }, 2500);
  }
}

// ══════════════════════════════════════════════════════
// THEME
// ══════════════════════════════════════════════════════
function toggleTheme() {
  const html  = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  localStorage.setItem("folio_theme", isDark ? "light" : "dark");
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const icon   = document.getElementById("themeIcon");
  if (!icon) return;
  icon.innerHTML = isDark
    ? `<circle cx="12" cy="12" r="5"/>
       <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42
                M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>`
    : `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
}

// Apply saved theme immediately (before DOMContentLoaded)
(function initTheme() {
  const saved = localStorage.getItem("folio_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
})();

// ══════════════════════════════════════════════════════
// PAGE NAVIGATION
// ══════════════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById(id)?.classList.add("active");
}

function goHome() {
  if (isEditing) doAutoSave();
  isEditing     = false;
  currentNoteId = null;
  document.body.classList.remove("focus-mode");
  showPage("homePage");
}

// ══════════════════════════════════════════════════════
// RENDER HOME (notes grid)
// ══════════════════════════════════════════════════════
function renderNotes() {
  const searchInput = document.getElementById("searchInput");
  const sortSelect  = document.getElementById("sortSelect");
  if (!searchInput || !sortSelect) return;

  const query = searchInput.value.toLowerCase().trim();
  const sort  = sortSelect.value;

  // Filter
  let filtered = notes.filter((n) =>
    (n.title   || "").toLowerCase().includes(query) ||
    (n.content || "").toLowerCase().includes(query) ||
    (n.tags    || []).some((t) => t.toLowerCase().includes(query))
  );

  // Separate pinned / unpinned
  const pinned   = filtered.filter((n) =>  n.pinned);
  const unpinned = filtered.filter((n) => !n.pinned);

  // Sort helper
  const getTime = (n, field) => {
    const ts = n[field];
    return ts?.toMillis ? ts.toMillis() : (ts || 0);
  };
  const sortFn = (a, b) => {
    if (sort === "latest")     return getTime(b, "updatedAt")  - getTime(a, "updatedAt");
    if (sort === "oldest")     return getTime(a, "createdAt")  - getTime(b, "createdAt");
    if (sort === "alpha")      return (a.title || "").localeCompare(b.title || "");
    if (sort === "alpha-desc") return (b.title || "").localeCompare(a.title || "");
    return 0;
  };

  pinned.sort(sortFn);
  unpinned.sort(sortFn);
  filtered = [...pinned, ...unpinned];

  const grid  = document.getElementById("notesGrid");
  const stats = document.getElementById("statsText");
  if (!grid || !stats) return;

  stats.textContent = `${notes.length} note${notes.length !== 1 ? "s" : ""}`;

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        <h3>${query ? "No notes found" : "No notes yet"}</h3>
        <p>${query ? "Try a different search term." : 'Click "New Note" to create your first note.'}</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map((n) => {
    const preview  = stripHtml(n.content || "");
    const tagsHtml = (n.tags || [])
      .map((t) => `<span class="tag">#${escHtml(t)}</span>`)
      .join("");

    return `
      <div class="note-card${n.pinned ? " pinned" : ""}" data-note-id="${n.id}">
        <div class="card-header">
          <div class="card-title">${escHtml(n.title || "Untitled")}</div>
          <svg class="card-pin-icon" width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z
                     m0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
        </div>
        ${preview  ? `<div class="card-preview">${escHtml(preview.slice(0, 120))}</div>` : ""}
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
        <div class="card-meta">
          <div class="card-date">${formatDate(n.updatedAt || n.createdAt)}</div>
          <div class="card-actions">
            <button class="card-action-btn pin"    data-action="pin"    data-note-id="${n.id}" title="${n.pinned ? "Unpin" : "Pin"}">
              <svg width="12" height="12" fill="${n.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z
                         m0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
              </svg>
            </button>
            <button class="card-action-btn delete" data-action="delete" data-note-id="${n.id}" title="Delete">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════
function showModal(id) { document.getElementById(id)?.classList.add("visible"); }
function hideModal(id) { document.getElementById(id)?.classList.remove("visible"); }

function showNewNoteModal() {
  const input = document.getElementById("newNoteTitle");
  if (input) input.value = "";
  showModal("newNoteOverlay");
  setTimeout(() => input?.focus(), 100);
}

function showDeleteModal(id) {
  pendingDeleteId = id;
  const note   = notes.find((n) => n.id === id);
  const nameEl = document.getElementById("deleteNoteName");
  if (nameEl) nameEl.textContent = note?.title || "Untitled";
  showModal("deleteOverlay");
}

function showClearAllModal() { showModal("clearAllOverlay"); }

// ══════════════════════════════════════════════════════
// CRUD — all writes go through firebase.js helpers
// ══════════════════════════════════════════════════════

// Create
async function createNote() {
  const titleInput = document.getElementById("newNoteTitle");
  const title = titleInput?.value.trim() || "Untitled";
  hideModal("newNoteOverlay");

  const id   = generateId();
  const note = {
    id,
    title,
    content:   "",
    tags:      [],
    pinned:    false,
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
  };

  notes.unshift(note); // optimistic local update
  showSync("saving", "Saving…");
  try {
    await saveNote(note);
    showSync("saved", "Saved");
  } catch (err) {
    console.error(err);
    showSync("error", "Save failed");
  }
  openNote(id, true);
}

// Confirm delete
async function confirmDelete() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  pendingDeleteId = null;
  hideModal("deleteOverlay");
  showSync("saving", "Deleting…");
  try {
    await deleteNote(id);
    showSync("saved", "Deleted");
  } catch (err) {
    console.error(err);
    showSync("error", "Delete failed");
  }
  // Real-time listener will refresh notes[]
}

// Clear all
async function clearAllNotes() {
  hideModal("clearAllOverlay");
  showSync("saving", "Clearing…");
  try {
    await deleteAllNotes();
    showSync("saved", "Cleared");
  } catch (err) {
    console.error(err);
    showSync("error", "Failed to clear");
  }
}

// Toggle pin
async function togglePin(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned    = !note.pinned;
  note.updatedAt = nowTimestamp();
  showSync("saving", "Saving…");
  try {
    await saveNote(note);
    showSync("saved", "Saved");
  } catch (err) {
    showSync("error", "Save failed");
  }
}

// ══════════════════════════════════════════════════════
// NOTE PAGE — open / edit / save
// ══════════════════════════════════════════════════════
function openNote(id, startEditing = false) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  currentNoteId = id;

  document.getElementById("noteTitle").value    = note.title   || "";
  document.getElementById("noteContentRich").innerHTML = note.content || "";
  document.getElementById("createdDate").textContent   = formatDateFull(note.createdAt);
  document.getElementById("updatedDate").textContent   = formatDateFull(note.updatedAt);

  renderNoteTags(note.tags || []);
  isEditing = false;
  setEditMode(startEditing);
  showPage("notePage");
}

function setEditMode(editing) {
  isEditing = editing;

  const titleEl    = document.getElementById("noteTitle");
  const contentEl  = document.getElementById("noteContentRich");
  const badge      = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const formatBar  = document.getElementById("formatBar");
  const editBtn    = document.getElementById("editBtn");
  const saveBtn    = document.getElementById("saveBtn");

  if (editing) {
    titleEl?.removeAttribute("readonly");
    contentEl?.setAttribute("contenteditable", "true");
    contentEl?.focus();
    if (badge)      badge.className       = "status-badge editing";
    if (statusText) statusText.textContent = "Editing";
    formatBar?.classList.remove("hidden");
    editBtn?.classList.add("hidden");
    saveBtn?.classList.remove("hidden");
  } else {
    titleEl?.setAttribute("readonly", "");
    contentEl?.setAttribute("contenteditable", "false");
    if (badge)      badge.className       = "status-badge locked";
    if (statusText) statusText.textContent = "Locked";
    formatBar?.classList.add("hidden");
    editBtn?.classList.remove("hidden");
    saveBtn?.classList.add("hidden");
  }
}

function toggleEdit() { setEditMode(true); }

async function saveNoteAndLock() {
  if (!currentNoteId) return;
  await doAutoSave();
  setEditMode(false);
}

async function doAutoSave() {
  if (!currentNoteId) return;
  const note = notes.find((n) => n.id === currentNoteId);
  if (!note) return;

  const titleEl   = document.getElementById("noteTitle");
  const contentEl = document.getElementById("noteContentRich");

  if (titleEl)   note.title   = titleEl.value.trim() || "Untitled";
  if (contentEl) note.content = contentEl.innerHTML;
  note.updatedAt = nowTimestamp();

  const updatedEl = document.getElementById("updatedDate");
  if (updatedEl) updatedEl.textContent = formatDateFull(note.updatedAt);

  showSync("saving", "Saving…");
  try {
    await saveNote(note);
    showSync("saved", "Saved");
  } catch (err) {
    console.error(err);
    showSync("error", "Save failed");
  }
}

// Debounced auto-save while typing
document.addEventListener("input", (e) => {
  if (!isEditing || !currentNoteId) return;
  if (!["noteTitle", "noteContentRich"].includes(e.target.id)) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(doAutoSave, 1500);
});

// ══════════════════════════════════════════════════════
// TAGS
// ══════════════════════════════════════════════════════
function renderNoteTags(tags) {
  const display = document.getElementById("noteTagsDisplay");
  if (!display) return;
  display.innerHTML = tags
    .map((t) => `<span class="tag" style="cursor:pointer" data-tag="${escHtml(t)}">#${escHtml(t)} ×</span>`)
    .join("");
}

async function handleTagInput(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const val = e.target.value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!val) return;
  const note = notes.find((n) => n.id === currentNoteId);
  if (!note) return;
  if (!note.tags) note.tags = [];
  if (!note.tags.includes(val)) {
    note.tags.push(val);
    renderNoteTags(note.tags);
    try { await saveNote(note); } catch (err) { console.error(err); }
  }
  e.target.value = "";
}

async function removeTag(tag) {
  if (!isEditing) return;
  const note = notes.find((n) => n.id === currentNoteId);
  if (!note) return;
  note.tags = (note.tags || []).filter((t) => t !== tag);
  renderNoteTags(note.tags);
  try { await saveNote(note); } catch (err) { console.error(err); }
}

// ══════════════════════════════════════════════════════
// RICH TEXT FORMATTING
// ══════════════════════════════════════════════════════
function fmt(cmd, val) {
  document.getElementById("noteContentRich")?.focus();
  document.execCommand(cmd, false, val || null);
}

// ══════════════════════════════════════════════════════
// FOCUS MODE
// ══════════════════════════════════════════════════════
function toggleFocus() { document.body.classList.toggle("focus-mode"); }

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("focus-mode")) {
    document.body.classList.remove("focus-mode");
  }
});

// ══════════════════════════════════════════════════════
// EXPORT AS IMAGE
// ══════════════════════════════════════════════════════
async function exportImage() {
  if (!currentNoteId) return;
  const note = notes.find((n) => n.id === currentNoteId);
  if (!note) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const bg     = isDark ? "#0e0e10" : "#f4f0eb";
  const fg     = isDark ? "#e8e8ef" : "#1a1814";
  const fg2    = isDark ? "#c8c8d0" : "#2a2825";
  const fgMuted = isDark ? "#5c5c6e" : "#9a9690";
  const tagBg  = isDark ? "#1c1c21" : "#e4dfd7";
  const tagFg  = isDark ? "#9898aa" : "#5a5650";
  const sep    = isDark ? "#2a2a32" : "#d4cfc8";

  let exportDiv = document.getElementById("exportCanvas");
  if (!exportDiv) {
    exportDiv = document.createElement("div");
    exportDiv.id = "exportCanvas";
  }
  Object.assign(exportDiv.style, {
    background: bg, color: fg,
    fontFamily: "'DM Sans', sans-serif",
    padding: "48px", width: "760px", maxWidth: "760px",
    position: "fixed", top: "-9999px", left: "-9999px",
  });

  const tagsHtml = (note.tags || [])
    .map((t) => `<span style="font-size:0.7rem;padding:2px 8px;background:${tagBg};border-radius:20px;color:${tagFg};font-family:'DM Mono',monospace;margin-right:5px">#${escHtml(t)}</span>`)
    .join("");

  exportDiv.innerHTML = `
    <div style="font-family:'Playfair Display',serif;font-size:0.7rem;color:${tagFg};letter-spacing:0.1em;margin-bottom:16px;text-transform:uppercase">Folio</div>
    <h1 style="font-family:'Playfair Display',serif;font-size:2.2rem;margin-bottom:12px;line-height:1.2;color:${fg}">${escHtml(note.title || "Untitled")}</h1>
    <div style="font-size:0.72rem;color:${fgMuted};font-family:'DM Mono',monospace;margin-bottom:${tagsHtml ? "12px" : "24px"}">${formatDateFull(note.createdAt)}</div>
    ${tagsHtml ? `<div style="margin-bottom:24px">${tagsHtml}</div>` : ""}
    <div style="height:1px;background:${sep};margin-bottom:28px"></div>
    <div style="font-size:1rem;line-height:1.8;color:${fg2}">${note.content || '<i style="color:#888">No content</i>'}</div>
  `;

  if (!document.body.contains(exportDiv)) document.body.appendChild(exportDiv);
  await new Promise((r) => setTimeout(r, 100));

  try {
    const canvas = await html2canvas(exportDiv, {
      backgroundColor: bg, scale: 2, useCORS: true, logging: false,
    });
    const link = document.createElement("a");
    link.download = `${(note.title || "note").replace(/[^a-z0-9]/gi, "_")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (err) {
    console.error("Export failed:", err);
    alert("Export failed. Please try again.");
  }
  exportDiv.parentNode?.removeChild(exportDiv);
}

// ══════════════════════════════════════════════════════
// EVENT LISTENERS (wired up after DOM is ready)
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // Apply theme icon now that DOM is ready
  updateThemeIcon();

  // Header / toolbar buttons
  document.getElementById("themeBtn")?.addEventListener("click", toggleTheme);
  document.getElementById("newNoteBtn")?.addEventListener("click", showNewNoteModal);
  document.getElementById("clearAllBtn")?.addEventListener("click", showClearAllModal);
  document.getElementById("backBtn")?.addEventListener("click", goHome);
  document.getElementById("editBtn")?.addEventListener("click", toggleEdit);
  document.getElementById("saveBtn")?.addEventListener("click", saveNoteAndLock);
  document.getElementById("exportBtn")?.addEventListener("click", exportImage);
  document.getElementById("focusBtn")?.addEventListener("click", toggleFocus);

  // Modal confirm buttons
  document.getElementById("createNoteBtn")?.addEventListener("click", createNote);
  document.getElementById("newNoteTitle")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createNote();
  });
  document.getElementById("confirmDeleteBtn")?.addEventListener("click", confirmDelete);
  document.getElementById("clearAllConfirmBtn")?.addEventListener("click", clearAllNotes);

  // Search + sort
  document.getElementById("searchInput")?.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderNotes, 300);
  });
  document.getElementById("sortSelect")?.addEventListener("change", renderNotes);

  // Tag input
  document.getElementById("tagInput")?.addEventListener("keydown", handleTagInput);

  // Format bar buttons (delegated)
  document.querySelectorAll(".fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      fmt(btn.getAttribute("data-cmd"), btn.getAttribute("data-value"));
    });
  });

  // Notes grid clicks (delegated)
  document.getElementById("notesGrid")?.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.getAttribute("data-action");
      const noteId = actionBtn.getAttribute("data-note-id");
      if (action === "pin")    togglePin(noteId);
      if (action === "delete") showDeleteModal(noteId);
      return;
    }
    const card = e.target.closest(".note-card");
    if (card) openNote(card.getAttribute("data-note-id"));
  });

  // Tag display clicks (delegated)
  document.getElementById("noteTagsDisplay")?.addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) removeTag(tag.getAttribute("data-tag"));
  });

  // Cancel buttons (delegated — any .btn-cancel with data-modal)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-cancel");
    if (btn) hideModal(btn.getAttribute("data-modal"));
  });

  // Close overlay on backdrop click
  document.querySelectorAll(".overlay").forEach((o) => {
    o.addEventListener("click", (e) => { if (e.target === o) hideModal(o.id); });
  });

  // ── Start Firebase real-time listener ──────────────
  unsubscribe = subscribeToNotes(
    (freshNotes) => {
      notes = freshNotes;
      renderNotes();
      // Hide loading screen once first snapshot arrives
      document.getElementById("loadingScreen")?.classList.add("hidden");
    },
    () => {
      showSync("error", "Sync error");
      document.getElementById("loadingScreen")?.classList.add("hidden");
    }
  );
});
