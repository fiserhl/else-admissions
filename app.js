// =========================================================================
// Else Graduate Admissions Tracker — app.js
// =========================================================================
// Two Supabase clients:
//   - adm : admissions project (RW) — all app data lives here
//   - alu : alumni project (READ-ONLY from this app's perspective)
// The two are *separate Supabase projects*. The admissions project has no
// ability to write to the alumni database — we only ever issue SELECTs to it.
// =========================================================================

// --- Configuration ---
const ADM_URL  = "https://zsnkgqyqwzncijesfuoj.supabase.co";
const ADM_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbmtncXlxd3puY2lqZXNmdW9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NjI4ODUsImV4cCI6MjA5MjAzODg4NX0.5MAjvjmuLccSzddOYG6B8Bmu2KVAQ1k_ue77Pigc1dw";

const ALU_URL  = "https://akegekomjwggrvpphxog.supabase.co";
const ALU_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrZWdla29tandnZ3J2cHBoeG9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NTA3MjYsImV4cCI6MjA4OTAyNjcyNn0.yo3lXeRzQTLAZYfYY8QM0vuHYw5AzJwIdZjE2n8bpnw";

// The shared app secret (same as Else CRM). Passed in the x-app-secret header
// and validated by app_secret_valid() in RLS on both projects.
const APP_SECRET = "d316cb840036aeffc93a26863b73ee1d39bb675722a682a07c642c219bbd33bc";

const HEADERS = { "x-app-secret": APP_SECRET };

const adm = supabase.createClient(ADM_URL, ADM_ANON, { global: { headers: HEADERS }});
const alu = supabase.createClient(ALU_URL, ALU_ANON, { global: { headers: HEADERS }});

// --- State ---
let CURRENT_USER = null;      // { username, role, full_name }
let PROSPECTS_CACHE = [];     // in-memory cache (matches Else CRM pattern)
let EDITING_ID = null;        // prospect_id being edited, or null for new
let ALUMNI_MATCH_CACHE = null;// result from last checkAlumniMatch call

// --- Boot ---
document.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("adm_user");
  if (saved) {
    try {
      CURRENT_USER = JSON.parse(saved);
      enterApp();
    } catch { sessionStorage.removeItem("adm_user"); }
  }
  // wire tab clicks
  document.querySelectorAll(".tabs .tab").forEach(t => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });
  // login on Enter
  document.getElementById("login-pass").addEventListener("keyup", e => {
    if (e.key === "Enter") doLogin();
  });
});

// =========================================================================
// Toast
// =========================================================================
function toast(msg, kind="info", ms=3500) {
  const wrap = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = "toast-item " + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, ms);
}

// =========================================================================
// AUTH
// =========================================================================
async function doLogin() {
  const u = document.getElementById("login-user").value.trim().toLowerCase();
  const p = document.getElementById("login-pass").value;
  const err = document.getElementById("login-err");
  err.textContent = "";
  if (!u || !p) { err.textContent = "Please enter both username and password."; return; }

  try {
    const { data, error } = await adm
      .from("app_users")
      .select("username, password, role, full_name")
      .eq("username", u)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0 || data[0].password !== p) {
      err.textContent = "Invalid username or password.";
      return;
    }
    CURRENT_USER = { username: data[0].username, role: data[0].role, full_name: data[0].full_name };
    sessionStorage.setItem("adm_user", JSON.stringify(CURRENT_USER));
    logAudit("login", "Signed in");
    enterApp();
  } catch (e) {
    console.error(e);
    err.textContent = "Unable to reach the database. Check your connection.";
  }
}

function doLogout() {
  logAudit("logout", "Signed out");
  sessionStorage.removeItem("adm_user");
  CURRENT_USER = null;
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-pass").value = "";
}

function enterApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("who").textContent = CURRENT_USER.full_name || CURRENT_USER.username;
  refreshDashboard();
  loadProspects();
}

