// Custom admin panel. Token auth; the token lives in sessionStorage (not
// localStorage) to reduce XSS exposure.
const TOKEN = {
  get()  { return sessionStorage.getItem("admin_token"); },
  set(v) { v ? sessionStorage.setItem("admin_token", v) : sessionStorage.removeItem("admin_token"); },
};

const views = {
  login:     document.getElementById("view-login"),
  list:      document.getElementById("view-list"),
  shortlist: document.getElementById("view-shortlist"),
  detail:    document.getElementById("view-detail"),
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const el = (id) => document.getElementById(id);
const hide = (node, condition) => node && node.classList.toggle("hidden", condition);

function showView(name) {
  Object.entries(views).forEach(([k, node]) => hide(node, k !== name));
  hide(el("nav-username"), name === "login");
  hide(el("logout-btn"), name === "login");
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

/* ------------------------------------------------------------------ login */
const loginForm = el("login-form");
const loginAlert = el("login-alert");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hide(loginAlert, true);
  const button = el("login-btn");
  button.disabled = true;
  const data = new FormData(loginForm);
  try {
    const res = await apiJson("POST", "/admin/login/", {
      username: data.get("username"),
      password: data.get("password"),
    });
    TOKEN.set(res.token);
    setNavUser(res.user);
    loginForm.reset();
    loadList();
  } catch (err) {
    loginAlert.textContent = (err.data && err.data.detail) || "Sign in failed.";
    hide(loginAlert, false);
  } finally {
    button.disabled = false;
  }
});

// Viewers get a read-only panel. The server enforces the same rules, so this is
// purely about not showing buttons that would come back 403.
let CAN_REVIEW = true;

function setNavUser(user) {
  const role = user.is_superuser ? " · superuser" : user.role === "viewer" ? " · view only" : "";
  el("nav-username").textContent = user.username + role;
  CAN_REVIEW = user.can_review !== false;
  hide(el("viewer-badge"), CAN_REVIEW);
  hide(el("export-csv"), user.can_export === false);
  // Viewers can build a shortlist -- it computes a ranking, it records nothing --
  // but the CSV of it is a bulk export, so it follows the same rule as the other.
  hide(el("sl-csv"), user.can_export === false);
  hide(el("sl-csv-short"), user.can_export === false);
  hide(el("select-all").closest("th"), !CAN_REVIEW);
  hide(el("decision-controls"), !CAN_REVIEW);
}

el("logout-btn").addEventListener("click", async () => {
  try { await adminCall("POST", "/admin/logout/"); } catch { /* ignore */ }
  TOKEN.set(null);
  showView("login");
});

/* ------------------------------------------------------------------- list */
let currentPage = 1, currentSearch = "", currentStatus = "";
const selected = new Set();

const applicantsBody = el("applicants-body");
const listAlert = el("list-alert");

const STATUS_TAG = {
  PASS:    '<span class="tag tag-ok">Pass</span>',
  FAIL:    '<span class="tag tag-bad">Fail</span>',
  PENDING: '<span class="tag tag-mute">Pending</span>',
};
const QUIZ_TAG = {
  not_started: '<span class="tag tag-mute">Not started</span>',
  in_progress: '<span class="tag tag-warn">In progress</span>',
  completed:   '<span class="tag tag-dark">Completed</span>',
};
const DECISION_TAG = {
  PENDING:  '<span class="tag tag-mute">Pending</span>',
  SELECTED: '<span class="tag tag-ok">Selected</span>',
  REJECTED: '<span class="tag tag-bad">Rejected</span>',
};
const DECISION_VALUE = { select: "SELECTED", reject: "REJECTED", pending: "PENDING" };

async function loadList() {
  showView("list");
  selected.clear();
  updateBulkBar();
  hide(listAlert, true);
  el("select-all").checked = false;
  applicantsBody.innerHTML = `<tr><td colspan="10" class="muted">Loading…</td></tr>`;

  const params = new URLSearchParams();
  if (currentSearch) params.set("search", currentSearch);
  if (currentStatus) params.set("status", currentStatus);
  if (currentPage > 1) params.set("page", currentPage);
  const qs = params.toString() ? `?${params}` : "";

  try {
    const data = await adminCall("GET", `/admin/applications/${qs}`);
    renderList(data.results);
    el("list-count").textContent = `${data.count} applicant${data.count === 1 ? "" : "s"}`;
    el("prev-page").disabled = !data.previous;
    el("next-page").disabled = !data.next;
  } catch (err) {
    if (err.status !== 401) {
      applicantsBody.innerHTML = `<tr><td colspan="10" class="err">Failed to load applicants.</td></tr>`;
    }
  }
}

