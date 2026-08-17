// Custom admin panel (see backend README section 4). Token auth; token lives in
// sessionStorage (not localStorage) to reduce XSS exposure.
const TOKEN = {
  get()   { return sessionStorage.getItem("admin_token"); },
  set(v)  { v ? sessionStorage.setItem("admin_token", v) : sessionStorage.removeItem("admin_token"); },
};

const views = {
  login:     document.getElementById("view-login"),
  list:      document.getElementById("view-list"),
  detail:    document.getElementById("view-detail"),
  shortlist: document.getElementById("view-shortlist"),
};
const navUser = document.getElementById("nav-user");

// Current staff user — populated on login and on /admin/me/ boot. Drives the
// permissions UI (viewers see no decision/bulk/CSV buttons; reviewers do).
let USER = null;

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("d-none", k !== name));
  navUser.classList.toggle("d-none", name === "login");
}

// Show/hide review-only and export-only affordances based on the current
// user's role. The backend still re-checks — this is a UX layer, not a
// security boundary.
function applyPermissions() {
  const canReview = !!(USER && USER.can_review);
  const canExport = !!(USER && USER.can_export);

  // Decision buttons, delete, bulk toolbar, row checkboxes — reviewers only.
  document.querySelectorAll("[data-decision]").forEach((el) => el.classList.toggle("d-none", !canReview));
  document.querySelectorAll("[data-bulk]").forEach((el) => el.classList.toggle("d-none", !canReview));
  const bulkBar = document.getElementById("bulk-bar");
  if (bulkBar && !canReview) bulkBar.classList.add("d-none");
  const dDelete = document.getElementById("d-delete");
  if (dDelete) dDelete.classList.toggle("d-none", !canReview);

  // Row-select column is more surgical — hide the select-all header and the
  // per-row checkboxes get hidden via CSS class on the table body.
  const selectAll = document.getElementById("select-all");
  if (selectAll) selectAll.style.display = canReview ? "" : "none";
  document.body.classList.toggle("no-review", !canReview);

  // CSV export buttons — reviewers only.
  const exportList = document.getElementById("export-list-btn");
  if (exportList) exportList.classList.toggle("d-none", !canExport);
  const exportShort = document.getElementById("export-shortlist-btn");
  if (exportShort && !canExport) exportShort.classList.add("d-none");
}

// Any admin call that 401s means the token is bad -> back to login.
async function adminCall(method, path, body) {
  try {
    return await apiJson(method, path, body, TOKEN.get());
  } catch (err) {
    if (err.status === 401) { TOKEN.set(null); showView("login"); }
    throw err;
  }
}

// ------------------------------------------------------------------ Login
const loginForm = document.getElementById("login-form");
const loginAlert = document.getElementById("login-alert");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginAlert.classList.add("d-none");
  const btn = document.getElementById("login-btn");
  btn.disabled = true;
  const fd = new FormData(loginForm);
  try {
    const data = await apiJson("POST", "/admin/login/", {
      username: fd.get("username"),
      password: fd.get("password"),
    });
    TOKEN.set(data.token);
    USER = data.user || null;
    setNavUser(data.user);
    applyPermissions();
    loginForm.reset();
    loadList();
  } catch (err) {
    loginAlert.textContent = (err.data && err.data.detail) || "Sign in failed.";
    loginAlert.classList.remove("d-none");
  } finally {
    btn.disabled = false;
  }
});

function setNavUser(user) {
  document.getElementById("nav-username").textContent =
    user.username + (user.is_superuser ? " (superuser)" : "");
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await adminCall("POST", "/admin/logout/"); } catch { /* ignore */ }
  TOKEN.set(null);
  showView("login");
});

// ------------------------------------------------------------------ List
let currentPage = 1;
let currentSearch = "";
let currentStatus = "";   // "" | "pass" | "fail" | "pending"
let pageState = { next: null, previous: null, count: 0 };

const searchInput = document.getElementById("search-input");
const statusFilter = document.getElementById("status-filter");
const applicantsBody = document.getElementById("applicants-body");

const QUIZ_BADGE = {
  not_started: '<span class="badge bg-secondary-soft">Not started</span>',
  in_progress: '<span class="badge bg-warning-soft">In progress</span>',
  completed:   '<span class="badge bg-success-soft">Completed</span>',
};

// Knowledge-check outcome (server-derived from the quiz score).
const STATUS_BADGE = {
  PENDING: '<span class="badge bg-secondary-soft">Pending</span>',
  PASS:    '<span class="badge bg-success-soft"><i class="bi bi-check2"></i> Passed</span>',
  FAIL:    '<span class="badge bg-danger-soft"><i class="bi bi-x"></i> Failed</span>',
};