// =========================================================================
// DASHBOARD
// =========================================================================
async function refreshDashboard() {
  try {
    const { data, error } = await adm.from("pipeline_dashboard").select("*").single();
    if (error) throw error;
    document.getElementById("d-total").textContent     = data.total_prospects ?? 0;
    document.getElementById("d-month").textContent     = data.contacts_this_month ?? 0;
    document.getElementById("d-month-sub").textContent = `${data.emails_this_month||0} emails · ${data.texts_this_month||0} texts`;
    document.getElementById("d-inprog").textContent    = data.applications_in_progress ?? 0;
    document.getElementById("d-complete").textContent  = data.applications_complete ?? 0;
    document.getElementById("d-research").textContent  = data.research_pending ?? 0;
    document.getElementById("d-total-sub").textContent = `${data.inquiries||0} inquiries`;
  } catch (e) {
    console.error("dashboard error:", e);
  }
}

// =========================================================================
// TABS
// =========================================================================
function switchTab(tab) {
  document.querySelectorAll(".tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById("tab-" + tab).classList.remove("hidden");

  if (tab === "messages")  loadMessages();
  if (tab === "audit")     loadAudit();
  if (tab === "research")  loadEnrichmentQueue();
}

// =========================================================================
// PROSPECTS — List
// =========================================================================
async function loadProspects() {
  const tbody = document.getElementById("p-tbody");
  tbody.innerHTML = `<tr><td colspan="8" class="muted center"><span class="loader"></span> Loading…</td></tr>`;
  try {
    const { data, error } = await adm
      .from("prospects")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    PROSPECTS_CACHE = data || [];
    populateAssignedFilter();
    renderProspects();
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="8" class="muted center">Error loading prospects: ${e.message}</td></tr>`;
  }
}

function populateAssignedFilter() {
  const sel = document.getElementById("p-assigned");
  const current = sel.value;
  const names = [...new Set(PROSPECTS_CACHE.map(p => p.assigned_to).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">All assigned</option>` +
    names.map(n => `<option ${n===current?"selected":""}>${escapeHtml(n)}</option>`).join("");
}

function renderProspects() {
  const q = (document.getElementById("p-search").value || "").toLowerCase();
  const st = document.getElementById("p-status").value;
  const pg = document.getElementById("p-program").value;
  const tm = document.getElementById("p-term").value;
  const ag = document.getElementById("p-assigned").value;

  const filtered = PROSPECTS_CACHE.filter(p => {
    if (st && p.application_status !== st) return false;
    if (tm && p.potential_entry_term !== tm) return false;
    if (ag && p.assigned_to !== ag) return false;
    if (pg && !(p.programs_of_interest || []).includes(pg)) return false;
    if (q) {
      const hay = [p.first_name, p.last_name, p.preferred_name, p.email, p.organization, p.cell_phone, p.phone]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById("p-count").textContent = `${filtered.length.toLocaleString()} prospect${filtered.length===1?"":"s"}`;

  const tbody = document.getElementById("p-tbody");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted center">No prospects match your filters. <a href="#" onclick="openProspectModal();return false;">Add a prospect</a>.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(p => {
    const name = displayName(p);
    const programs = (p.programs_of_interest || []).map(x => programLabel(x)).join(", ") || "<span class='muted'>—</span>";
    const alumPill = p.is_alum ? ` <span class="pill alum">Alum</span>` : "";
    return `
      <tr onclick="openProspectModal(${p.prospect_id})">
        <td><strong>${escapeHtml(name)}</strong>${alumPill}</td>
        <td>${escapeHtml(p.email||"")}</td>
        <td>${escapeHtml(p.cell_phone||p.phone||"")}</td>
        <td class="small">${programs}</td>
        <td>${termLabel(p.potential_entry_term)} ${p.potential_entry_year||""}</td>
        <td><span class="pill ${p.application_status||'inquiry'}">${(p.application_status||'inquiry').replace(/_/g,' ')}</span></td>
        <td class="small">${escapeHtml(p.assigned_to||"")}</td>
        <td class="small">${p.first_contact_date ? formatDate(p.first_contact_date) : ""}</td>
      </tr>`;
  }).join("");
}

function displayName(p) {
  if (p.preferred_name && p.last_name) return `${p.preferred_name} ${p.last_name}`;
  if (p.first_name && p.last_name) return `${p.first_name} ${p.last_name}`;
  return p.name || p.email || "(no name)";
}
function programLabel(code) {
  const map = {
    MBA: "MBA", EMBA: "EMBA", MBAA: "MBAA", MACC: "MACC", MACCA: "MACCA",
    data_analytics_cert: "Data Analytics Cert",
    marketing_cert: "Marketing Cert",
    nonprofit_cert: "Non-Profit Cert"
  };
  return map[code] || code;
}
function termLabel(t) {
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// =========================================================================
// PROSPECTS — Modal / Edit
// =========================================================================
function openProspectModal(id) {
  EDITING_ID = id || null;
  ALUMNI_MATCH_CACHE = null;
  document.getElementById("alumni-match-banner").innerHTML = "";
  document.getElementById("alumni-extra").classList.add("hidden");
  document.getElementById("prospect-modal-title").textContent = id ? "Edit Prospect" : "Add Prospect";
  document.getElementById("btn-delete").style.display = id ? "inline-flex" : "none";

  // clear form
  ["f-first","f-last","f-pref","f-email","f-cell","f-phone","f-linkedin",
   "f-source","f-firstdate","f-term","f-year","f-appstatus","f-assigned","f-notes",
   "f-gradyear","f-major","f-alumid","f-org","f-title"].forEach(k => {
    const el = document.getElementById(k);
    if (el) el.value = "";
  });
  document.querySelectorAll("#f-programs input[type=checkbox]").forEach(cb => cb.checked = false);
  document.getElementById("f-appstatus").value = "inquiry";
  document.getElementById("f-firstdate").value = new Date().toISOString().slice(0,10);

  if (id) {
    const p = PROSPECTS_CACHE.find(x => x.prospect_id === id);
    if (p) {
      document.getElementById("f-first").value    = p.first_name || "";
      document.getElementById("f-last").value     = p.last_name  || "";
      document.getElementById("f-pref").value     = p.preferred_name || "";
      document.getElementById("f-email").value    = p.email || "";
      document.getElementById("f-cell").value     = p.cell_phone || "";
      document.getElementById("f-phone").value    = p.phone || "";
      document.getElementById("f-linkedin").value = p.linkedin_url || "";
      document.getElementById("f-source").value   = p.source_of_contact || "";
      document.getElementById("f-firstdate").value = p.first_contact_date || "";
      document.getElementById("f-term").value     = p.potential_entry_term || "";
      document.getElementById("f-year").value     = p.potential_entry_year || "";
      document.getElementById("f-appstatus").value = p.application_status || "inquiry";
      document.getElementById("f-assigned").value = p.assigned_to || "";
      document.getElementById("f-notes").value    = p.notes || "";
      (p.programs_of_interest || []).forEach(code => {
        const cb = document.querySelector(`#f-programs input[value="${code}"]`);
        if (cb) cb.checked = true;
      });
      if (p.is_alum) {
        document.getElementById("alumni-extra").classList.remove("hidden");
        document.getElementById("f-gradyear").value = p.grad_year || "";
        document.getElementById("f-major").value    = p.alum_major || "";
        document.getElementById("f-alumid").value   = p.alumni_contact_id || "";
        document.getElementById("f-org").value      = p.organization || "";
        document.getElementById("f-title").value    = p.title || "";
      }
    }
  }
  document.getElementById("prospect-modal").classList.add("show");
}
function closeProspectModal() {
  document.getElementById("prospect-modal").classList.remove("show");
  EDITING_ID = null;
}

async function saveProspect() {
  const first = document.getElementById("f-first").value.trim();
  const last  = document.getElementById("f-last").value.trim();
  if (!first && !last) { toast("Please enter at least a first or last name.", "error"); return; }

  const programs = Array.from(document.querySelectorAll("#f-programs input:checked")).map(cb => cb.value);

  const record = {
    first_name:           first || null,
    last_name:            last  || null,
    preferred_name:       document.getElementById("f-pref").value.trim() || null,
    name:                 [document.getElementById("f-pref").value.trim() || first, last].filter(Boolean).join(" ") || null,
    email:                document.getElementById("f-email").value.trim().toLowerCase() || null,
    cell_phone:           document.getElementById("f-cell").value.trim() || null,
    phone:                document.getElementById("f-phone").value.trim() || null,
    linkedin_url:         document.getElementById("f-linkedin").value.trim() || null,
    source_of_contact:    document.getElementById("f-source").value || null,
    first_contact_date:   document.getElementById("f-firstdate").value || null,
    potential_entry_term: document.getElementById("f-term").value || null,
    potential_entry_year: parseInt(document.getElementById("f-year").value) || null,
    programs_of_interest: programs,
    application_status:   document.getElementById("f-appstatus").value || "inquiry",
    assigned_to:          document.getElementById("f-assigned").value || null,
    notes:                document.getElementById("f-notes").value || null,
  };

  // If we have an alumni match cached and this is a new prospect, pull over fields
  if (!EDITING_ID && ALUMNI_MATCH_CACHE) {
    const a = ALUMNI_MATCH_CACHE;
    record.is_alum = true;
    record.alumni_contact_id = a.contact_id;
    record.alumni_id        = a.alumni_id || null;
    record.donor_id         = a.donor_id  || null;
    record.grad_year        = a.grad_year || null;
    record.alum_major       = a.alum_major || null;
    record.alum_status      = a.alum_status || null;
    record.formal_salutation= a.formal_salutation || null;
    record.spouse_name      = a.spouse_name || null;
    record.organization     = a.organization || null;
    record.title            = a.title || null;
    record.address          = a.address || null;
    record.city             = a.city || null;
    record.state            = a.state || null;
    record.zip              = a.zip || null;
    record.roles            = a.roles || [];
    if (!record.linkedin_url && a.linkedin_url) record.linkedin_url = a.linkedin_url;
  }

  try {
    let result;
    if (EDITING_ID) {
      result = await adm.from("prospects").update(record).eq("prospect_id", EDITING_ID).select().single();
    } else {
      result = await adm.from("prospects").insert(record).select().single();
    }
    if (result.error) throw result.error;

    // audit log
    await logHistory(result.data.prospect_id, EDITING_ID ? "updated" : "created",
      EDITING_ID ? "Prospect record updated" : "Prospect record created",
      ALUMNI_MATCH_CACHE ? "Alumni DB match" : "Manual");

    toast(EDITING_ID ? "Prospect updated." : "Prospect added.", "success");
    closeProspectModal();
    loadProspects();
    refreshDashboard();
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      toast("A prospect with this email already exists.", "error");
    } else {
      toast("Error saving: " + (e.message || "unknown"), "error");
    }
  }
}

async function deleteProspect() {
  if (!EDITING_ID) return;
  if (!confirm("Delete this prospect? This cannot be undone.")) return;
  try {
    const { error } = await adm.from("prospects").delete().eq("prospect_id", EDITING_ID);
    if (error) throw error;
    logAudit("prospect_deleted", `Deleted prospect id=${EDITING_ID}`);
    toast("Prospect deleted.", "success");
    closeProspectModal();
    loadProspects();
    refreshDashboard();
  } catch (e) {
    toast("Error deleting: " + e.message, "error");
  }
}

// =========================================================================
// ALUMNI MATCHING — read-only query to the alumni Supabase project
// =========================================================================
async function checkAlumniMatch() {
  const email = document.getElementById("f-email").value.trim().toLowerCase();
  const first = document.getElementById("f-first").value.trim();
  const last  = document.getElementById("f-last").value.trim();

  const banner = document.getElementById("alumni-match-banner");
  banner.innerHTML = `<div class="alumni-banner"><span class="loader"></span> Searching Alumni Database…</div>`;

  try {
    let match = null;

    // 1. Try email match first (strongest signal)
    if (email) {
      const { data, error } = await alu
        .from("contacts")
        .select("contact_id,name,first_name,last_name,preferred_name,email,phone,cell_phone,linkedin_url,organization,title,address,city,state,zip,roles,grad_year,alum_major,alum_status,alumni_id,donor_id,formal_salutation,spouse_name")
        .ilike("email", email)
        .limit(5);
      if (error) throw error;
      if (data && data.length > 0) match = data[0];
    }

    // 2. Fall back to name match (case-insensitive)
    if (!match && first && last) {
      const { data, error } = await alu
        .from("contacts")
        .select("contact_id,name,first_name,last_name,preferred_name,email,phone,cell_phone,linkedin_url,organization,title,address,city,state,zip,roles,grad_year,alum_major,alum_status,alumni_id,donor_id,formal_salutation,spouse_name")
        .ilike("first_name", first)
        .ilike("last_name",  last)
        .limit(5);
      if (error) throw error;
      if (data && data.length > 0) match = data[0];
    }

    if (!match) {
      banner.innerHTML = `<div class="alumni-banner" style="background:#f3f4f6;border-color:#d1d5db;border-left-color:#6b7280;">
        <div class="title">No Alumni Match Found</div>
        <div class="meta">Searched by email and name. This prospect will be saved as a new contact.</div>
      </div>`;
      ALUMNI_MATCH_CACHE = null;
      return;
    }

    ALUMNI_MATCH_CACHE = match;
    const roleStr = (match.roles || []).slice(0, 6).join(", ");
    banner.innerHTML = `
      <div class="alumni-banner">
        <div class="title">✓ Alumni Match Found</div>
        <div class="meta">
          <strong>${escapeHtml(match.name || (match.first_name + " " + match.last_name))}</strong>
          ${match.grad_year ? ` · Class of ${match.grad_year}` : ""}
          ${match.alum_major ? ` · ${escapeHtml(match.alum_major)}` : ""}
          <br>${match.email ? escapeHtml(match.email) : ""}
          ${match.organization ? ` · ${escapeHtml(match.organization)}` : ""}
          ${match.title ? `, ${escapeHtml(match.title)}` : ""}
          ${roleStr ? `<br><span class="tiny">Roles: ${escapeHtml(roleStr)}</span>` : ""}
        </div>
        <div class="actions">
          <button class="btn small" type="button" onclick="applyAlumniMatch()">Copy Alumni Data to Prospect</button>
          <button class="btn small secondary" type="button" onclick="dismissAlumniMatch()">Keep Separate</button>
        </div>
      </div>`;
  } catch (e) {
    console.error(e);
    banner.innerHTML = `<div class="alumni-banner" style="background:#fef2f2;border-color:#fecaca;border-left-color:#dc2626;">
      <div class="title">Alumni DB Lookup Failed</div>
      <div class="meta small">${escapeHtml(e.message || "Unknown error")}</div>
    </div>`;
    ALUMNI_MATCH_CACHE = null;
  }
}

function applyAlumniMatch() {
  const a = ALUMNI_MATCH_CACHE;
  if (!a) return;
  if (!document.getElementById("f-first").value) document.getElementById("f-first").value = a.first_name || "";
  if (!document.getElementById("f-last").value)  document.getElementById("f-last").value  = a.last_name || "";
  if (!document.getElementById("f-pref").value)  document.getElementById("f-pref").value  = a.preferred_name || "";
  if (!document.getElementById("f-email").value) document.getElementById("f-email").value = a.email || "";
  if (!document.getElementById("f-cell").value)  document.getElementById("f-cell").value  = a.cell_phone || "";
  if (!document.getElementById("f-phone").value) document.getElementById("f-phone").value = a.phone || "";
  if (!document.getElementById("f-linkedin").value) document.getElementById("f-linkedin").value = a.linkedin_url || "";

  // show the read-only alumni reference section
  document.getElementById("alumni-extra").classList.remove("hidden");
  document.getElementById("f-gradyear").value = a.grad_year || "";
  document.getElementById("f-major").value    = a.alum_major || "";
  document.getElementById("f-alumid").value   = a.contact_id || "";
  document.getElementById("f-org").value      = a.organization || "";
  document.getElementById("f-title").value    = a.title || "";

  toast("Alumni data loaded. Click Save to keep it on this prospect.", "success");
}

function dismissAlumniMatch() {
  ALUMNI_MATCH_CACHE = null;
  document.getElementById("alumni-match-banner").innerHTML = "";
  document.getElementById("alumni-extra").classList.add("hidden");
}

// =========================================================================
// IMPORT — CSV paste flow, with alumni match per row
// =========================================================================
let IMPORT_ROWS = [];

function parseImportCsv() {
  const txt = document.getElementById("import-csv").value.trim();
  if (!txt) { toast("Paste CSV data first.", "error"); return; }

  // Simple CSV parser (handles quoted values)
  const rows = [];
  txt.split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (c === '"') { q = false; }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    rows.push(out);
  });

  if (rows.length < 2) { toast("Need headers plus at least one data row.", "error"); return; }
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g,"_"));
  IMPORT_ROWS = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (r[i]||"").trim());
    // normalize programs list
    if (obj.programs_of_interest) {
      obj._programs = obj.programs_of_interest.split(/[;,|]/).map(x => x.trim()).filter(Boolean);
    } else obj._programs = [];
    return obj;
  });

  renderImportPreview();
}

