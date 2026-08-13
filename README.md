# Onboarding Portal — Frontend (SPA)

Standalone applicant-facing frontend for the [Onboarding Portal backend](https://github.com/map-data-engineering/onboarding-).
This is a pure-static site (HTML + CSS + JS, Bootstrap 5 via CDN) — **no build step, no framework**.
It's designed to be deployed to Vercel and to call the Django backend hosted on PythonAnywhere.

> **Scope of this repo:** landing page + applicant portal (application form + timed quiz + result)
> + staff panel (token-authenticated admin — applicants list, detail view, quiz breakdown, bulk actions).

---

## 1. What's here

```
.
├── index.html          # landing page (hero, about, how-it-works, footer)
├── apply.html          # applicant portal (form -> quiz -> result)
├── panel.html          # staff panel (login -> applicants list -> detail + quiz)
├── css/
│   └── styles.css      # AdminCa-inspired theme + landing + panel styles
├── js/
│   ├── api.js          # shared fetch helpers, API base URL, ApiError class
│   ├── applicant.js    # the state machine (form -> intro -> question -> result)
│   └── panel.js        # admin views (login / list / detail / decisions / bulk)
├── .gitignore
└── README.md
```

That's it. No `node_modules`, no `dist/`, no bundler.

**Routing:** `/` serves the landing page. `/apply` (i.e. `apply.html`) is the actual
application + quiz flow. The landing page's "Start Application" CTA links to `apply.html`,
and the CTA text switches to "Continue Application" if `localStorage` shows the user has an
in-progress session.

---

## 2. Point it at your backend

The production backend URL is hard-coded in [`js/api.js`](js/api.js):

```js
const PROD_API = "https://mapdet.pythonanywhere.com/api";
```

The dev URL (`http://127.0.0.1:8000/api`) is used automatically when you open the site from
`localhost` or `127.0.0.1` — so local development against a locally-run Django backend just works.
No env vars, no build config.

---

## 3. Run it locally

Any static file server works. Two easy options:

**Option A — Python (comes with any Python install):**
```bash
cd "SPAT - ONBOARDING FRONTEND"
python -m http.server 5173
```
Then open `http://localhost:5173`.

**Option B — VS Code Live Server extension:** right-click `index.html` → *Open with Live Server*.

Do **not** just double-click `index.html` — opening as `file://` will break `fetch()` to the API
(some browsers reject cross-origin requests from `file://` origins). Use a real HTTP server.

### What you'll need to actually see data
- The Django backend must be running (locally via `manage.py runserver` **or** deployed).
- The backend must allow your frontend origin via CORS — see [section 5](#5-what-the-backend-dev-must-do-cors).

---

## 4. Deploy to Vercel

Zero-config: it's already a static site.

1. Push this folder to a new GitHub repo (see [section 7](#7-push-to-github)).
2. Go to [vercel.com](https://vercel.com) → *Add New… → Project* → import the repo.
3. Framework Preset: **Other**. Build command: *(leave blank)*. Output directory: *(leave blank —
   Vercel serves the repo root)*.
4. Click **Deploy**. You get a URL like `https://<project-name>.vercel.app`.

Every push to `main` auto-deploys; every pull request gets a preview URL.

> **After the first deploy, tell the backend dev your Vercel URL** — they need to add it to
> `CORS_ALLOWED_ORIGINS` (see next section). Until they do, every API request will fail with a
> CORS error in the browser console.

---

## 5. What the backend dev must do (CORS)

The backend was originally built to be same-origin (Django served the HTML **and** the API).
Now that the frontend lives on Vercel and the API on PythonAnywhere, the browser will block every
request unless the backend explicitly allows this origin. Send this to the backend dev:

> **CORS setup for the decoupled frontend**
>
> 1. Install and pin the dependency:
>    ```bash
>    pip install django-cors-headers
>    ```
>    Add `django-cors-headers` to `requirements.txt`.
>
> 2. In `onboarding/settings.py`:
>    - Add `"corsheaders"` to `INSTALLED_APPS`.
>    - Add `"corsheaders.middleware.CorsMiddleware"` to `MIDDLEWARE` **above**
>      `"django.middleware.common.CommonMiddleware"`.
>    - Add:
>      ```python
>      CORS_ALLOWED_ORIGINS = [
>          "https://<my-project>.vercel.app",   # production frontend (replace with real URL)
>          "http://localhost:5173",             # local dev (python -m http.server 5173)
>          "http://127.0.0.1:5500",             # VS Code Live Server default
>      ]
>      CORS_ALLOW_CREDENTIALS = False   # token auth uses Authorization header, no cookies
>      ```
>
> 3. Reload the app on PythonAnywhere (Web tab → Reload).
>
> No changes to views, serializers, or URLs are needed. Token auth already skips CSRF; the open
> applicant endpoints don't use CSRF either once this middleware is in place.

Add every Vercel preview URL you actually need too — or, if that's too fiddly, use
`CORS_ALLOWED_ORIGIN_REGEXES = [r"^https://.*\.vercel\.app$"]` (broader; discuss with the backend dev).

---

## 6. How the applicant journey works (for reference)

The full API contract is documented in the backend repo's [`README_FRONTEND.md`](https://github.com/map-data-engineering/onboarding-/blob/main/README_FRONTEND.md).
Quick summary of what `js/applicant.js` does:

1. **Form** → `POST /applications/` (multipart, includes CV). Saves `application_id` in `localStorage`.
2. **Quiz intro** → button calls `POST /applications/{id}/quiz/start/`. Saves `session_id`.
3. **Question loop** → for each question, render the option buttons + a countdown driven by the
   server's `deadline` timestamp. On submit or timeout: `POST /quiz/{session}/answer/`.
4. **Result** → `GET /quiz/{session}/result/` on the last response, show score.
5. **Resume on reload** → if `session_id` is in `localStorage`, `GET /quiz/{session}/current/`
   returns either the current question or the final result.

The clock is **server-authoritative**. Never trust the local timer for pass/fail — the browser
ticks against the ISO `deadline`, and the server enforces the real cutoff.

---

## 7. Push to GitHub

From this folder:

```bash
git init
git add .
git commit -m "Initial applicant frontend"
git branch -M main
git remote add origin https://github.com/<you>/onboarding-frontend.git
git push -u origin main
```

Then connect the repo to Vercel (section 4).

---

## 8. Staff panel notes

The panel lives at `/panel.html` and uses DRF token authentication. Flow:

1. **Log in** — `POST /admin/login/` with `{username, password}`. Server returns `{ token, user }`;
   the token is stored in `sessionStorage` (not `localStorage`, to reduce XSS exposure).
2. **Every subsequent request** sends `Authorization: Token <token>`. If any admin call returns
   `401`, the token is cleared and the user is bounced back to login.
3. **Applicants list** — `GET /admin/applications/` (paginated, 25/page). Supports `?search=` for
   name/email/institution filter and `?page=` for pagination. Row-checkbox → bulk action toolbar
   (select / reject / pending / delete). Row-click → detail.
4. **Detail** — `GET /admin/applications/{id}/`. Shows profile fields, a CV download link,
   decision controls (`PATCH /admin/applications/{id}/`), delete
   (`DELETE /admin/applications/{id}/`), and a Quiz breakdown tab
   (`GET /admin/applications/{id}/quiz/`).
5. **Log out** — `POST /admin/logout/` (invalidates the token), then clears `sessionStorage` and
   returns to login.

Only accounts with `is_staff = true` can log in. Create them on the backend with
`manage.py createsuperuser`. The panel uses a dark navbar theme to visually distinguish staff
context from the public applicant portal.
