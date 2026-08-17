// Applicant journey state machine (see backend README_FRONTEND).
// Six visible steps + prep splash + terminal Ineligible / Done screens.
//   1. Details       (POST /applications/)
//   2. Eligibility   (POST /applications/{id}/eligibility/) — server may reject
//   3. Experience    (POST /applications/{id}/experience/)
//   4. Honesty       (GET  /applications/{id}/claims/    → shuffled function list
//                     POST /applications/{id}/claims/    with answers)
//   5. Quiz          (POST /applications/{id}/quiz/start/, POST /quiz/{s}/answer/)
//   6. Submit        (POST /applications/{id}/finalize/) — written prompts + CV
// Boot re-validates with /status/ so stale ids don't strand the user.
const LS = {
  get appId()  { return localStorage.getItem("application_id"); },
  set appId(v) { v ? localStorage.setItem("application_id", v) : localStorage.removeItem("application_id"); },
  get sessId() { return localStorage.getItem("session_id"); },
  set sessId(v){ v ? localStorage.setItem("session_id", v) : localStorage.removeItem("session_id"); },
};

// ---------------------------------------------------------------- Portal config
// Everything the applicant page needs before it renders anything:
// deadline, word/CV limits, grouped country dropdown, quiz shape.
// Loaded once on boot; hardcoded fallbacks apply only if /config/ is down.
let CONFIG = null;
const CONFIG_FALLBACK = {
  deadline: "",
  limits: { max_words: 300, cv_max_mb: 5, cv_max_pages: 2 },
  countries: [],
};

async function loadConfig() {
  try {
    CONFIG = await apiJson("GET", "/config/");
  } catch (err) {
    console.error("Could not load /api/config/ — falling back to defaults", err);
    CONFIG = CONFIG_FALLBACK;
  }
}

function populateCountrySelects() {
  const selects = document.querySelectorAll(".country-select");
  if (!selects.length) return;
  const groups = (CONFIG && CONFIG.countries) || [];
  const html = groups.map((g) => `
    <optgroup label="${g.label}">
      ${g.countries.map((c) => `<option value="${c}">${c}</option>`).join("")}
    </optgroup>
  `).join("");
  selects.forEach((sel) => sel.insertAdjacentHTML("beforeend", html));
}

function fillDeadlinePlaceholders() {
  const deadline = (CONFIG && CONFIG.deadline) || "";
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    if (deadline) el.textContent = deadline;
  });
  const duration = (CONFIG && CONFIG.duration) || "";
  document.querySelectorAll("[data-duration]").forEach((el) => {
    if (duration) el.textContent = duration;
  });
  const limits = (CONFIG && CONFIG.limits) || {};
  if (limits.max_words) {
    document.querySelectorAll("[data-max-words]").forEach((el) => {
      // Only replace text inside <span data-max-words>…</span>; leave textarea
      // attributes alone (those are the fallback for word counters).
      if (el.tagName === "SPAN") el.textContent = String(limits.max_words);
    });
  }
  if (limits.cv_max_pages != null) {
    document.querySelectorAll("[data-cv-max-pages]").forEach((el) => (el.textContent = String(limits.cv_max_pages)));
  }
  if (limits.cv_max_mb != null) {
    document.querySelectorAll("[data-cv-max-mb]").forEach((el) => (el.textContent = String(limits.cv_max_mb)));
  }
}

// Step 0 checklist: Begin stays disabled until every box is ticked.
function wireupPrepChecklist() {
  const list = document.getElementById("prep-checklist");
  const begin = document.getElementById("begin-application");
  const printBtn = document.getElementById("print-checklist");
  if (!list || !begin) return;
  const boxes = list.querySelectorAll('input[type="checkbox"]');
  const sync = () => {
    const allTicked = [...boxes].every((b) => b.checked);
    begin.disabled = !allTicked;
  };
  boxes.forEach((b) => b.addEventListener("change", sync));
  sync();
  if (printBtn) printBtn.addEventListener("click", () => window.print());
}