// Staff-review outcome (set by admins).
const DECISION_BADGE = {
  PENDING:  '<span class="badge bg-secondary-soft">Pending</span>',
  SELECTED: '<span class="badge bg-success-soft">Selected</span>',
  REJECTED: '<span class="badge bg-danger-soft">Rejected</span>',
};

// action name (UI) -> decision enum (API)
const DECISION_VALUE = { select: "SELECTED", reject: "REJECTED", pending: "PENDING" };

// Ids of applicants ticked in the current list view.
const selected = new Set();
const listAlert = document.getElementById("list-alert");

async function loadList() {
  showView("list");
  selected.clear();
  updateBulkBar();
  listAlert.classList.add("d-none");
  document.getElementById("select-all").checked = false;
  applicantsBody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">Loading…</td></tr>`;
  const params = new URLSearchParams();
  if (currentSearch) params.set("search", currentSearch);
  if (currentStatus) params.set("status", currentStatus);
  if (currentPage > 1) params.set("page", currentPage);
  const qs = params.toString() ? `?${params}` : "";
  try {
    const data = await adminCall("GET", `/admin/applications/${qs}`);
    pageState = { next: data.next, previous: data.previous, count: data.count };
    renderList(data.results);
    updatePager();
  } catch (err) {
    if (err.status !== 401) {
      applicantsBody.innerHTML = `<tr><td colspan="10" class="text-center text-danger py-4">Failed to load applicants.</td></tr>`;
    }
  }
}

function renderList(rows) {
  if (!rows.length) {
    applicantsBody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">No applicants found.</td></tr>`;
    return;
  }
  applicantsBody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer";
    const score = r.score != null ? `${r.score} / ${r.total}` : "—";
    const status = STATUS_BADGE[r.status] || esc(r.status || "");
    const decision = DECISION_BADGE[r.decision] || esc(r.decision || "");
    tr.innerHTML = `
      <td class="select-cell"><input type="checkbox" class="form-check-input row-check" value="${r.id}"></td>
      <td class="fw-semibold">${esc(r.first_name)} ${esc(r.last_name)}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.institution || "")}</td>
      <td>${esc(r.country_of_residence || "")}</td>
      <td>${QUIZ_BADGE[r.quiz_status] || esc(r.quiz_status)}</td>
      <td class="text-center">${score}</td>
      <td>${status}</td>
      <td>${decision}</td>
      <td class="text-end"><i class="bi bi-chevron-right text-muted"></i></td>`;

    // Clicking the row opens the detail, except when interacting with the checkbox.
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".select-cell")) return;
      loadDetail(r.id);
    });

    const cb = tr.querySelector(".row-check");
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(r.id) : selected.delete(r.id);
      syncSelectAll();
      updateBulkBar();
    });
    applicantsBody.appendChild(tr);
  });
}

// ---- Selection & bulk actions ----
function updateBulkBar() {
  const bar = document.getElementById("bulk-bar");
  bar.classList.toggle("d-none", selected.size === 0);
  document.getElementById("bulk-count").textContent = `${selected.size} selected`;
}

function syncSelectAll() {
  const checks = [...document.querySelectorAll(".row-check")];
  const all = checks.length > 0 && checks.every((c) => c.checked);
  document.getElementById("select-all").checked = all;
}

document.getElementById("select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    cb.checked ? selected.add(cb.value) : selected.delete(cb.value);
  });
  updateBulkBar();
});

document.querySelectorAll("[data-bulk]").forEach((btn) =>
  btn.addEventListener("click", () => runBulk(btn.dataset.bulk)));

async function runBulk(action) {
  if (!selected.size) return;
  const ids = [...selected];
  if (action === "delete" &&
      !confirm(`Delete ${ids.length} applicant(s)? This also removes their CV and quiz, and cannot be undone.`)) {
    return;
  }
  listAlert.classList.add("d-none");
  try {
    await adminCall("POST", "/admin/applications/bulk/", { ids, action });
    loadList();  // clears selection and re-renders with updated decisions
  } catch (err) {
    if (err.status !== 401) {
      listAlert.textContent = (err.data && err.data.detail) || "Bulk action failed.";
      listAlert.classList.remove("d-none");
    }
  }
}

function updatePager() {
  document.getElementById("list-count").textContent = `${pageState.count} applicant(s)`;
  document.getElementById("prev-page").disabled = !pageState.previous;
  document.getElementById("next-page").disabled = !pageState.next;
}