function renderList(rows) {
  if (!rows.length) {
    applicantsBody.innerHTML = `<tr><td colspan="10" class="muted">No applicants found.</td></tr>`;
    return;
  }
  applicantsBody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="select-cell${CAN_REVIEW ? "" : " hidden"}">${
        CAN_REVIEW ? `<input type="checkbox" class="row-check" value="${r.id}">` : ""}</td>
      <td><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><br>
          <span class="muted">${esc(r.email)}</span></td>
      <td>${esc(r.institution || "")}</td>
      <td>${esc(r.country_of_residence || "")}</td>
      <td>${QUIZ_TAG[r.quiz_status] || esc(r.quiz_status)}</td>
      <td>${r.score != null ? `${r.score}/${r.total}` : "—"}</td>
      <td><strong>${r.composite != null ? r.composite : "—"}</strong></td>
      <td>${STATUS_TAG[r.status] || esc(r.status || "")}</td>
      <td>${DECISION_TAG[r.decision] || esc(r.decision || "")}</td>
      <td>${(r.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</td>`;

    // Clicking the row opens the detail, except when using the checkbox.
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".select-cell")) return;
      loadDetail(r.id);
    });

    const box = tr.querySelector(".row-check");   // absent for view-only accounts
    if (box) {
      box.addEventListener("change", () => {
        box.checked ? selected.add(r.id) : selected.delete(r.id);
        updateBulkBar();
      });
    }
    applicantsBody.appendChild(tr);
  });
}

function updateBulkBar() {
  hide(el("bulk-bar"), selected.size === 0);
  el("bulk-count").textContent = `${selected.size} selected`;
}

el("select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".row-check").forEach((box) => {
    box.checked = e.target.checked;
    box.checked ? selected.add(box.value) : selected.delete(box.value);
  });
  updateBulkBar();
});

document.querySelectorAll("[data-bulk]").forEach((button) =>
  button.addEventListener("click", () => runBulk(button.dataset.bulk)));

async function runBulk(action) {
  if (!selected.size) return;
  const ids = [...selected];
  if (action === "delete" &&
      !confirm(`Delete ${ids.length} applicant(s)? This also removes their CV and quiz, and cannot be undone.`)) {
    return;
  }
  hide(listAlert, true);
  try {
    await adminCall("POST", "/admin/applications/bulk/", { ids, action });
    loadList();   // clears the selection and re-renders with updated decisions
  } catch (err) {
    if (err.status !== 401) {
      listAlert.textContent = (err.data && err.data.detail) || "Bulk action failed.";
      hide(listAlert, false);
    }
  }
}

el("prev-page").addEventListener("click", () => { currentPage--; loadList(); });
el("next-page").addEventListener("click", () => { currentPage++; loadList(); });

let searchTimer = null;
el("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentSearch = e.target.value.trim();
    currentPage = 1;
    loadList();
  }, 300);
});

el("status-filter").addEventListener("change", (e) => {
  currentStatus = e.target.value;
  currentPage = 1;
  loadList();
});

// A plain <a href> can't carry the Authorization header, so fetch the file and
// hand the browser a blob. Shared by both exports.
async function downloadCsv(path, { button, alert, body, fallback = "applicants.csv" }) {
  const label = button.textContent;
  button.disabled = true;
  button.innerHTML = `<span class="spin"></span>Exporting…`;
  hide(alert, true);

  const headers = { Authorization: `Token ${TOKEN.get()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Django rejects an unsafe request from a staff member who also holds a session
  // cookie unless it carries the CSRF token. csrfToken() is api.js's, so the two
  // stay consistent about where the token is read from.
  if (body !== undefined) {
    const token = csrfToken();
    if (token) headers["X-CSRFToken"] = token;
  }

  try {
    const res = await fetch(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { TOKEN.set(null); showView("login"); return; }
    if (!res.ok) throw new Error(`Export failed (${res.status})`);

    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/);
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"),
                               { href: url, download: match ? match[1] : fallback });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert.textContent = err.message || "Could not export.";
    hide(alert, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// The query string mirrors the list, so the download contains exactly the
// filtered rows -- not every applicant.
el("export-csv").addEventListener("click", (e) => {
  const params = new URLSearchParams();
  if (currentSearch) params.set("search", currentSearch);
  if (currentStatus) params.set("status", currentStatus);
  const qs = params.toString() ? `?${params}` : "";
  downloadCsv(`/admin/applications/export/${qs}`,
              { button: e.currentTarget, alert: listAlert });
});

/* -------------------------------------------------------------- shortlist */
// Ranking and seat allocation happen server-side (application/shortlist.py) from
// the stored answers, so the panel and any other client agree on the order -- and
// so a score computed in an applicant's browser is never part of it.
const SL_ALERT = el("sl-alert");

function shortlistOptions() {
  return {
    seats: +el("f_seats").value,
    min_women: +el("f_women").value,
    min_tanzania: +el("f_tz").value,
    max_per_institution: +el("f_inst").value,
    waitlist: +el("f_wait").value,
    travel: el("f_travel").value,
    drop_bluff: el("f_bluff").value === "1",
    pool: el("f_pool").value,
  };
}

async function buildShortlist() {
  showView("shortlist");
  hide(SL_ALERT, true);
  el("sl-body").innerHTML = `<tr><td colspan="12" class="muted">Ranking…</td></tr>`;
  try {
    renderShortlist(await adminCall("POST", "/admin/shortlist/", shortlistOptions()));
  } catch (err) {
    if (err.status !== 401) {
      el("sl-body").innerHTML = `<tr><td colspan="12" class="err">Could not build the shortlist.</td></tr>`;
    }
  }
}

function renderShortlist(data) {
  const s = data.stats;
  el("sl-stats").innerHTML = [
    [s.applications, "in the pool"],
    [s.median_score, "median score"],
    [`${s.median_correct}/${s.questions || "—"}`, "median quiz"],
    [s.bluff, "bluff flags"],
    [s.with_code, "supplied real code"],
    [s.women, "women"],
    [s.tanzania, "Tanzania-based"],
    [s.travel_unconfirmed, "travel unconfirmed"],
  ].map(([value, label]) =>
    `<div class="stat"><b>${esc(value)}</b><span>${label}</span></div>`).join("");

  el("sl-advice").innerHTML = esc(s.advice);

  const f = data.floors;
  const pill = (text, state) => `<span class="pill${state ? ` ${state}` : ""}">${text}</span>`;
  el("sl-floors").innerHTML =
    pill(`Shortlisted: ${f.shortlisted} / ${f.seats} seats`, f.seats_filled ? "ok" : "miss") +
    pill(`Women: ${f.women} / ${f.women_required} min`, f.women_met ? "ok" : "miss") +
    pill(`Tanzania-based: ${f.tanzania} / ${f.tanzania_required} min`, f.tanzania_met ? "ok" : "miss") +
    pill(`Travel unconfirmed: ${f.travel_unconfirmed}`, f.travel_unconfirmed === 0 ? "ok" : "") +
    pill(`Waitlist: ${data.settings.waitlisted}`) +
    pill(`Largest institution: ${esc(f.largest_institution)} (${f.largest_institution_count})`) +
    pill(`Median score of the shortlist: ${f.median_score}`);

  if (!data.rows.length) {
    el("sl-body").innerHTML =
      `<tr><td colspan="12" class="muted">No applications in this pool yet.</td></tr>`;
    return;
  }

  el("sl-body").innerHTML = "";
  data.rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = r.shortlisted ? "picked" : r.waitlisted ? "waiting" : "";
    tr.innerHTML = `
      <td>${r.rank}</td>
      <td><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><br>
          <span class="muted">${esc(r.email)}</span></td>
      <td>${esc(r.institution || "")}</td>
      <td>${esc(r.country_of_residence || "")}</td>
      <td>${esc(r.gender || "")}</td>
      <td><strong>${r.total}</strong></td>
      <td>${r.knowledge} <span class="muted">(${r.correct}/${r.of})</span></td>
      <td>${r.honesty}</td>
      <td>${r.relevance}</td>
      <td>${r.impact}</td>
      <td>${r.shortlisted ? '<span class="tag tag-ok">Shortlist</span>'
            : r.waitlisted ? '<span class="tag tag-warn">Waitlist</span>' : ""}</td>
      <td>${(r.flags || []).map((flag) => `<span class="flag">${esc(flag)}</span>`).join("")}</td>`;
    // Clicking a row opens the application: the point of the ranking is to decide
    // whose written answers to read, so reading them is one click away.
    tr.addEventListener("click", () => loadDetail(r.id));
    el("sl-body").appendChild(tr);
  });
}

el("go-shortlist").addEventListener("click", buildShortlist);
el("shortlist-back").addEventListener("click", loadList);
el("sl-build").addEventListener("click", buildShortlist);

el("sl-csv").addEventListener("click", (e) =>
  downloadCsv("/admin/shortlist/export/", {
    button: e.currentTarget, alert: SL_ALERT, fallback: "shortlist.csv",
    body: shortlistOptions(),
  }));

el("sl-csv-short").addEventListener("click", (e) =>
  downloadCsv("/admin/shortlist/export/", {
    button: e.currentTarget, alert: SL_ALERT, fallback: "shortlist.csv",
    body: { ...shortlistOptions(), only_shortlist: true },
  }));

/* ----------------------------------------------------------------- detail */
const PROFILE_FIELDS = [
  ["phone", "Phone"], ["nationality", "Nationality"],
  ["country_of_residence", "Country of residence"], ["gender", "Gender"],
  ["institution", "Institution"], ["institution_type", "Institution type"],
  ["role", "Role"], ["education", "Education"],
  ["r_experience", "R experience (self-rated)"],
  ["bayesian_knowledge", "Bayesian knowledge (self-rated)"],
  ["created_at", "Applied at"], ["final_submitted_at", "Final submission"],
  ["ineligible_reason", "Stopped because"],
];

const ELIGIBILITY_FIELDS = [
  ["elig_attend", "Can attend all four days"], ["elig_laptop", "Will bring a laptop"],
  ["elig_data", "Has spatial data"], ["elig_funding", "Travel funding"],
];

const EXPERIENCE_FIELDS = [
  ["exp_rfreq", "Writes/runs R"], ["exp_rself", "Self-rated R skills"],
  ["exp_bayes", "Bayesian familiarity"], ["exp_glm", "Fitted a GLM recently"],
  ["exp_dtype", "Data type"], ["exp_when", "Would apply the methods"],
  ["exp_share", "Would share internally"], ["exp_use", "Analyses used for decisions"],
];

const WRITTEN_FIELDS = [
  ["written_dataset", "1. A dataset they analysed"],
  ["written_code", "2. Their own R code"],
  ["written_why_not_ols", "3. Why OLS would be a poor choice"],
  ["written_other", "4. Anything else"],
  ["motivation", "5. Motivation"],
  ["expectations", "6. Expectations"],
];

let currentDetailId = null;

async function loadDetail(id) {
  showView("detail");
  switchTab("profile");
  currentDetailId = id;
  hide(el("detail-alert"), true);
  el("d-fields").innerHTML = `<dt class="muted">Loading…</dt><dd></dd>`;
  el("quiz-body").innerHTML = "";
  el("quiz-summary").innerHTML = "";
  try {
    const applicant = await adminCall("GET", `/admin/applications/${id}/`);
    renderDetail(applicant);
    loadQuizBreakdown(id);
  } catch (err) {
    if (err.status !== 401) {
      el("d-fields").innerHTML = `<dt class="err">Failed to load applicant.</dt><dd></dd>`;
    }
  }
}

const when = (value) => (value ? new Date(value).toLocaleString() : "");

function definitionList(applicant, fields) {
  return fields
    .filter(([key]) => applicant[key])
    .map(([key, label]) => {
      const value = key.endsWith("_at") ? when(applicant[key]) : applicant[key];
      return `<dt>${label}</dt><dd>${esc(value)}</dd>`;
    }).join("");
}

function renderDetail(a) {
  el("d-name").textContent = `${a.first_name} ${a.last_name}`;
  el("d-email").textContent = a.email;
  el("d-decision").innerHTML = DECISION_TAG[a.decision] || esc(a.decision || "");

  const status = STATUS_TAG[a.status] || esc(a.status || "");
  el("d-status").innerHTML = a.score != null
    ? `${status} <span class="muted">${a.score}/${a.total}, pass mark ${a.pass_mark}</span>`
    : status;

  const s = a.assessment || {};
  el("d-composite").innerHTML = s.total != null
    ? `<span class="muted">Composite</span> <strong>${s.total}</strong><span class="muted">/100 —
       knowledge ${s.knowledge}, honesty ${s.honesty}, relevance ${s.relevance}, impact ${s.impact}</span>`
    : "";
  el("d-flags").innerHTML = (s.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join("");

  // `a.cv` carries a short-lived signature, so a plain link is enough -- no
  // header, no fetch. Same URL the standalone frontends use.
  const cv = el("d-cv");
  if (a.cv) { cv.href = a.cv; hide(cv, false); }
  else { cv.removeAttribute("href"); hide(cv, true); }

  const section = (title, fields) =>
    fields.some(([k]) => a[k]) ? `<dt class="muted">— ${title} —</dt><dd></dd>` + definitionList(a, fields) : "";

  el("d-fields").innerHTML =
    definitionList(a, PROFILE_FIELDS) +
    section("Eligibility", ELIGIBILITY_FIELDS) +
    section("Experience", EXPERIENCE_FIELDS);

  renderAnswers(a);
}

// "Their answers" tab: the honesty grid and the written answers -- the two
// things a reviewer actually reads.
function renderAnswers(a) {
  const summary = a.claim_summary || {};
  const claims = a.claims || {};
  const rows = Object.keys(claims).sort();
  const fake = new Set(summary.fake_names || []);
  const LABEL = { used: "Used it", heard: "Heard of it", no: "Doesn't know it" };

  const honesty = rows.length ? `
    <h2>Honesty check</h2>
    <p class="muted">Claimed ${summary.real_used}/${summary.real_total} real functions.
      ${summary.fakes_claimed
        ? `<span class="flag">Claimed ${summary.fakes_claimed} invented function(s)${
            summary.bluffs ? `, ${summary.bluffs} as used` : ""}</span>`
        : "No invented functions claimed."}</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Function</th><th>Answer</th><th>Real?</th></tr></thead>
      <tbody>${rows.map((fn) => `
        <tr><td><code>${esc(fn)}()</code></td>
            <td>${LABEL[claims[fn]] || esc(claims[fn])}</td>
            <td>${fake.has(fn) ? '<span class="tag tag-bad">Invented</span>'
                               : '<span class="tag tag-mute">Real</span>'}</td></tr>`).join("")}
      </tbody></table></div>` : "";

  const written = WRITTEN_FIELDS.filter(([k]) => a[k]).map(([key, label]) => `
    <h3>${label}</h3>
    ${key === "written_code"
      ? `<pre class="code">${esc(a[key])}</pre>`
      : `<p style="white-space:pre-wrap">${esc(a[key])}</p>`}`).join("");

  el("d-answers").innerHTML =
    (honesty + (written ? `<h2>Written answers</h2>${written}` : "")) ||
    `<p class="muted">This applicant has not answered these steps yet.</p>`;
}

document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => switchTab(button.dataset.tab)));

function switchTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === name));
  ["profile", "answers", "quiz"].forEach((t) => hide(el(`tab-${t}`), t !== name));
}