function configMaxWords() {
  return (CONFIG && CONFIG.limits && CONFIG.limits.max_words) || 300;
}

// ---------------------------------------------------------------- Screens + stepper
const screens = {
  prep:        document.getElementById("screen-prep"),
  form:        document.getElementById("screen-form"),
  eligibility: document.getElementById("screen-eligibility"),
  ineligible:  document.getElementById("screen-ineligible"),
  experience:  document.getElementById("screen-experience"),
  claims:      document.getElementById("screen-claims"),
  intro:       document.getElementById("screen-intro"),
  question:    document.getElementById("screen-question"),
  result:      document.getElementById("screen-result"),
  docs:        document.getElementById("screen-docs"),
  final:       document.getElementById("screen-final"),
  done:        document.getElementById("screen-done"),
};

// Pill row on the stepper (7 items).
const STEP_ORDER = ["form", "eligibility", "experience", "claims", "quiz", "docs", "submit"];

// Screens with no pill are prep and ineligible (both terminal-ish).
const SCREEN_TO_STEP = {
  form: "form",
  eligibility: "eligibility",
  experience: "experience",
  claims: "claims",
  intro: "quiz",
  question: "quiz",
  result: "quiz",
  docs: "docs",
  final: "submit",
  done: "submit",
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle("d-none", k !== name));
  const active = SCREEN_TO_STEP[name];
  const currentIdx = active ? STEP_ORDER.indexOf(active) : -1;
  const allDone = name === "done";
  document.querySelectorAll("#steps [data-step]").forEach((b) => {
    const idx = STEP_ORDER.indexOf(b.dataset.step);
    b.classList.toggle("active", idx === currentIdx && !allDone);
    b.classList.toggle("done", idx >= 0 && (idx < currentIdx || allDone));
  });
}

// ---------------------------------------------------------------- Alerts + errors
const form = document.getElementById("application-form");
const formAlert = document.getElementById("form-alert");
const finalAlert = document.getElementById("final-alert");
const eligAlert = document.getElementById("elig-alert");
const expAlert = document.getElementById("exp-alert");
const claimsAlert = document.getElementById("claims-alert");
const docsAlert = document.getElementById("docs-alert");
const introAlert = document.getElementById("intro-alert");

function clearFieldErrors() {
  document.querySelectorAll("[data-error]").forEach((el) => (el.textContent = ""));
  [formAlert, finalAlert, eligAlert, expAlert, claimsAlert, docsAlert].forEach((a) => a && a.classList.add("d-none"));
}

function renderFieldErrors(err, alertBox) {
  const box = alertBox || formAlert;
  // Guarantee text is never empty so the red banner never shows blank.
  const fail = (text) => {
    box.textContent = text || "Submission failed. Check the browser console (F12).";
    box.classList.remove("d-none");
  };

  // Log the raw error every time so DevTools has the ground truth even when
  // the user-facing text is short.
  console.error("Form submission error:", err);

  // Network / CORS failure — apiJson threw a native TypeError before it
  // could build an ApiError, so there's no status and no data.
  if (!err || !("status" in err)) {
    fail(
      "Couldn't reach the server (this usually means a CORS or network problem). " +
      "Open DevTools (F12) → Network tab, re-submit, and share the failing request."
    );
    return;
  }

  const data = err.data;
  const status = err.status;

  // Standard DRF response: {field: [msgs]} or {detail: "..."}
  if (data && typeof data === "object" && !Array.isArray(data)) {
    let handledAny = false;
    Object.entries(data).forEach(([field, msgs]) => {
      const target = document.querySelector(`[data-error="${field}"]`);
      const text = Array.isArray(msgs) ? msgs.join(" ") : String(msgs);
      if (target) { target.textContent = text; handledAny = true; }
      else if (field === "detail") { fail(text); handledAny = true; }
    });
    if (!handledAny) fail(`Server responded with ${status}: ${JSON.stringify(data)}`);
    return;
  }

  // HTML or plain-text error page — surface at least the first line.
  if (typeof data === "string" && data.trim()) {
    fail(`Server responded with ${status}: ${data.split("\n")[0].slice(0, 200)}`);
    return;
  }

  // No useful body at all.
  fail(`Server responded with ${status}. Please try again in a moment.`);
}

