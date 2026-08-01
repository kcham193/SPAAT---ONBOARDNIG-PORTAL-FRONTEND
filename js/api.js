// Shared API helpers. This SPA is served from a DIFFERENT origin than the
// Django backend (e.g. Vercel -> PythonAnywhere), so requests are cross-origin.
// The backend must allow this origin via django-cors-headers -- see README.md.

// Backend base URL. Change PYTHONANYWHERE_USERNAME to the actual production host.
// Local dev falls back to a Django dev server on 127.0.0.1:8000.
const PROD_API = "https://vedas.pythonanywhere.com/api";
const DEV_API  = "http://127.0.0.1:8000/api";

const API = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? DEV_API
  : PROD_API;

// Thrown for any non-2xx response. `data` holds the parsed body (field-error map
// for 400s, {detail: ...} for auth errors, etc.) so callers can render it.
class ApiError extends Error {
  constructor(status, data) {
    super(`API error ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function parseBody(res) {
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    try { return await res.json(); } catch { return null; }
  }
  return await res.text();
}

// JSON request. `token` (optional) is sent as a DRF Token header for admin calls.
// No CSRF header: cross-origin requests without cookies don't need it, and DRF
// TokenAuthentication is CSRF-exempt.
async function apiJson(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Token ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Multipart request (used only for the application form + CV upload).
// NOTE: never set Content-Type yourself -- the browser adds the multipart boundary.
async function apiForm(method, path, formData) {
  const res = await fetch(`${API}${path}`, { method, body: formData });
  const data = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