async function loadQuizBreakdown(id) {
  try {
    const q = await adminCall("GET", `/admin/applications/${id}/quiz/`);
    el("quiz-summary").innerHTML = `
      <div class="note"><strong>${q.score} / ${q.total}</strong> correct
        ${q.completed_at ? `· completed ${when(q.completed_at)}` : "· in progress"}</div>`;
    el("quiz-body").innerHTML = q.questions.map((item) => `
      <tr>
        <td>${item.position + 1}</td>
        <td>${esc(item.question_text)}</td>
        <td class="muted">${esc((item.category || "").toLowerCase())}</td>
        <td>${esc(item.submitted_answer || "—")}</td>
        <td>${esc(item.correct_answer)}</td>
        <td>${item.is_correct ? '<span class="tag tag-ok">Correct</span>'
              : item.timed_out ? '<span class="tag tag-warn">Timed out</span>'
              : '<span class="tag tag-bad">Wrong</span>'}</td>
      </tr>`).join("");
  } catch (err) {
    if (err.status === 404) {
      el("quiz-summary").innerHTML =
        `<p class="muted">This applicant has not started the knowledge check.</p>`;
    }
  }
}

document.querySelectorAll("[data-decision]").forEach((button) =>
  button.addEventListener("click", async () => {
    hide(el("detail-alert"), true);
    try {
      const updated = await adminCall("PATCH", `/admin/applications/${currentDetailId}/`,
                                      { decision: DECISION_VALUE[button.dataset.decision] });
      renderDetail(updated);
    } catch (err) {
      if (err.status !== 401) {
        el("detail-alert").textContent =
          (err.data && err.data.detail) || "Could not update the decision.";
        hide(el("detail-alert"), false);
      }
    }
  }));

el("d-delete").addEventListener("click", async () => {
  if (!confirm("Delete this applicant? This also removes their CV and quiz, and cannot be undone.")) return;
  try {
    await adminCall("DELETE", `/admin/applications/${currentDetailId}/`);
    loadList();
  } catch (err) {
    if (err.status !== 401) {
      el("detail-alert").textContent =
        (err.data && err.data.detail) || "Could not delete the applicant.";
      hide(el("detail-alert"), false);
    }
  }
});

el("back-to-list").addEventListener("click", loadList);

/* ------------------------------------------------------------------- boot */
(async function boot() {
  if (!TOKEN.get()) { showView("login"); return; }
  // Validate the saved token before showing anything staff-only.
  try {
    const user = await apiJson("GET", "/admin/me/", undefined, TOKEN.get());
    setNavUser(user);
    loadList();
  } catch {
    TOKEN.set(null);
    showView("login");
  }
})();