async function renderImportPreview() {
  const root = document.getElementById("import-preview");
  root.innerHTML = `<p><span class="loader"></span> Checking ${IMPORT_ROWS.length} rows against Alumni Database…</p>`;

  // Check each row for alumni match (batched by email)
  const emails = IMPORT_ROWS.map(r => (r.email||"").toLowerCase()).filter(Boolean);
  let matches = {};
  if (emails.length > 0) {
    try {
      const { data, error } = await alu
        .from("contacts")
        .select("contact_id,name,email,grad_year,alum_major,organization,title,roles")
        .in("email", emails);
      if (!error && data) {
        data.forEach(c => { if (c.email) matches[c.email.toLowerCase()] = c; });
      }
    } catch (e) { console.error("import alu lookup error", e); }
  }

  let html = `<h3>Preview — ${IMPORT_ROWS.length} rows</h3>
    <p class="small muted">Green rows matched an alumni record and will pull alumni data on import. Use the checkbox to skip rows you don't want to import.</p>
    <div style="max-height:420px; overflow:auto; border:1px solid var(--line); border-radius:6px;">
    <table class="data">
      <thead><tr>
        <th><input type="checkbox" id="imp-all" checked onchange="toggleAllImport(this.checked)"></th>
        <th>First</th><th>Last</th><th>Email</th><th>Program(s)</th><th>Alumni Match</th>
      </tr></thead>
      <tbody>`;
  IMPORT_ROWS.forEach((r, i) => {
    const email = (r.email||"").toLowerCase();
    const m = matches[email];
    r._match = m || null;
    html += `<tr${m ? ' style="background:#f0fdf4;"' : ""}>
      <td><input type="checkbox" class="imp-row" data-idx="${i}" checked></td>
      <td>${escapeHtml(r.first_name||"")}</td>
      <td>${escapeHtml(r.last_name||"")}</td>
      <td>${escapeHtml(r.email||"")}</td>
      <td class="small">${escapeHtml((r._programs||[]).join(", "))}</td>
      <td class="small">${m ? `✓ ${escapeHtml(m.name||"")}${m.grad_year?" ('" + String(m.grad_year).slice(-2)+")":""}` : '<span class="muted">—</span>'}</td>
    </tr>`;
  });
  html += `</tbody></table></div>
    <div class="toolbar" style="margin-top:12px;">
      <button class="btn" onclick="runImport()">Import Selected</button>
      <button class="btn ghost" onclick="document.getElementById('import-preview').innerHTML=''">Cancel</button>
    </div>`;
  root.innerHTML = html;
}

