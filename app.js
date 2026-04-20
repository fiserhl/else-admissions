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

// Messaging state (since there's no Twilio/Resend yet — everything handsoff to
// the OS: mailto: opens the default mail app, sms: opens Apple Messages).
// After a handoff we prompt the user "did you send it?" and only log on Yes.
let PENDING_SEND = null;      // { prospect_id, channel, recipient, name, subject, body, bulk, recipients[] }
let BULK_SELECTION = new Set();// prospect_ids selected in the Messages-tab bulk compose

// Multi-select filter state — each is a Set of selected values. Empty = "all".
let FILTER_PROGRAMS = new Set();
let FILTER_YEARS    = new Set();
let FILTER_TERMS    = new Set();
let FILTER_SOURCES  = new Set();  // broad category: Career Fair / Employer Event / Open House / etc.
let FILTER_EVENTS   = new Set();  // specific event names
let ALL_EVENTS      = [];         // [{name, n, most_recent_date}, …] loaded from source_events_list view

// Parallel filter state for the Messages-tab bulk compose section.
// Kept independent from the Prospects-tab filters so filtering in one place
// doesn't silently change what's visible in the other.
let FILTER_BC_PROGRAMS = new Set();
let FILTER_BC_YEARS    = new Set();
let FILTER_BC_TERMS    = new Set();
let FILTER_BC_SOURCES  = new Set();
let FILTER_BC_EVENTS   = new Set();

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
  // wire pill-filter clicks (delegated, since year pills are populated later).
  // Same handler services both the Prospects tab (p-*) and the Messages-tab
  // bulk compose (bc-*) pill groups — which set gets mutated is determined
  // by the containing pill-group's id.
  document.addEventListener("click", e => {
    const btn = e.target.closest(".pill-btn");
    if (btn) {
      const group = btn.closest(".pill-group");
      if (group) {
        const val = btn.dataset.val;
        let set, rerender;
        if (group.id === "p-program-pills")        { set = FILTER_PROGRAMS;    rerender = renderProspects; }
        else if (group.id === "p-year-pills")      { set = FILTER_YEARS;       rerender = renderProspects; }
        else if (group.id === "p-term-pills")      { set = FILTER_TERMS;       rerender = renderProspects; }
        else if (group.id === "p-source-pills")    { set = FILTER_SOURCES;     rerender = renderProspects; }
        else if (group.id === "bc-program-pills")  { set = FILTER_BC_PROGRAMS; rerender = renderBulkRecipients; }
        else if (group.id === "bc-year-pills")     { set = FILTER_BC_YEARS;    rerender = renderBulkRecipients; }
        else if (group.id === "bc-term-pills")     { set = FILTER_BC_TERMS;    rerender = renderBulkRecipients; }
        else if (group.id === "bc-source-pills")   { set = FILTER_BC_SOURCES;  rerender = renderBulkRecipients; }
        else return;
        if (set.has(val)) set.delete(val); else set.add(val);
        btn.classList.toggle("active");
        rerender();
        return;
      }
    }
    // Close the Prospects-tab event dropdown if clicking outside it
    const pDropdown = document.getElementById("p-event-dropdown");
    if (pDropdown && !pDropdown.classList.contains("hidden")) {
      if (!e.target.closest("#p-event-dropdown") && !e.target.closest("#p-event-toggle")) {
        pDropdown.classList.add("hidden");
      }
    }
    // Same for the Messages-tab event dropdown
    const bcDropdown = document.getElementById("bc-event-dropdown");
    if (bcDropdown && !bcDropdown.classList.contains("hidden")) {
      if (!e.target.closest("#bc-event-dropdown") && !e.target.closest("#bc-event-toggle")) {
        bcDropdown.classList.add("hidden");
      }
    }
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
// MESSAGING HELPERS — mailto: / sms: handoffs, clipboard, confirm flow
// =========================================================================
// No Twilio/Resend yet. These helpers hand off to whatever mail app or
// Apple Messages install is set as the OS default, then prompt the user
// "did you send it?" and only log on confirmation. That way the Messages
// Sent log stays honest (we can't actually verify external app sends).

function openExternal(url) {
  // Using window.location for mailto:/sms: is the safest cross-browser path —
  // the browser hands off to the protocol handler without actually navigating.
  try { window.location.href = url; } catch (e) { console.error("openExternal failed:", e); }
}

function normalizePhoneForSms(phone) {
  // US-only for now per Harvey. Returns +1XXXXXXXXXX or null if unparseable.
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

async function copyText(text, successMsg) {
  if (!text) { toast("Nothing to copy.", "error"); return false; }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older Safari / non-HTTPS (shouldn't hit this on pages.github.io)
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast(successMsg || "Copied to clipboard.", "success");
    return true;
  } catch (e) {
    console.error("clipboard error:", e);
    toast("Couldn't copy — browser blocked clipboard access.", "error");
    return false;
  }
}

// ---- Single prospect launchers ----
function launchEmail(prospectId) {
  const p = PROSPECTS_CACHE.find(x => x.prospect_id === prospectId);
  if (!p) return;
  if (p.do_not_contact) { toast("This prospect is marked Do Not Contact.", "error"); return; }
  if (!p.email) { toast("No email address on file.", "error"); return; }
  openExternal(`mailto:${encodeURIComponent(p.email)}`);
  setTimeout(() => promptSendConfirmation({
    prospect_id: p.prospect_id, channel: "email",
    recipient: p.email, name: displayName(p)
  }), 600);
}

function launchSms(prospectId) {
  const p = PROSPECTS_CACHE.find(x => x.prospect_id === prospectId);
  if (!p) return;
  if (p.do_not_contact) { toast("This prospect is marked Do Not Contact.", "error"); return; }
  const raw = p.cell_phone || p.phone;
  const num = normalizePhoneForSms(raw);
  if (!num) { toast("No valid cell phone number on file.", "error"); return; }
  // sms: works on iOS/macOS. "&body=" is iOS-friendly; use "?body=" for broader compat.
  openExternal(`sms:${num}`);
  setTimeout(() => promptSendConfirmation({
    prospect_id: p.prospect_id, channel: "sms",
    recipient: num, name: displayName(p)
  }), 600);
}

function copyEmailAddress(prospectId) {
  const p = PROSPECTS_CACHE.find(x => x.prospect_id === prospectId);
  if (!p || !p.email) { toast("No email to copy.", "error"); return; }
  copyText(p.email, `Copied ${p.email}`);
}

function copyPhoneNumber(prospectId) {
  const p = PROSPECTS_CACHE.find(x => x.prospect_id === prospectId);
  if (!p) return;
  const raw = p.cell_phone || p.phone;
  if (!raw) { toast("No phone number to copy.", "error"); return; }
  copyText(raw, `Copied ${raw}`);
}

// ---- "Did you send it?" confirmation modal ----
function promptSendConfirmation(data) {
  PENDING_SEND = data;
  const channelEl = document.getElementById("sc-channel");
  const nameEl    = document.getElementById("sc-name");
  const recipEl   = document.getElementById("sc-recipient");
  const subjEl    = document.getElementById("sc-subject");
  const titleEl   = document.getElementById("sc-title");

  if (data.bulk) {
    titleEl.textContent = "Did you send the bulk email?";
    channelEl.textContent = "email";
    nameEl.textContent = `${data.count} recipients`;
    recipEl.textContent = data.recipients.map(r => r.recipient).slice(0,3).join(", ")
      + (data.count > 3 ? ` + ${data.count - 3} more` : "");
  } else {
    titleEl.textContent = "Did you send it?";
    channelEl.textContent = data.channel === "email" ? "email" : "text message";
    nameEl.textContent = data.name || "this prospect";
    recipEl.textContent = data.recipient || "";
  }
  subjEl.value = "";
  // For SMS, hide the subject field — no subject on a text.
  subjEl.parentElement.style.display = (data.channel === "sms" && !data.bulk) ? "none" : "";
  document.getElementById("send-confirm-modal").classList.add("show");
}

function dismissSendConfirm() {
  PENDING_SEND = null;
  document.getElementById("send-confirm-modal").classList.remove("show");
}

async function confirmSent() {
  if (!PENDING_SEND) { dismissSendConfirm(); return; }
  const subject = document.getElementById("sc-subject").value.trim() || null;
  const pd = PENDING_SEND;
  const today = new Date().toISOString().slice(0,10);

  try {
    if (pd.bulk) {
      // One row per recipient — keeps the Messages tab and per-prospect history clean
      const rows = pd.recipients.map(r => ({
        prospect_id: r.prospect_id,
        channel: "email",
        direction: "outbound",
        recipient: r.recipient,
        subject: subject,
        body: null,
        sent_by: CURRENT_USER.username,
        status: "sent"
      }));
      // Chunk at 40 (matches the general bulk-insert convention on this project)
      for (let i = 0; i < rows.length; i += 40) {
        const chunk = rows.slice(i, i + 40);
        const { error } = await adm.from("platform_messages").insert(chunk);
        if (error) throw error;
      }
      // Update last_contact_date on each prospect
      const ids = pd.recipients.map(r => r.prospect_id).filter(Boolean);
      if (ids.length > 0) {
        await adm.from("prospects").update({ last_contact_date: today }).in("prospect_id", ids);
      }
      // Per-prospect history rows
      for (const r of pd.recipients) {
        if (r.prospect_id) {
          await logHistory(r.prospect_id, "contacted",
            `Bulk email sent to ${r.recipient}${subject ? ": " + subject : ""}`,
            "mailto bulk handoff");
        }
      }
      logAudit("bulk_email_sent", `Logged bulk email to ${pd.count} recipients${subject ? ": " + subject : ""}`);
      toast(`Logged ${pd.count} sends.`, "success");
    } else {
      const payload = {
        prospect_id: pd.prospect_id,
        channel: pd.channel,
        direction: "outbound",
        recipient: pd.recipient,
        subject: subject,
        body: null,
        sent_by: CURRENT_USER.username,
        status: "sent"
      };
      const { error } = await adm.from("platform_messages").insert(payload);
      if (error) throw error;
      if (pd.prospect_id) {
        await adm.from("prospects").update({ last_contact_date: today }).eq("prospect_id", pd.prospect_id);
        await logHistory(pd.prospect_id, "contacted",
          `${pd.channel === "email" ? "Email" : "Text"} sent to ${pd.recipient}${subject ? ": " + subject : ""}`,
          pd.channel === "email" ? "mailto handoff" : "sms handoff");
      }
      toast("Logged as sent.", "success");
    }
    dismissSendConfirm();
    // refresh any visible views that depend on this data
    loadProspects();
    refreshDashboard();
    if (!document.getElementById("tab-messages").classList.contains("hidden")) {
      loadMessages();
    }
  } catch (e) {
    console.error(e);
    toast("Error logging: " + (e.message || "unknown"), "error");
  }
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
  loadSourceEvents();
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

  if (tab === "messages")  { loadMessages(); renderBulkRecipients(); }
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
      .order("last_name",  { ascending: true, nullsFirst: false })
      .order("first_name", { ascending: true, nullsFirst: false })
      .limit(5000);
    if (error) throw error;
    PROSPECTS_CACHE = data || [];
    populateAssignedFilter();
    populateBcAssignedFilter();
    populateYearPills();
    populateBcYearPills();
    renderProspects();
    renderBulkRecipients();
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

// Populate the Year pill group — always show 2020..2029 plus any outlier years actually in data.
// This way you can filter by any valid entry year even if nobody's currently assigned to it.
function populateYearPills() {
  const host = document.getElementById("p-year-pills");
  if (!host) return;
  // years actually assigned to prospects
  const actualYears = PROSPECTS_CACHE.map(p => p.potential_entry_year).filter(Boolean);
  const actualSet = new Set(actualYears);
  // count per year for the badge
  const counts = {};
  actualYears.forEach(y => { counts[y] = (counts[y]||0)+1; });
  // fixed range 2020-2029 + any year outside that range that exists in data
  const fixedRange = [2029,2028,2027,2026,2025,2024,2023,2022,2021,2020];
  const extras = [...actualSet].filter(y => y<2020 || y>2029).sort((a,b)=>b-a);
  const allYears = [...extras, ...fixedRange];
  host.innerHTML = allYears.map(y => {
    const n = counts[y] || 0;
    const active = FILTER_YEARS.has(String(y)) ? " active" : "";
    const dim = n === 0 ? " dim" : "";
    const badge = n > 0 ? ` <span class="pill-count">${n}</span>` : "";
    return `<button class="pill-btn${active}${dim}" data-val="${y}">${y}${badge}</button>`;
  }).join("");
}

// ---- Source Event dropdown ----
async function loadSourceEvents() {
  try {
    const { data, error } = await adm.from("source_events_list").select("*");
    if (error) throw error;
    ALL_EVENTS = data || [];
    updateEventButton();
    updateBcEventButton();
    renderEventList();
  } catch (e) {
    console.error("source events load error:", e);
  }
}

function toggleEventDropdown(evt) {
  if (evt) evt.stopPropagation();
  const dd = document.getElementById("p-event-dropdown");
  dd.classList.toggle("hidden");
  if (!dd.classList.contains("hidden")) renderEventList();
}

function renderEventList() {
  const list = document.getElementById("p-event-list");
  if (!list) return;
  const query = (document.getElementById("p-event-search")?.value || "").toLowerCase().trim();
  const showAll = document.getElementById("p-event-showall")?.checked;

  let events = ALL_EVENTS.slice();
  if (query) events = events.filter(e => e.name.toLowerCase().includes(query));
  // Default view: top 10 by most_recent_date (list already sorted that way from the view).
  // Show-all toggle OR a search query disables the 10-cap.
  if (!showAll && !query) events = events.slice(0, 10);

  if (events.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:14px; text-align:center; font-size:0.85rem;">No events match.</div>`;
    return;
  }

  list.innerHTML = events.map(e => {
    const checked = FILTER_EVENTS.has(e.name) ? "checked" : "";
    const safe = escapeHtml(e.name);
    return `<label>
      <input type="checkbox" data-ev="${safe}" ${checked} onchange="toggleEvent(this)">
      <span class="ev-name">${safe}</span>
      <span class="ev-count">${e.n}</span>
    </label>`;
  }).join("");
}

function toggleEvent(cb) {
  const name = cb.dataset.ev;
  if (cb.checked) FILTER_EVENTS.add(name); else FILTER_EVENTS.delete(name);
  updateEventButton();
  renderProspects();
}

function updateEventButton() {
  const label = document.getElementById("p-event-label");
  const badge = document.getElementById("p-event-count");
  if (!label || !badge) return;
  if (FILTER_EVENTS.size === 0) {
    label.textContent = "Any event";
    badge.textContent = "";
  } else {
    label.textContent = "Filtered";
    badge.textContent = ` (${FILTER_EVENTS.size})`;
  }
}

function clearEventFilter() {
  FILTER_EVENTS.clear();
  updateEventButton();
  renderEventList();
  renderProspects();
}

function clearFilters() {
  FILTER_PROGRAMS.clear();
  FILTER_YEARS.clear();
  FILTER_TERMS.clear();
  FILTER_SOURCES.clear();
  FILTER_EVENTS.clear();
  document.getElementById("p-search").value = "";
  document.getElementById("p-status").value = "";
  document.getElementById("p-assigned").value = "";
  const search = document.getElementById("p-event-search");
  if (search) search.value = "";
  const showAll = document.getElementById("p-event-showall");
  if (showAll) showAll.checked = false;
  document.querySelectorAll(".pill-btn.active").forEach(b => b.classList.remove("active"));
  updateEventButton();
  renderEventList();
  renderProspects();
}

function renderProspects() {
  const q  = (document.getElementById("p-search").value || "").toLowerCase();
  const st = document.getElementById("p-status").value;
  const ag = document.getElementById("p-assigned").value;
  const showAll = (st === "__all__"); // special sentinel

  const filtered = PROSPECTS_CACHE.filter(p => {
    // Default view hides withdrawn/declined to prevent accidental outreach.
    // Pick a specific status from the dropdown, OR "Show ALL", to view them.
    if (!st && (p.application_status === "withdrawn" || p.application_status === "declined")) return false;
    if (st && !showAll && p.application_status !== st) return false;
    if (ag && p.assigned_to !== ag) return false;

    // Multi-select program (OR logic within the group)
    if (FILTER_PROGRAMS.size > 0) {
      const progs = p.programs_of_interest || [];
      let hit = false;
      for (const v of FILTER_PROGRAMS) { if (progs.includes(v)) { hit = true; break; } }
      if (!hit) return false;
    }
    // Multi-select year
    if (FILTER_YEARS.size > 0) {
      if (!p.potential_entry_year || !FILTER_YEARS.has(String(p.potential_entry_year))) return false;
    }
    // Multi-select term
    if (FILTER_TERMS.size > 0) {
      if (!p.potential_entry_term || !FILTER_TERMS.has(p.potential_entry_term)) return false;
    }
    // Multi-select broad source (Career Fair, Employer Event, etc.)
    if (FILTER_SOURCES.size > 0) {
      if (!p.source_of_contact || !FILTER_SOURCES.has(p.source_of_contact)) return false;
    }
    // Multi-select specific event
    if (FILTER_EVENTS.size > 0) {
      if (!p.source_event || !FILTER_EVENTS.has(p.source_event)) return false;
    }
    // Search box
    if (q) {
      const hay = [p.first_name, p.last_name, p.preferred_name, p.email, p.organization, p.cell_phone, p.phone]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const hiddenCount = (!st) ? PROSPECTS_CACHE.filter(p => p.application_status === "withdrawn" || p.application_status === "declined").length : 0;

  // Build an "active filters" summary line
  const activeBits = [];
  if (FILTER_PROGRAMS.size) activeBits.push(`Programs: ${[...FILTER_PROGRAMS].map(programLabel).join(", ")}`);
  if (FILTER_YEARS.size)    activeBits.push(`Year${FILTER_YEARS.size>1?"s":""}: ${[...FILTER_YEARS].sort().join(", ")}`);
  if (FILTER_TERMS.size)    activeBits.push(`Term${FILTER_TERMS.size>1?"s":""}: ${[...FILTER_TERMS].map(termLabel).join(", ")}`);
  if (FILTER_SOURCES.size)  activeBits.push(`Source${FILTER_SOURCES.size>1?"s":""}: ${[...FILTER_SOURCES].join(", ")}`);
  if (FILTER_EVENTS.size)   activeBits.push(`Event${FILTER_EVENTS.size>1?"s":""}: ${[...FILTER_EVENTS].join(", ")}`);
  if (st && !showAll)       activeBits.push(`Status: ${st.replace(/_/g," ")}`);
  if (showAll)              activeBits.push(`Status: ALL`);
  if (ag)                   activeBits.push(`Assigned: ${ag}`);
  if (q)                    activeBits.push(`Search: "${q}"`);

  const countText = `${filtered.length.toLocaleString()} prospect${filtered.length===1?"":"s"}`
    + (activeBits.length ? ` · ${activeBits.join(" · ")}` : "")
    + (hiddenCount > 0 ? ` · ${hiddenCount} withdrawn/declined hidden (filter by status to view)` : "");
  document.getElementById("p-count").textContent = countText;

  const tbody = document.getElementById("p-tbody");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted center">No prospects match your filters. <a href="#" onclick="openProspectModal();return false;">Add a prospect</a>.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(p => {
    const name = displayName(p);
    const programs = (p.programs_of_interest || []).map(x => programLabel(x)).join(", ") || "<span class='muted'>—</span>";
    const alumPill = p.is_alum ? ` <span class="pill alum">Alum</span>` : "";
    const dncPill  = p.do_not_contact ? ` <span class="pill declined" title="${escapeHtml(p.dnc_reason||'')}">🚫 DNC</span>` : "";

    // Inline compose actions — hidden entirely for DNC prospects so they can't be contacted by accident
    const phoneDisplay = p.cell_phone || p.phone || "";
    const hasSmsPhone  = !!normalizePhoneForSms(p.cell_phone || p.phone);
    let emailActions = "";
    let phoneActions = "";
    if (!p.do_not_contact) {
      if (p.email) {
        emailActions = `
          <button class="act-btn" title="Email this prospect" onclick="event.stopPropagation(); launchEmail(${p.prospect_id})">✉</button>
          <button class="act-btn copy" title="Copy email address" onclick="event.stopPropagation(); copyEmailAddress(${p.prospect_id})">📋</button>`;
      }
      if (phoneDisplay) {
        phoneActions = `
          ${hasSmsPhone ? `<button class="act-btn" title="Text this prospect (Apple Messages)" onclick="event.stopPropagation(); launchSms(${p.prospect_id})">💬</button>` : `<button class="act-btn" title="Phone number can't be sent via SMS" disabled>💬</button>`}
          <button class="act-btn copy" title="Copy phone number" onclick="event.stopPropagation(); copyPhoneNumber(${p.prospect_id})">📋</button>`;
      }
    }

    return `
      <tr onclick="openProspectModal(${p.prospect_id})">
        <td><strong>${escapeHtml(name)}</strong>${alumPill}${dncPill}</td>
        <td>${escapeHtml(p.email||"")}${emailActions}</td>
        <td>${escapeHtml(phoneDisplay)}${phoneActions}</td>
        <td class="small">${programs}</td>
        <td>${p.potential_entry_year||""} ${termLabel(p.potential_entry_term)}</td>
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

  // clear modal compose action slots (populated below for saved prospects)
  document.getElementById("modal-email-actions").innerHTML = "";
  document.getElementById("modal-cell-actions").innerHTML = "";

  // clear form
  ["f-first","f-last","f-pref","f-email","f-cell","f-phone","f-linkedin",
   "f-source","f-firstdate","f-term","f-year","f-appstatus","f-assigned","f-notes",
   "f-gradyear","f-major","f-alumid","f-org","f-title","f-dnc-reason"].forEach(k => {
    const el = document.getElementById(k);
    if (el) el.value = "";
  });
  document.querySelectorAll("#f-programs input[type=checkbox]").forEach(cb => cb.checked = false);
  document.getElementById("f-dnc").checked = false;
  document.getElementById("f-dnc-detail").classList.add("hidden");
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
      document.getElementById("f-dnc").checked    = !!p.do_not_contact;
      document.getElementById("f-dnc-reason").value = p.dnc_reason || "";
      if (p.do_not_contact) document.getElementById("f-dnc-detail").classList.remove("hidden");
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
      renderModalComposeActions(p);
    }
  }
  document.getElementById("prospect-modal").classList.add("show");
}

// Populate the Email/SMS/Copy buttons inside the modal. Shows a DNC notice
// for prospects flagged Do-Not-Contact instead of the action buttons.
function renderModalComposeActions(p) {
  const emailSlot = document.getElementById("modal-email-actions");
  const cellSlot  = document.getElementById("modal-cell-actions");
  if (!emailSlot || !cellSlot) return;

  if (p.do_not_contact) {
    const reason = p.dnc_reason ? ` — ${escapeHtml(p.dnc_reason)}` : "";
    const dated = p.dnc_date ? ` (${formatDate(p.dnc_date)})` : "";
    const notice = `<div class="dnc-notice">🚫 Do Not Contact${dated}
      <div class="meta">All outreach is blocked for this prospect${reason}</div>
    </div>`;
    emailSlot.innerHTML = notice;
    cellSlot.innerHTML = "";
    return;
  }

  if (p.email) {
    emailSlot.innerHTML = `
      <button class="btn small" type="button" onclick="launchEmail(${p.prospect_id})">✉ Email</button>
      <button class="btn small secondary" type="button" onclick="copyEmailAddress(${p.prospect_id})">📋 Copy address</button>`;
  } else {
    emailSlot.innerHTML = `<span class="small muted">Save an email address to enable compose.</span>`;
  }

  const num = normalizePhoneForSms(p.cell_phone || p.phone);
  if (num) {
    cellSlot.innerHTML = `
      <button class="btn small" type="button" onclick="launchSms(${p.prospect_id})">💬 Text (Apple Messages)</button>
      <button class="btn small secondary" type="button" onclick="copyPhoneNumber(${p.prospect_id})">📋 Copy number</button>`;
  } else if (p.cell_phone || p.phone) {
    cellSlot.innerHTML = `<span class="small muted">Phone number doesn't look like a US cell — only copy is available.</span>
      <button class="btn small secondary" type="button" onclick="copyPhoneNumber(${p.prospect_id})">📋 Copy number</button>`;
  } else {
    cellSlot.innerHTML = "";
  }
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
  const dncChecked = document.getElementById("f-dnc").checked;

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
    do_not_contact:       dncChecked,
    dnc_reason:           dncChecked ? (document.getElementById("f-dnc-reason").value.trim() || null) : null,
    dnc_date:             dncChecked ? new Date().toISOString().slice(0,10) : null,
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
    loadSourceEvents();
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

// Show/hide the DNC reason input when the checkbox changes
function toggleDncReason() {
  const on = document.getElementById("f-dnc").checked;
  document.getElementById("f-dnc-detail").classList.toggle("hidden", !on);
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
// BULK COMPOSE (Messages tab)
// =========================================================================
// Lets Harvey pick a bunch of prospects and hand off a single mailto: with
// all selected emails in BCC, or copy emails/phones to the clipboard for
// pasting into another tool. DNC prospects are filtered out everywhere here.
// Filter controls mirror the Prospects tab one-for-one but carry their own
// state (FILTER_BC_*) so filtering here doesn't affect the Prospects view.

// ---- Populate filter controls from loaded data ----
function populateBcAssignedFilter() {
  const sel = document.getElementById("bc-assigned");
  if (!sel) return;
  const current = sel.value;
  const names = [...new Set(PROSPECTS_CACHE.map(p => p.assigned_to).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">All assigned</option>` +
    names.map(n => `<option ${n===current?"selected":""}>${escapeHtml(n)}</option>`).join("");
}

// Same algorithm as populateYearPills (fixed range 2020-2029 plus any outlier
// years that actually exist in data), targeting the bulk-compose container.
function populateBcYearPills() {
  const host = document.getElementById("bc-year-pills");
  if (!host) return;
  const actualYears = PROSPECTS_CACHE.map(p => p.potential_entry_year).filter(Boolean);
  const actualSet = new Set(actualYears);
  const counts = {};
  actualYears.forEach(y => { counts[y] = (counts[y]||0)+1; });
  const fixedRange = [2029,2028,2027,2026,2025,2024,2023,2022,2021,2020];
  const extras = [...actualSet].filter(y => y<2020 || y>2029).sort((a,b)=>b-a);
  const allYears = [...extras, ...fixedRange];
  host.innerHTML = allYears.map(y => {
    const n = counts[y] || 0;
    const active = FILTER_BC_YEARS.has(String(y)) ? " active" : "";
    const dim = n === 0 ? " dim" : "";
    const badge = n > 0 ? ` <span class="pill-count">${n}</span>` : "";
    return `<button class="pill-btn${active}${dim}" data-val="${y}">${y}${badge}</button>`;
  }).join("");
}

// ---- Source Event dropdown (bulk-compose version) ----
function toggleBcEventDropdown(evt) {
  if (evt) evt.stopPropagation();
  const dd = document.getElementById("bc-event-dropdown");
  dd.classList.toggle("hidden");
  if (!dd.classList.contains("hidden")) renderBcEventList();
}

function renderBcEventList() {
  const list = document.getElementById("bc-event-list");
  if (!list) return;
  const query = (document.getElementById("bc-event-search")?.value || "").toLowerCase().trim();
  const showAll = document.getElementById("bc-event-showall")?.checked;

  let events = ALL_EVENTS.slice();
  if (query) events = events.filter(e => e.name.toLowerCase().includes(query));
  if (!showAll && !query) events = events.slice(0, 10);

  if (events.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:14px; text-align:center; font-size:0.85rem;">No events match.</div>`;
    return;
  }

  list.innerHTML = events.map(e => {
    const checked = FILTER_BC_EVENTS.has(e.name) ? "checked" : "";
    const safe = escapeHtml(e.name);
    return `<label>
      <input type="checkbox" data-ev="${safe}" ${checked} onchange="toggleBcEvent(this)">
      <span class="ev-name">${safe}</span>
      <span class="ev-count">${e.n}</span>
    </label>`;
  }).join("");
}

function toggleBcEvent(cb) {
  const name = cb.dataset.ev;
  if (cb.checked) FILTER_BC_EVENTS.add(name); else FILTER_BC_EVENTS.delete(name);
  updateBcEventButton();
  renderBulkRecipients();
}

function updateBcEventButton() {
  const label = document.getElementById("bc-event-label");
  const badge = document.getElementById("bc-event-count");
  if (!label || !badge) return;
  if (FILTER_BC_EVENTS.size === 0) {
    label.textContent = "Any event";
    badge.textContent = "";
  } else {
    label.textContent = "Filtered";
    badge.textContent = ` (${FILTER_BC_EVENTS.size})`;
  }
}

function clearBcEventFilter() {
  FILTER_BC_EVENTS.clear();
  updateBcEventButton();
  renderBcEventList();
  renderBulkRecipients();
}

// Mirror of clearFilters() in the Prospects tab, reset to empty.
// Does NOT clear the selection set — selection persists across filter changes,
// which is how you can, for example, pick some MBA folks, switch to MACC, and
// add more to the same selection before sending.
function clearBulkFilters() {
  FILTER_BC_PROGRAMS.clear();
  FILTER_BC_YEARS.clear();
  FILTER_BC_TERMS.clear();
  FILTER_BC_SOURCES.clear();
  FILTER_BC_EVENTS.clear();
  const search = document.getElementById("bc-search");     if (search) search.value = "";
  const status = document.getElementById("bc-status");     if (status) status.value = "";
  const assigned = document.getElementById("bc-assigned"); if (assigned) assigned.value = "";
  const evSearch = document.getElementById("bc-event-search");  if (evSearch) evSearch.value = "";
  const showAll  = document.getElementById("bc-event-showall"); if (showAll) showAll.checked = false;
  document.querySelectorAll("#bc-program-pills .pill-btn.active, #bc-year-pills .pill-btn.active, #bc-term-pills .pill-btn.active, #bc-source-pills .pill-btn.active")
    .forEach(b => b.classList.remove("active"));
  updateBcEventButton();
  renderBcEventList();
  renderBulkRecipients();
}

function renderBulkRecipients() {
  const list = document.getElementById("bc-list");
  if (!list) return;
  if (PROSPECTS_CACHE.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:20px; text-align:center; font-size:0.88rem;">No prospects loaded yet.</div>`;
    const vc = document.getElementById("bc-visible-count"); if (vc) vc.textContent = "";
    updateBulkCount();
    return;
  }

  const q  = (document.getElementById("bc-search")?.value || "").toLowerCase().trim();
  const st = document.getElementById("bc-status")?.value || "";
  const showAllStatus = (st === "__all__");
  const ag = document.getElementById("bc-assigned")?.value || "";

  const eligible = PROSPECTS_CACHE.filter(p => {
    // DNC is a HARD BLOCK here — never surfaced regardless of filter/status picks.
    if (p.do_not_contact) return false;
    // Default hides withdrawn/declined; pick a specific status or "Show ALL" to include them.
    if (!st && (p.application_status === "withdrawn" || p.application_status === "declined")) return false;
    if (st && !showAllStatus && p.application_status !== st) return false;
    if (ag && p.assigned_to !== ag) return false;

    // Program (OR logic within the group)
    if (FILTER_BC_PROGRAMS.size > 0) {
      const progs = p.programs_of_interest || [];
      let hit = false;
      for (const v of FILTER_BC_PROGRAMS) { if (progs.includes(v)) { hit = true; break; } }
      if (!hit) return false;
    }
    // Year
    if (FILTER_BC_YEARS.size > 0) {
      if (!p.potential_entry_year || !FILTER_BC_YEARS.has(String(p.potential_entry_year))) return false;
    }
    // Term
    if (FILTER_BC_TERMS.size > 0) {
      if (!p.potential_entry_term || !FILTER_BC_TERMS.has(p.potential_entry_term)) return false;
    }
    // Source
    if (FILTER_BC_SOURCES.size > 0) {
      if (!p.source_of_contact || !FILTER_BC_SOURCES.has(p.source_of_contact)) return false;
    }
    // Event
    if (FILTER_BC_EVENTS.size > 0) {
      if (!p.source_event || !FILTER_BC_EVENTS.has(p.source_event)) return false;
    }
    // Search box
    if (q) {
      const hay = [p.first_name, p.last_name, p.preferred_name, p.email, p.organization, p.cell_phone, p.phone]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Running count of DNC hidden — helpful signal if Harvey wonders why someone's missing
  const dncHiddenCount = PROSPECTS_CACHE.filter(p => p.do_not_contact).length;
  const vc = document.getElementById("bc-visible-count");
  if (vc) {
    const bits = [`${eligible.length} visible`];
    if (dncHiddenCount > 0) bits.push(`${dncHiddenCount} DNC hidden`);
    vc.textContent = bits.join(" · ");
  }

  if (eligible.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:20px; text-align:center; font-size:0.88rem;">No eligible prospects match these filters.</div>`;
    const selectAll = document.getElementById("bc-selectall");
    if (selectAll) selectAll.checked = false;
    updateBulkCount();
    return;
  }

  list.innerHTML = eligible.map(p => {
    const checked = BULK_SELECTION.has(p.prospect_id) ? "checked" : "";
    const name = escapeHtml(displayName(p));
    const status = p.application_status || "inquiry";
    const email = p.email ? escapeHtml(p.email) : `<span class="br-missing">no email</span>`;
    const phone = (p.cell_phone || p.phone) ? escapeHtml(p.cell_phone || p.phone) : `<span class="br-missing">no phone</span>`;
    return `<label>
      <input type="checkbox" data-pid="${p.prospect_id}" ${checked} onchange="toggleBulkRecipient(this)">
      <span class="br-name">${name}</span>
      <span class="br-contact">${email}</span>
      <span class="br-contact">${phone}</span>
      <span class="br-status"><span class="pill ${status}">${status.replace(/_/g," ")}</span></span>
    </label>`;
  }).join("");

  // Sync "select all visible" checkbox — checked only if every visible row is in selection
  const selectAll = document.getElementById("bc-selectall");
  if (selectAll) {
    selectAll.checked = eligible.length > 0 && eligible.every(p => BULK_SELECTION.has(p.prospect_id));
  }

  updateBulkCount();
}

function toggleBulkRecipient(cb) {
  const pid = parseInt(cb.dataset.pid);
  if (cb.checked) BULK_SELECTION.add(pid); else BULK_SELECTION.delete(pid);
  updateBulkCount();
  // keep "select all visible" in sync
  const selectAll = document.getElementById("bc-selectall");
  if (selectAll) {
    const visible = [...document.querySelectorAll("#bc-list input[type=checkbox][data-pid]")];
    selectAll.checked = visible.length > 0 && visible.every(x => x.checked);
  }
}

function toggleAllBulkRecipients(on) {
  document.querySelectorAll("#bc-list input[type=checkbox][data-pid]").forEach(cb => {
    const pid = parseInt(cb.dataset.pid);
    cb.checked = on;
    if (on) BULK_SELECTION.add(pid); else BULK_SELECTION.delete(pid);
  });
  updateBulkCount();
}

function clearBulkSelection() {
  BULK_SELECTION.clear();
  document.querySelectorAll("#bc-list input[type=checkbox][data-pid]").forEach(cb => cb.checked = false);
  const selectAll = document.getElementById("bc-selectall");
  if (selectAll) selectAll.checked = false;
  updateBulkCount();
}

function updateBulkCount() {
  const el = document.getElementById("bc-count");
  if (el) el.textContent = `${BULK_SELECTION.size} selected`;
}

// Pull the currently-selected prospects, re-filtering out any DNC (defense
// in depth — DNC can change between render and action).
function getBulkSelectedProspects() {
  return PROSPECTS_CACHE.filter(p =>
    BULK_SELECTION.has(p.prospect_id) && !p.do_not_contact
  );
}

function bulkLaunchEmail() {
  const selected = getBulkSelectedProspects();
  const withEmail = selected.filter(p => p.email);
  if (withEmail.length === 0) {
    toast("No selected prospects have an email on file.", "error");
    return;
  }
  // Dedup emails (case-insensitive)
  const uniq = [...new Map(withEmail.map(p => [p.email.toLowerCase(), p])).values()];
  const bcc  = uniq.map(p => p.email).join(",");
  const skipped = selected.length - uniq.length;

  openExternal(`mailto:?bcc=${encodeURIComponent(bcc)}`);

  setTimeout(() => promptSendConfirmation({
    bulk: true,
    channel: "email",
    count: uniq.length,
    recipients: uniq.map(p => ({ prospect_id: p.prospect_id, recipient: p.email }))
  }), 600);

  if (skipped > 0) {
    toast(`${uniq.length} in BCC. ${skipped} skipped (missing email or duplicate).`, "info");
  }
}

function bulkCopyEmails() {
  const selected = getBulkSelectedProspects();
  const emails = [...new Set(selected.map(p => p.email).filter(Boolean))];
  if (emails.length === 0) { toast("No email addresses to copy.", "error"); return; }
  copyText(emails.join(", "), `Copied ${emails.length} email address${emails.length===1?"":"es"}.`);
}

function bulkCopyPhones() {
  const selected = getBulkSelectedProspects();
  const phones = [...new Set(selected.map(p => p.cell_phone || p.phone).filter(Boolean))];
  if (phones.length === 0) { toast("No phone numbers to copy.", "error"); return; }
  copyText(phones.join(", "), `Copied ${phones.length} phone number${phones.length===1?"":"s"}.`);
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