document.getElementById("prev-page").addEventListener("click", () => { currentPage--; loadList(); });
document.getElementById("next-page").addEventListener("click", () => { currentPage++; loadList(); });

// Debounced search
let searchTimer = null;
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentSearch = e.target.value.trim();
    currentPage = 1;
    loadList();
  }, 300);
});

// Status filter (server-side)
statusFilter.addEventListener("change", (e) => {
  currentStatus = e.target.value;   // "" | "pass" | "fail" | "pending"
  currentPage = 1;
  loadList();
});

// ------------------------------------------------------------------ Detail
const FIELD_LABELS = {
  phone: "Phone", nationality: "Nationality", country_of_residence: "Country of residence",
  gender: "Gender", institution: "Institution", institution_type: "Institution type",
  role: "Role", education: "Education", r_experience: "R experience",
  bayesian_knowledge: "Bayesian knowledge", motivation: "Motivation",
  expectations: "Expectations", created_at: "Applied at",
  final_submitted_at: "Final submission at",
};

let currentDetailId = null;

async function loadDetail(id) {
  showView("detail");
  switchTab("profile");
  currentDetailId = id;
  document.getElementById("detail-alert").classList.add("d-none");
  document.getElementById("d-fields").innerHTML = `<p class="text-muted">Loading…</p>`;
  document.getElementById("quiz-body").innerHTML = "";
  document.getElementById("quiz-summary").innerHTML = "";
  try {
    const a = await adminCall("GET", `/admin/applications/${id}/`);
    renderDetail(a);
    loadQuizBreakdown(id);
  } catch (err) {
    if (err.status !== 401) {
      document.getElementById("d-fields").innerHTML = `<p class="text-danger">Failed to load applicant.</p>`;
    }
  }
}

function renderDetail(a) {
  document.getElementById("d-name").textContent = `${a.first_name} ${a.last_name}`;
  document.getElementById("d-email").textContent = a.email;

  // Knowledge-check outcome + score
  document.getElementById("d-status").innerHTML =
    STATUS_BADGE[a.status] || esc(a.status || "");
  const scoreParts = [];
  if (a.score != null && a.total != null) scoreParts.push(`${a.score} / ${a.total}`);
  if (a.pass_mark != null) scoreParts.push(`pass mark: ${a.pass_mark}`);
  document.getElementById("d-score-info").textContent =
    scoreParts.length ? "· " + scoreParts.join(" · ") : "";

  // Staff decision
  document.getElementById("d-decision").innerHTML =
    DECISION_BADGE[a.decision] || esc(a.decision || "");

  const cv = document.getElementById("d-cv");
  if (a.cv) { cv.href = a.cv; cv.classList.remove("d-none"); }
  else { cv.classList.add("d-none"); }

  const dl = document.getElementById("d-fields");
  dl.innerHTML = "";
  Object.entries(FIELD_LABELS).forEach(([key, label]) => {
    if (!(key in a)) return;
    let val = a[key];
    if ((key === "created_at" || key === "final_submitted_at") && val) {
      val = new Date(val).toLocaleString();
    }
    dl.insertAdjacentHTML("beforeend",
      `<dt class="col-sm-3 text-muted">${label}</dt>
       <dd class="col-sm-9">${val ? esc(String(val)) : "<span class='text-muted'>—</span>"}</dd>`);
  });
}

async function loadQuizBreakdown(id) {
  const summary = document.getElementById("quiz-summary");
  const body = document.getElementById("quiz-body");
  try {
    const q = await adminCall("GET", `/admin/applications/${id}/quiz/`);
    summary.innerHTML = `
      <div class="alert alert-info d-flex justify-content-between mb-0">
        <span><strong>Score:</strong> ${q.score} / ${q.total}</span>
        <span>${q.completed_at ? "Completed " + new Date(q.completed_at).toLocaleString() : "Not completed"}</span>
      </div>`;
    body.innerHTML = "";
    q.questions.forEach((item) => {
      const result = item.timed_out
        ? '<span class="badge bg-secondary-soft">Timed out</span>'
        : item.is_correct
          ? '<span class="badge bg-success-soft"><i class="bi bi-check-lg"></i></span>'
          : '<span class="badge bg-danger-soft"><i class="bi bi-x-lg"></i></span>';
      body.insertAdjacentHTML("beforeend", `
        <tr>
          <td>${item.position + 1}</td>
          <td>${esc(item.question_text)}</td>
          <td><span class="badge category-pill">${esc((item.category || "").toLowerCase())}</span></td>
          <td>${item.submitted_answer ? esc(item.submitted_answer) : "<span class='text-muted'>—</span>"}</td>
          <td>${esc(item.correct_answer)}</td>
          <td class="text-center">${result}</td>
        </tr>`);
    });
  } catch (err) {
    if (err.status === 404) {
      summary.innerHTML = `<div class="alert alert-secondary mb-0">This applicant has not started the quiz.</div>`;
    } else if (err.status !== 401) {
      summary.innerHTML = `<div class="alert alert-danger mb-0">Failed to load quiz breakdown.</div>`;
    }
  }
}