// ---------------------------------------------------------------- Prep splash
const beginBtn = document.getElementById("begin-application");
if (beginBtn) {
  beginBtn.addEventListener("click", () => {
    clearFieldErrors();
    showScreen("form");
  });
}

// ---------------------------------------------------------------- Step 1: details
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-application");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving…`;
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    const app = await apiJson("POST", "/applications/", payload);
    LS.appId = app.id;
    LS.sessId = null;
    showScreen("eligibility");
  } catch (err) {
    renderFieldErrors(err, formAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Next <i class="bi bi-arrow-right ms-1"></i>`;
  }
});

// ---------------------------------------------------------------- Option groups
// Multi-choice pill buttons used by eligibility, experience and claims.
// Each .quiz-option-group carries the field name in data-group; each option
// carries the string value in data-value. Clicking marks the group's value.
function initOptionGroups(scope) {
  scope.querySelectorAll(".quiz-option-group").forEach((group) => {
    group.querySelectorAll(".quiz-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".quiz-option").forEach((o) => o.classList.remove("active"));
        btn.classList.add("active");
        group.dataset.value = btn.dataset.value;
      });
    });
  });
}
function collectGroupValues(scope) {
  const out = {};
  scope.querySelectorAll(".quiz-option-group").forEach((g) => {
    if (g.dataset.value) out[g.dataset.group] = g.dataset.value;
  });
  return out;
}

initOptionGroups(document.getElementById("eligibility-form"));
initOptionGroups(document.getElementById("experience-form"));

// ---------------------------------------------------------------- Step 2: eligibility
document.getElementById("eligibility-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-eligibility");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving…`;
  try {
    const payload = collectGroupValues(document.getElementById("eligibility-form"));
    const res = await apiJson("POST", `/applications/${LS.appId}/eligibility/`, payload);
    if (res && res.eligible === false) { showIneligible(res.reason); return; }
    showScreen("experience");
  } catch (err) {
    renderFieldErrors(err, eligAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Continue <i class="bi bi-arrow-right ms-1"></i>`;
  }
});

function showIneligible(reason) {
  document.getElementById("ineligible-reason").textContent = reason || "";
  showScreen("ineligible");
}

document.getElementById("change-eligibility").addEventListener("click", () => {
  clearFieldErrors();
  showScreen("eligibility");
});

// ---------------------------------------------------------------- Step 3: experience
document.getElementById("experience-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-experience");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving…`;
  try {
    const payload = collectGroupValues(document.getElementById("experience-form"));
    await apiJson("POST", `/applications/${LS.appId}/experience/`, payload);
    showScreen("claims");
    loadClaims();
  } catch (err) {
    renderFieldErrors(err, expAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Continue <i class="bi bi-arrow-right ms-1"></i>`;
  }
});

// ---------------------------------------------------------------- Step 4: honesty
async function loadClaims() {
  const list = document.getElementById("claims-list");
  list.innerHTML = `<p class="text-muted text-center my-4">Loading…</p>`;
  try {
    const res = await apiJson("GET", `/applications/${LS.appId}/claims/`);
    list.innerHTML = res.functions.map((name) => `
      <div class="claim-row mb-3">
        <p class="mb-2"><code class="claim-name">${name}</code></p>
        <div class="quiz-option-group" data-group="${name}">
          <button type="button" class="btn btn-outline-secondary quiz-option" data-value="used">Used</button>
          <button type="button" class="btn btn-outline-secondary quiz-option" data-value="heard">Heard of</button>
          <button type="button" class="btn btn-outline-secondary quiz-option" data-value="no">Not familiar</button>
        </div>
      </div>
    `).join("");
    initOptionGroups(list);
  } catch (err) {
    list.innerHTML = `<p class="text-danger text-center my-4">Could not load the questions. Please refresh.</p>`;
  }
}

document.getElementById("submit-claims").addEventListener("click", async () => {
  clearFieldErrors();
  const list = document.getElementById("claims-list");
  const claims = collectGroupValues(list);
  const btn = document.getElementById("submit-claims");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving…`;
  try {
    await apiJson("POST", `/applications/${LS.appId}/claims/`, { claims });
    showScreen("intro");
  } catch (err) {
    renderFieldErrors(err, claimsAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Continue to the quiz <i class="bi bi-arrow-right ms-1"></i>`;
  }
});

// ---------------------------------------------------------------- Step 5: quiz start
document.getElementById("start-quiz").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  introAlert.classList.add("d-none");
  try {
    const q = await apiJson("POST", `/applications/${LS.appId}/quiz/start/`);
    LS.sessId = q.session;
    renderQuestion(q);
  } catch (err) {
    if (err.status === 404) {
      resetJourney();
      showScreen("prep");
      return;
    }
    if (err.status === 403) {
      // Ineligible — surface the reason the server stored so the user knows why.
      const msg = err.data && (err.data.detail || err.data.reason || "");
      showIneligible(msg || "This application is not eligible to take the quiz.");
      return;
    }
    const msg = err.data && (err.data.detail || JSON.stringify(err.data));
    introAlert.textContent = msg || "Could not start the quiz.";
    introAlert.classList.remove("d-none");
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------- Step 5b: question loop
let countdownTimer = null;
let selectedAnswer = null;
let currentDeadline = null;

const els = {
  progress:    document.getElementById("q-progress"),
  progressbar: document.getElementById("q-progressbar"),
  category:    document.getElementById("q-category"),
  countdown:   document.getElementById("q-countdown"),
  text:        document.getElementById("q-text"),
  options:     document.getElementById("q-options"),
  submit:      document.getElementById("submit-answer"),
  status:      document.getElementById("q-status"),
};

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function startCountdown(seconds) {
  stopCountdown();
  // Server sends `remaining_seconds`; we count against a monotonic clock
  // (performance.now) rather than Date.now / deadline, so a device clock
  // out of sync doesn't wreck the countdown. Server still enforces the
  // real deadline on the answer POST.
  const started = performance.now();
  const total = Math.max(0, Number(seconds) || 0);
  currentDeadline = started + total * 1000;
  const tick = () => {
    const elapsed = (performance.now() - started) / 1000;
    const remaining = Math.max(0, Math.round(total - elapsed));
    els.countdown.textContent = `${remaining}s`;
    els.countdown.classList.toggle("danger", remaining <= 5);
    if (remaining <= 0) {
      stopCountdown();
      // Freeze the option buttons so the applicant can see time ran out
      // and that we're moving on automatically.
      els.options.querySelectorAll(".quiz-option").forEach((o) => (o.disabled = true));
      els.countdown.textContent = "0s";
      els.status.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Time's up — loading next…`;
      submitAnswer(true);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function renderQuestion(payload) {
  showScreen("question");
  selectedAnswer = null;
  els.submit.disabled = true;
  els.status.textContent = "";

  const q = payload.question;
  const shown = payload.position + 1;
  els.progress.textContent = `Question ${shown} of ${payload.total}`;
  els.progressbar.style.width = `${(shown / payload.total) * 100}%`;
  els.category.textContent = (q.category || "").toLowerCase();
  els.text.textContent = q.text;

  els.options.innerHTML = "";
  q.options.forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-outline-secondary quiz-option";
    b.textContent = opt;
    b.addEventListener("click", () => {
      selectedAnswer = opt;
      els.options.querySelectorAll(".quiz-option").forEach((o) => o.classList.remove("active"));
      b.classList.add("active");
      els.submit.disabled = false;
    });
    els.options.appendChild(b);
  });

  // Prefer server-computed remaining_seconds (clamped by the backend);
  // fall back to time_limit_seconds if a call site didn't include it.
  const secs = payload.remaining_seconds != null
    ? payload.remaining_seconds
    : (payload.time_limit_seconds != null ? payload.time_limit_seconds : 25);
  startCountdown(secs);
}

els.submit.addEventListener("click", () => submitAnswer(false));

let submitting = false;
async function submitAnswer(auto) {
  if (submitting) return;
  submitting = true;
  stopCountdown();
  els.submit.disabled = true;
  const answer = selectedAnswer || "";
  // Two attempts: covers a transient network hiccup at the moment the timer
  // fires an auto-submit. The deadline is server-authoritative, so retrying
  // won't game the clock — a late answer stays timed_out server-side.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await apiJson("POST", `/quiz/${LS.sessId}/answer/`, { answer });
      if (res.finished) {
        showResult(res.result);
      } else {
        renderQuestion(res.next);
      }
      submitting = false;
      return;
    } catch (err) {
      lastErr = err;
      console.error(`Quiz answer submit failed (attempt ${attempt + 1}):`, err);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }
  els.status.innerHTML =
    `<span class="text-danger">Couldn't reach the server. </span>` +
    `<a href="#" id="q-retry">Try again</a>`;
  const retry = document.getElementById("q-retry");
  if (retry) retry.addEventListener("click", (e) => {
    e.preventDefault();
    submitAnswer(auto);
  });
  submitting = false;
}

// ---------------------------------------------------------------- Step 5c: result
function showResult(result) {
  stopCountdown();
  showScreen("result");
  document.getElementById("r-score").textContent = result.score;
  document.getElementById("r-total").textContent = result.total;

  const icon = document.getElementById("r-icon");
  const iconWrap = icon.parentElement;
  const message = document.getElementById("r-message");
  const continueWrap = document.getElementById("r-continue-wrap");

  const unlocked = result.passed && !result.final_submitted;
  continueWrap.classList.toggle("d-none", !unlocked);

  if (result.final_submitted) {
    icon.className = "bi bi-send-check-fill";
    iconWrap.className = "auth-head-icon success";
    message.textContent = "Your application has already been submitted.";
  } else if (result.passed) {
    icon.className = "bi bi-patch-check-fill";
    iconWrap.className = "auth-head-icon success";
    message.textContent =
      "You've met the required score. One last step: your motivation, expectations and CV.";
  } else {
    icon.className = "bi bi-info-circle-fill";
    iconWrap.className = "auth-head-icon muted";
    message.textContent =
      `A score of at least ${result.pass_mark} is needed to continue. ` +
      `Thank you for your interest.`;
  }

  document.getElementById("r-completed").textContent = result.completed_at
    ? `Completed ${new Date(result.completed_at).toLocaleString()}`
    : "";

  // Keep resume state while the final step is still open. Otherwise the
  // journey is done — clear it so a fresh visit starts at prep.
  if (unlocked) {
    if (result.application) LS.appId = result.application;
    if (result.id) LS.sessId = result.id;
  } else {
    LS.sessId = null;
    LS.appId = null;
  }
}

// ------------------------------------------------- Step 6: documents (motivation, expectations, CV)
// Result screen "Continue to final step" button now routes to the docs screen
// (motivation + expectations + CV) rather than straight to the written-prompts
// form.
document.getElementById("go-final").addEventListener("click", () => {
  clearFieldErrors();
  showScreen("docs");
});

const docsForm = document.getElementById("docs-form");

// Live word count under motivation + expectations. Browser handles the
// "required" check now that docs-form is no longer novalidate; JS enforces
// the 300-word cap on submit.
function countWords(text) {
  const trimmed = (text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
function wireupWordCounters() {
  const maxFromConfig = configMaxWords();
  docsForm.querySelectorAll("textarea[data-max-words]").forEach((ta) => {
    const max = maxFromConfig || parseInt(ta.dataset.maxWords, 10) || 300;
    const counter = docsForm.querySelector(`.word-counter[data-counter-for="${ta.name}"]`);
    if (!counter) return;
    const update = () => {
      const n = countWords(ta.value);
      counter.textContent = `${n} / ${max} words`;
      counter.classList.toggle("over-limit", n > max);
    };
    ta.addEventListener("input", update);
    update();
  });
}

docsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  clearFieldErrors();
  // Values are held on the DOM inputs and combined with the written prompts
  // on Step 7 submit — no network call here. Enforce the word cap using the
  // limit from /config/, falling back to data-max-words.
  const max = configMaxWords();
  let overLimit = false;
  docsForm.querySelectorAll("textarea[data-max-words]").forEach((ta) => {
    if (countWords(ta.value) > max) {
      const target = docsForm.querySelector(`[data-error="${ta.name}"]`);
      if (target) target.textContent = `Please limit to ${max} words.`;
      overLimit = true;
    }
  });
  if (overLimit) return;
  showScreen("final");
});

// ------------------------------------------------- Step 7: submit (written prompts + finalize)
const finalForm = document.getElementById("final-form");
finalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-final");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Submitting…`;
  try {
    // Combine Step 6 (docs) + Step 7 (written) into one multipart request.
    const combined = new FormData();
    for (const [k, v] of new FormData(docsForm)) combined.append(k, v);
    for (const [k, v] of new FormData(finalForm)) combined.append(k, v);
    await apiForm("POST", `/applications/${LS.appId}/finalize/`, combined);
    // Keep LS.appId so a reload after this hits /status/ and lands on Done
    // again — clearing it here would strand a returning applicant on the prep
    // splash and let them start a duplicate application.
    showScreen("done");
  } catch (err) {
    renderFieldErrors(err, finalAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Submit application <i class="bi bi-check2-circle ms-1"></i>`;
  }
});

// ---------------------------------------------------------------- Boot / resume
function resetJourney() {
  LS.appId = null;
  LS.sessId = null;
}

async function boot() {
  if (!LS.appId) { resetJourney(); showScreen("prep"); return; }

  // Always re-validate with /status/ before trusting the stored id — the
  // record may have been deleted, or the backend may have new flags.
  let state;
  try {
    state = await apiJson("GET", `/applications/${LS.appId}/status/`);
  } catch (err) {
    resetJourney();
    showScreen("prep");
    return;
  }

  // Already submitted — keep the id so subsequent reloads still land on Done
  // rather than a fresh prep splash inviting a duplicate application.
  if (state.final_submitted) { showScreen("done"); return; }

  // Ineligible — keep the appId so the user can revise their answers via the
  // "Change my answers" button on the ineligible screen.
  if (state.ineligible_reason) {
    showIneligible(state.ineligible_reason);
    return;
  }

  // Quiz already started?
  if (state.quiz) {
    LS.sessId = state.quiz.id;
    if (state.quiz.completed_at) { showResult(state.quiz); return; }
    try {
      const data = await apiJson("GET", `/quiz/${LS.sessId}/current/`);
      if (data.question) { renderQuestion(data); return; }
      if (typeof data.score === "number") { showResult(data); return; }
    } catch (err) {
      LS.sessId = null;
    }
  }

  // Pre-quiz — resume at the earliest incomplete step.
  const done = state.completed || {};
  if (!done.eligibility) { showScreen("eligibility"); return; }
  if (!done.experience)  { showScreen("experience"); return; }
  if (!done.claims)      { showScreen("claims"); loadClaims(); return; }

  showScreen("intro");
}

// ---------------------------------------------------------------- Bootstrap
// Load /config/ first so country dropdowns, deadline text, and word-limit
// counters have real values, then hand off to boot() which runs the
// existing resume logic.
(async function bootstrap() {
  await loadConfig();
  populateCountrySelects();
  fillDeadlinePlaceholders();
  wireupPrepChecklist();
  wireupWordCounters();
  await boot();
})();
