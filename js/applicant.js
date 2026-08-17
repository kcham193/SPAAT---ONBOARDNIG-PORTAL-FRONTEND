// Applicant journey state machine (see backend README_FRONTEND section 2).
// Two-stage flow: Details -> Quiz -> Result -> (if passed) Finalize.
// Persisted state lets us resume across reloads / tab close, but we always
// re-validate with /status/ before trusting stored ids.
const LS = {
  get appId()  { return localStorage.getItem("application_id"); },
  set appId(v) { v ? localStorage.setItem("application_id", v) : localStorage.removeItem("application_id"); },
  get sessId() { return localStorage.getItem("session_id"); },
  set sessId(v){ v ? localStorage.setItem("session_id", v) : localStorage.removeItem("session_id"); },
};

// ---------------------------------------------------------------- Country list
// Populates the Nationality and Country-of-residence <select>s. Sent as plain
// text to the backend, which stores whichever label was chosen — no enum on
// that end, so this list is safe to extend or reorder without a schema change.
const COUNTRIES = [
  "Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda",
  "Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain",
  "Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia",
  "Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso",
  "Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Central African Republic",
  "Chad","Chile","China","Colombia","Comoros","Congo (Brazzaville)",
  "Congo (Democratic Republic)","Costa Rica","Côte d'Ivoire","Croatia","Cuba",
  "Cyprus","Czechia","Denmark","Djibouti","Dominica","Dominican Republic",
  "Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia",
  "Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia",
  "Germany","Ghana","Greece","Grenada","Guatemala","Guinea","Guinea-Bissau",
  "Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran",
  "Iraq","Ireland","Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan",
  "Kenya","Kiribati","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho",
  "Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Madagascar",
  "Malawi","Malaysia","Maldives","Mali","Malta","Marshall Islands","Mauritania",
  "Mauritius","Mexico","Micronesia","Moldova","Monaco","Mongolia","Montenegro",
  "Morocco","Mozambique","Myanmar (Burma)","Namibia","Nauru","Nepal",
  "Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Korea",
  "North Macedonia","Norway","Oman","Pakistan","Palau","Palestine","Panama",
  "Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar",
  "Romania","Russia","Rwanda","Saint Kitts and Nevis","Saint Lucia",
  "Saint Vincent and the Grenadines","Samoa","San Marino","São Tomé and Príncipe",
  "Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore",
  "Slovakia","Slovenia","Solomon Islands","Somalia","South Africa","South Korea",
  "South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland",
  "Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo",
  "Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Tuvalu",
  "Uganda","Ukraine","United Arab Emirates","United Kingdom","United States",
  "Uruguay","Uzbekistan","Vanuatu","Vatican City","Venezuela","Vietnam","Yemen",
  "Zambia","Zimbabwe",
];

(function populateCountrySelects() {
  const selects = document.querySelectorAll(".country-select");
  if (!selects.length) return;
  const optionsHtml = COUNTRIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  selects.forEach((sel) => sel.insertAdjacentHTML("beforeend", optionsHtml));
})();

const screens = {
  prep:     document.getElementById("screen-prep"),
  form:     document.getElementById("screen-form"),
  intro:    document.getElementById("screen-intro"),
  question: document.getElementById("screen-question"),
  result:   document.getElementById("screen-result"),
  final:    document.getElementById("screen-final"),
  done:     document.getElementById("screen-done"),
};

// Stepper progression. "done" leaves the stepper lit on "final" — same step,
// task complete.
const STEP_ORDER = ["form", "intro", "question", "result", "final"];

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle("d-none", k !== name));
  const active = name === "done" ? "final" : name;
  const currentIdx = STEP_ORDER.indexOf(active);
  document.querySelectorAll("#steps [data-step]").forEach((b) => {
    const idx = STEP_ORDER.indexOf(b.dataset.step);
    b.classList.toggle("active", idx === currentIdx);
    b.classList.toggle("done", idx >= 0 && (idx < currentIdx || name === "done"));
  });
}

// ---------------------------------------------------------------- Alerts + errors
const form = document.getElementById("application-form");
const formAlert = document.getElementById("form-alert");
const finalAlert = document.getElementById("final-alert");

function clearFieldErrors() {
  document.querySelectorAll("[data-error]").forEach((el) => (el.textContent = ""));
  formAlert.classList.add("d-none");
  finalAlert.classList.add("d-none");
}

function renderFieldErrors(data, alertBox) {
  // data is a { field: [messages] } map (or {detail: "..."}).
  const box = alertBox || formAlert;
  const fail = (text) => { box.textContent = text; box.classList.remove("d-none"); };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    let handledAny = false;
    Object.entries(data).forEach(([field, msgs]) => {
      const target = document.querySelector(`[data-error="${field}"]`);
      const text = Array.isArray(msgs) ? msgs.join(" ") : String(msgs);
      if (target) { target.textContent = text; handledAny = true; }
      else if (field === "detail") { fail(text); handledAny = true; }
    });
    if (!handledAny) fail(JSON.stringify(data));
  } else {
    fail("Something went wrong. Please try again.");
  }
}