function toggleAllImport(on) {
  document.querySelectorAll(".imp-row").forEach(cb => cb.checked = on);
}

async function runImport() {
  const selected = [...document.querySelectorAll(".imp-row:checked")].map(cb => parseInt(cb.dataset.idx));
  if (selected.length === 0) { toast("Select at least one row.", "error"); return; }

  const records = selected.map(i => {
    const r = IMPORT_ROWS[i];
    const rec = {
      first_name: r.first_name || null,
      last_name:  r.last_name || null,
      preferred_name: r.preferred_name || null,
      name: [r.preferred_name || r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      email: r.email ? r.email.toLowerCase() : null,
      cell_phone: r.cell_phone || null,
      phone:      r.phone || null,
      linkedin_url: r.linkedin_url || null,
      source_of_contact: r.source_of_contact || "Spreadsheet Import",
      first_contact_date: r.first_contact_date || new Date().toISOString().slice(0,10),
      potential_entry_term: (r.potential_entry_term||"").toLowerCase() || null,
      programs_of_interest: r._programs || [],
      notes: r.notes || null,
      application_status: "inquiry",
    };
    if (r._match) {
      rec.is_alum = true;
      rec.alumni_contact_id = r._match.contact_id;
      rec.grad_year = r._match.grad_year || null;
      rec.alum_major = r._match.alum_major || null;
      rec.organization = r._match.organization || null;
      rec.title = r._match.title || null;
      rec.roles = r._match.roles || [];
    }
    return rec;
  });

  try {
    const { data, error } = await adm.from("prospects").upsert(records, { onConflict: "email", ignoreDuplicates: false }).select();
    if (error) throw error;
    logAudit("import", `Imported ${data.length} prospects via CSV paste`);
    toast(`Imported ${data.length} prospects.`, "success");
    document.getElementById("import-preview").innerHTML = "";
    document.getElementById("import-csv").value = "";
    loadProspects();
    refreshDashboard();
  } catch (e) {
    console.error(e);
    toast("Import error: " + e.message, "error");
  }
}

// =========================================================================
// EXPORT
// =========================================================================
function exportProspectsCsv() {
  if (PROSPECTS_CACHE.length === 0) { toast("No prospects to export.", "error"); return; }
  const cols = ["prospect_id","first_name","last_name","preferred_name","email","cell_phone","phone",
    "linkedin_url","source_of_contact","first_contact_date","potential_entry_term","potential_entry_year",
    "programs_of_interest","application_status","assigned_to","is_alum","grad_year","alum_major","notes","created_at"];
  const q = (s) => {
    if (s == null) return "";
    const str = Array.isArray(s) ? s.join(";") : String(s);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g,'""')}"`;
    return str;
  };
  const lines = [cols.join(",")];
  PROSPECTS_CACHE.forEach(p => lines.push(cols.map(c => q(p[c])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `admissions_prospects_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  logAudit("export", `Exported ${PROSPECTS_CACHE.length} prospects to CSV`);
}

// =========================================================================
// MESSAGES
// =========================================================================
async function loadMessages() {
  const tbody = document.getElementById("msg-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="muted center"><span class="loader"></span> Loading…</td></tr>`;
  try {
    const { data, error } = await adm.from("platform_messages")
      .select("*").order("sent_at", { ascending: false }).limit(500);
    if (error) throw error;
    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted center">No messages sent yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(m => `
      <tr>
        <td class="small">${new Date(m.sent_at).toLocaleString()}</td>
        <td><span class="pill ${m.channel==='sms'?'in_progress':'inquiry'}">${escapeHtml(m.channel)}</span></td>
        <td class="small">${escapeHtml(m.recipient||"")}</td>
        <td class="small">${escapeHtml(m.subject||"")}</td>
        <td class="small">${escapeHtml(m.sent_by||"")}</td>
        <td class="small">${escapeHtml(m.status||"")}</td>
      </tr>`).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// =========================================================================
// AUDIT LOG
// =========================================================================
async function loadAudit() {
  const tbody = document.getElementById("audit-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="muted center"><span class="loader"></span> Loading…</td></tr>`;
  try {
    const { data, error } = await adm.from("audit_log")
      .select("*").order("occurred_at", { ascending: false }).limit(500);
    if (error) throw error;
    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted center">No audit entries yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(a => `
      <tr>
        <td class="small">${new Date(a.occurred_at).toLocaleString()}</td>
        <td class="small">${escapeHtml(a.username||"")}</td>
        <td class="small"><strong>${escapeHtml(a.action)}</strong></td>
        <td class="small">${escapeHtml(a.detail||"")}</td>
      </tr>`).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function logAudit(action, detail) {
  if (!CURRENT_USER) return;
  try {
    await adm.from("audit_log").insert({ username: CURRENT_USER.username, action, detail });
  } catch (e) { console.error("audit log error:", e); }
}

async function logHistory(prospectId, action, changes, source) {
  if (!CURRENT_USER) return;
  try {
    await adm.from("contact_history").insert({
      prospect_id: prospectId, action, changes,
      changed_by: CURRENT_USER.username, data_source: source || null
    });
  } catch (e) { console.error("history log error:", e); }
}

// =========================================================================
// ENRICHMENT QUEUE (stub for now — full PDL flow is next build)
// =========================================================================
async function loadEnrichmentQueue() {
  const root = document.getElementById("research-queue");
  root.innerHTML = `<p><span class="loader"></span> Loading queue…</p>`;
  try {
    const { data, error } = await adm.from("enrichment_queue")
      .select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    if (!data || data.length === 0) {
      root.innerHTML = `<p class="muted small">No items in the enrichment queue. Run enrichment from the Single Contact button above once you have prospects.</p>`;
      return;
    }
    root.innerHTML = `<p class="small muted">${data.length} items in queue</p>
      <table class="data"><thead><tr><th>Created</th><th>Prospect ID</th><th>Status</th><th>Confidence</th><th>Matched On</th></tr></thead>
      <tbody>${data.map(q => `<tr>
        <td class="small">${new Date(q.created_at).toLocaleString()}</td>
        <td class="small">${q.prospect_id}</td>
        <td><span class="pill ${q.status==='pending'?'in_progress':'complete'}">${q.status}</span></td>
        <td>${q.confidence ?? ""}</td>
        <td class="small">${escapeHtml(q.matched_on||"")}</td>
      </tr>`).join("")}</tbody></table>`;
  } catch (e) {
    root.innerHTML = `<p class="muted">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// =========================================================================
// PASSWORD CHANGE
// =========================================================================
function openPasswordModal() {
  document.getElementById("pw-user").textContent = CURRENT_USER.username;
  document.getElementById("pw-current").value = "";
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-new2").value = "";
  document.getElementById("pw-msg").textContent = "";
  document.getElementById("pw-modal").classList.add("show");
}
function closePasswordModal() {
  document.getElementById("pw-modal").classList.remove("show");
}
async function changePassword() {
  const cur = document.getElementById("pw-current").value;
  const nw  = document.getElementById("pw-new").value;
  const nw2 = document.getElementById("pw-new2").value;
  const msg = document.getElementById("pw-msg");
  msg.style.color = "var(--danger)";
  if (!cur || !nw || !nw2) { msg.textContent = "Fill all fields."; return; }
  if (nw !== nw2)          { msg.textContent = "New passwords don't match."; return; }
  if (nw.length < 8)       { msg.textContent = "New password must be at least 8 characters."; return; }
  try {
    const { data, error } = await adm.from("app_users").select("password").eq("username", CURRENT_USER.username).single();
    if (error) throw error;
    if (data.password !== cur) { msg.textContent = "Current password incorrect."; return; }
    const { error: e2 } = await adm.from("app_users").update({ password: nw }).eq("username", CURRENT_USER.username);
    if (e2) throw e2;
    msg.style.color = "var(--success)";
    msg.textContent = "Password updated.";
    logAudit("password_change", "User changed password");
    setTimeout(closePasswordModal, 1200);
  } catch (e) {
    msg.textContent = "Error: " + (e.message||"unknown");
  }
}