// Tabs
document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

function switchTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.getElementById("tab-profile").classList.toggle("d-none", name !== "profile");
  document.getElementById("tab-quiz").classList.toggle("d-none", name !== "quiz");
}

document.getElementById("back-to-list").addEventListener("click", () => loadList());

// Detail decision buttons
document.querySelectorAll("[data-decision]").forEach((btn) =>
  btn.addEventListener("click", () => setDecision(btn.dataset.decision)));

async function setDecision(action) {
  if (!currentDetailId) return;
  const detailAlert = document.getElementById("detail-alert");
  detailAlert.classList.add("d-none");
  try {
    const a = await adminCall("PATCH", `/admin/applications/${currentDetailId}/`,
      { decision: DECISION_VALUE[action] });
    document.getElementById("d-decision").innerHTML =
      DECISION_BADGE[a.decision] || esc(a.decision || "");
  } catch (err) {
    if (err.status !== 401) {
      detailAlert.textContent = (err.data && err.data.detail) || "Could not update decision.";
      detailAlert.classList.remove("d-none");
    }
  }
}

// Detail delete
document.getElementById("d-delete").addEventListener("click", async () => {
  if (!currentDetailId) return;
  if (!confirm("Delete this applicant? This also removes their CV and quiz, and cannot be undone.")) return;
  try {
    await adminCall("DELETE", `/admin/applications/${currentDetailId}/`);
    loadList();
  } catch (err) {
    if (err.status !== 401) {
      const detailAlert = document.getElementById("detail-alert");
      detailAlert.textContent = (err.data && err.data.detail) || "Could not delete applicant.";
      detailAlert.classList.remove("d-none");
    }
  }
});

