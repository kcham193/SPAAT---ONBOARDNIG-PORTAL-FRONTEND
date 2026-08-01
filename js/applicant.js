// Applicant journey state machine (see backend README section 2).
// Persisted state lets us resume a quiz across reloads / tab close.
const LS = {
  get appId()  { return localStorage.getItem("application_id"); },
  set appId(v) { v ? localStorage.setItem("application_id", v) : localStorage.removeItem("application_id"); },
  get sessId() { return localStorage.getItem("session_id"); },
  set sessId(v){ v ? localStorage.setItem("session_id", v) : localStorage.removeItem("session_id"); },
};

const screens = {
  form:     document.getElementById("screen-form"),
  intro:    document.getElementById("screen-intro"),
  question: document.getElementById("screen-question"),
  result:   document.getElementById("screen-result"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle("d-none", k !== name));
  document.querySelectorAll("#steps [data-step]").forEach((b) => {
    b.classList.toggle("bg-primary", b.dataset.step === name);
    b.classList.toggle("bg-secondary", b.dataset.step !== name);
  });
}

// ---------------------------------------------------------------- Step 1: form
const form = document.getElementById("application-form");
const formAlert = document.getElementById("form-alert");

function clearFieldErrors() {
  document.querySelectorAll("[data-error]").forEach((el) => (el.textContent = ""));
  formAlert.classList.add("d-none");
}

function renderFieldErrors(data) {
  // data is a { field: [messages] } map (or {detail: "..."}).
  if (data && typeof data === "object" && !Array.isArray(data)) {
    let handledAny = false;
    Object.entries(data).forEach(([field, msgs]) => {
      const box = document.querySelector(`[data-error="${field}"]`);
      const text = Array.isArray(msgs) ? msgs.join(" ") : String(msgs);
      if (box) { box.textContent = text; handledAny = true; }
      else if (field === "detail") { formAlert.textContent = text; formAlert.classList.remove("d-none"); handledAny = true; }
    });
    if (!handledAny) { formAlert.textContent = JSON.stringify(data); formAlert.classList.remove("d-none"); }
  } else {
    formAlert.textContent = "Something went wrong submitting your application.";
    formAlert.classList.remove("d-none");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();
  const btn = document.getElementById("submit-application");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Submitting…`;
  try {
    const app = await apiForm("POST", "/applications/", new FormData(form));
    LS.appId = app.id;
    LS.sessId = null;
    showScreen("intro");
  } catch (err) {
    renderFieldErrors(err.data);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Submit application <i class="bi bi-arrow-right"></i>`;
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
    // e.g. "A quiz session already exists" -> try to resume instead.
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

  // On a manual submit we send the chosen option; on a timeout we send whatever
  // was selected (or empty) -- the server decides it timed out regardless.
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
  const el = document.getElementById("r-completed");
  el.textContent = result.completed_at
    ? `Completed ${new Date(result.completed_at).toLocaleString()}`
    : "";
  // Journey is over -- clear the resume state so a reload starts fresh.
  LS.sessId = null;
  LS.appId = null;
}

// ---------------------------------------------------------------- Resume on load
(async function boot() {
  // A response from /current/ is either a question payload (has .question) or a
  // result payload (has .score but no .question).
  if (LS.sessId) {
    try {
      const data = await apiJson("GET", `/quiz/${LS.sessId}/current/`);
      if (data.question) { renderQuestion(data); return; }
      if (typeof data.score === "number") { showResult(data); return; }
    } catch (err) {
      LS.sessId = null; // stale/invalid session -> fall through
    }
  }
  if (LS.appId) { showScreen("intro"); return; }
  showScreen("form");
})();