// ---------------------------------------------------------------- Step 0: prep
// Preparation splash — reminds the applicant to have CV / motivation /
// expectations ready before the flow starts. Shown once for fresh visitors;
// returning users with saved state resume past this screen automatically.
const beginBtn = document.getElementById("begin-application");
if (beginBtn) {
  beginBtn.addEventListener("click", () => {
    clearFieldErrors();
    showScreen("form");
  });
}

// ---------------------------------------------------------------- Step 1: details
// The server accepts JSON here (no file upload in step 1), so we send JSON —
// smaller and easier to debug.
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
    showScreen("intro");
  } catch (err) {
    renderFieldErrors(err.data, formAlert);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Next <i class="bi bi-arrow-right ms-1"></i>`;
  }
});

// ---------------------------------------------------------------- Step 2: start
const introAlert = document.getElementById("intro-alert");
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
      // Stored application no longer exists — send the applicant back to Step 1.
      resetJourney();
      showScreen("form");
      formAlert.textContent = "We couldn't find your application. Please fill in your details again.";
      formAlert.classList.remove("d-none");
      return;
    }
    const msg = err.data && (err.data.detail || JSON.stringify(err.data));
    introAlert.textContent = msg || "Could not start the quiz.";
    introAlert.classList.remove("d-none");
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------- Step 3: question loop
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

// Server-authoritative countdown: we tick against the ISO `deadline`, not a
// local timer we started -- the two would drift.
function startCountdown(deadlineIso) {
  stopCountdown();
  currentDeadline = new Date(deadlineIso).getTime();
  const tick = () => {
    const remaining = Math.max(0, Math.round((currentDeadline - Date.now()) / 1000));
    els.countdown.textContent = `${remaining}s`;
    els.countdown.classList.toggle("danger", remaining <= 5);
    if (remaining <= 0) {
      stopCountdown();
      els.status.textContent = "Time's up — submitting…";
      submitAnswer(true); // auto-submit; server will mark it timed_out
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

  startCountdown(payload.deadline);
}

els.submit.addEventListener("click", () => submitAnswer(false));

let submitting = false;
async function submitAnswer(auto) {
  if (submitting) return;
  submitting = true;
  stopCountdown();
  els.submit.disabled = true;

  const answer = selectedAnswer || "";
  try {
    const res = await apiJson("POST", `/quiz/${LS.sessId}/answer/`, { answer });
    if (res.finished) {
      showResult(res.result);
    } else {
      renderQuestion(res.next);
    }
  } catch (err) {
    els.status.textContent = "Could not submit answer. Retrying is disabled to protect the timer.";
    console.error(err);
  } finally {
    submitting = false;
  }
}

// ---------------------------------------------------------------- Step 4: result
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

  // Keep resume state while the final step is still open so a reload lands the
  // applicant back on this screen or the final form. Otherwise the journey is
  // done — clear it so a fresh visit starts at Step 1.
  if (unlocked) {
    if (result.application) LS.appId = result.application;
    if (result.id) LS.sessId = result.id;
  } else {
    LS.sessId = null;
    LS.appId = null;
  }
}

// ------------------------------------------------- Step 5: final submission
document.getElementById("go-final").addEventListener("click", () => {
  clearFieldErrors();
  showScreen("final");
});

const finalForm = document.getElementById("final-form");
finalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-final");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Submitting…`;
  try {
    await apiForm("POST", `/applications/${LS.appId}/finalize/`, new FormData(finalForm));
    showScreen("done");
    LS.appId = null;
    LS.sessId = null;
  } catch (err) {
    renderFieldErrors(err.data, finalAlert);
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

(async function boot() {
  // Fresh visit → show the preparation splash so applicants know what to
  // have ready before the details form.
  if (!LS.appId) { resetJourney(); showScreen("prep"); return; }

  // Always re-validate with the server before resuming — the stored application
  // may have been deleted, and we don't want to leave the user stuck on a
  // journey the backend no longer knows about.
  let state;
  try {
    state = await apiJson("GET", `/applications/${LS.appId}/status/`);
  } catch (err) {
    resetJourney();
    showScreen("prep");
    return;
  }

  if (state.final_submitted) { resetJourney(); showScreen("done"); return; }

  if (state.quiz) {
    LS.sessId = state.quiz.id;
    if (state.quiz.completed_at) { showResult(state.quiz); return; }
    // Mid-quiz: /current/ returns either a question payload or the result.
    try {
      const data = await apiJson("GET", `/quiz/${LS.sessId}/current/`);
      if (data.question) { renderQuestion(data); return; }
      if (typeof data.score === "number") { showResult(data); return; }
    } catch (err) {
      LS.sessId = null; // fall through to the intro screen
    }
  }

  showScreen("intro");
})();