// ------------------------------------------------------------------ Helpers
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------ CSV export (list)
// GET /admin/applications/export/ carries the Authorization header (a plain
// <a href> cannot), so we fetch the response as a blob and hand it to the
// browser via a temporary <a download>.
async function downloadFilteredCsv() {
  const params = new URLSearchParams();
  if (currentSearch) params.set("search", currentSearch);
  if (currentStatus) params.set("status", currentStatus);
  const qs = params.toString() ? `?${params}` : "";
  const btn = document.getElementById("export-list-btn");
  if (btn) btn.disabled = true;
  try {
    // Base URL from js/api.js's const API — deliberately not going through
    // apiJson because it forces Accept: JSON and tries to parse a CSV body.
    const res = await fetch(`${API}/admin/applications/export/${qs}`, {
      headers: { Authorization: `Token ${TOKEN.get()}` },
    });
    if (res.status === 401) { TOKEN.set(null); showView("login"); return; }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      alert(`Export failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const filename =
      (res.headers.get("Content-Disposition") || "").match(/filename="?([^"]+)"?/)?.[1] ||
      `applicants-${new Date().toISOString().slice(0, 10)}.csv`;
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    if (btn) btn.disabled = false;
  }
}
document.getElementById("export-list-btn").addEventListener("click", downloadFilteredCsv);

// ------------------------------------------------------------------ Shortlist builder
document.getElementById("nav-shortlist").addEventListener("click", (e) => {
  e.preventDefault();
  showView("shortlist");
});
document.getElementById("back-to-list-from-shortlist").addEventListener("click", () => loadList());

const shortlistForm = document.getElementById("shortlist-form");
const shortlistAlert = document.getElementById("shortlist-alert");
let lastShortlistBody = null;   // remembered so Export can send the same settings

function shortlistPayload() {
  const fd = new FormData(shortlistForm);
  const num = (k, fallback) => {
    const raw = fd.get(k);
    const n = raw != null ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    seats: num("seats", 25),
    min_women: num("min_women", 10),
    min_tanzania: num("min_tanzania", 12),
    max_per_institution: num("max_per_institution", 3),
    waitlist: num("waitlist", 10),
    travel: fd.get("travel") || "prefer",
    pool: fd.get("pool") || "submitted",
    drop_bluff: !!fd.get("drop_bluff"),
  };
}

shortlistForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  shortlistAlert.classList.add("d-none");
  const btn = document.getElementById("build-shortlist-btn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Building…`;
  try {
    const body = shortlistPayload();
    lastShortlistBody = body;
    const res = await adminCall("POST", "/admin/shortlist/", body);
    renderShortlist(res);
    // Export button appears only if backend granted export permission.
    const exportBtn = document.getElementById("export-shortlist-btn");
    if (exportBtn && USER && USER.can_export) exportBtn.classList.remove("d-none");
  } catch (err) {
    if (err.status !== 401) {
      shortlistAlert.textContent = (err.data && err.data.detail) || "Could not build the shortlist.";
      shortlistAlert.classList.remove("d-none");
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-play-fill me-1"></i> Build shortlist`;
  }
});

function renderShortlist(res) {
  const floorsEl = document.getElementById("shortlist-floors");
  const adviceEl = document.getElementById("shortlist-advice");
  const wrap = document.getElementById("shortlist-table-wrap");
  const body = document.getElementById("shortlist-body");
  const floors = res.floors || {};
  const stats = res.stats || {};

  // Floors summary. `*_met: false` shows in danger to flag an unmeetable floor.
  const chip = (label, required, achieved, met) => {
    const cls = met === false ? "bg-danger-soft" : "bg-success-soft";
    return `<span class="badge ${cls} me-2 mb-2">${label}: ${achieved} / ${required}</span>`;
  };
  const parts = [];
  if (floors.women_required != null) parts.push(chip("Women", floors.women_required, floors.women || 0, floors.women_met));
  if (floors.tanzania_required != null) parts.push(chip("Tanzania-based", floors.tanzania_required, floors.tanzania || 0, floors.tanzania_met));
  if (floors.largest_institution != null) parts.push(chip("Largest institution seats", floors.max_per_institution || "-", floors.largest_institution, true));
  if (floors.travel_unconfirmed != null) parts.push(chip("Travel unconfirmed picks", "-", floors.travel_unconfirmed, true));
  if (stats.median_score != null) parts.push(chip("Median score of picks", "-", stats.median_score, true));
  floorsEl.innerHTML = parts.length
    ? `<div class="mb-2">${parts.join("")}</div>`
    : "";

  adviceEl.innerHTML = stats.advice
    ? `<div class="alert alert-info small">${esc(stats.advice)}</div>`
    : "";

  body.innerHTML = "";
  (res.rows || []).forEach((r) => {
    const pick = r.shortlisted
      ? '<span class="badge bg-success-soft">Shortlisted</span>'
      : (r.waitlisted ? '<span class="badge bg-warning-soft">Waitlist</span>' : "");
    const flags = (r.flags || []).map((f) => `<span class="badge bg-secondary-soft me-1">${esc(f)}</span>`).join("");
    const score = r.score != null ? r.score.toFixed ? r.score.toFixed(1) : r.score : "-";
    body.insertAdjacentHTML("beforeend", `
      <tr class="${r.shortlisted ? "cursor-pointer" : ""}">
        <td class="fw-semibold">${r.rank != null ? r.rank : ""}</td>
        <td>${esc(r.first_name || "")} ${esc(r.last_name || "")}</td>
        <td>${esc(r.country_of_residence || "")}</td>
        <td>${esc(r.institution || "")}</td>
        <td class="text-center">${score}</td>
        <td>${flags}</td>
        <td>${pick}</td>
      </tr>`);
  });
  wrap.classList.remove("d-none");
}

document.getElementById("export-shortlist-btn").addEventListener("click", async () => {
  if (!lastShortlistBody) return;
  const btn = document.getElementById("export-shortlist-btn");
  btn.disabled = true;
  try {
    const body = { ...lastShortlistBody, only_shortlist: false };
    const res = await fetch(`${API}/admin/shortlist/export/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${TOKEN.get()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { TOKEN.set(null); showView("login"); return; }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      alert(`Export failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const filename =
      (res.headers.get("Content-Disposition") || "").match(/filename="?([^"]+)"?/)?.[1] ||
      `shortlist-${new Date().toISOString().slice(0, 10)}.csv`;
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ Boot
(async function boot() {
  if (!TOKEN.get()) { showView("login"); return; }
  // Validate the saved token before showing anything staff-only.
  try {
    const user = await apiJson("GET", "/admin/me/", undefined, TOKEN.get());
    USER = user || null;
    setNavUser(user);
    applyPermissions();
    loadList();
  } catch {
    TOKEN.set(null);
    showView("login");
  }
})();
