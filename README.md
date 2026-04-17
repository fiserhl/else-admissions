# Else Graduate Admissions Tracker & Dashboard

A CRM for managing graduate program prospects at the Else School of Management, Millsaps College.

**Live URL:** https://fiserhl.github.io/else-admissions/

## Architecture

- **Frontend:** Single-file HTML + vanilla JS (hosted on GitHub Pages)
- **Backend:** Supabase project `else-admissions` (ID: `zsnkgqyqwzncijesfuoj`)
- **Alumni matching:** Read-only queries to the separate Supabase project `Else School Operations` (ID: `akegekomjwggrvpphxog`)

## Project Separation

The admissions database is a **completely separate Supabase project** from the alumni CRM. Credentials for the admissions project have no ability to write to the alumni database. The only connection between the two is a read-only query from the admissions app into `alumni.contacts` for the "Check Alumni Match" feature — data flows one direction only (alumni → prospect), never the other way.

## Tables

- `prospects` — graduate admissions prospects (mirrors the alumni contacts structure plus admissions-specific fields)
- `enrichment_queue` — PDL staging area (same pattern as Else CRM)
- `contact_history` — audit log per prospect
- `platform_messages` — tracks emails and texts sent from the platform (drives the monthly counter)
- `audit_log` — general app actions (logins, exports, etc.)
- `app_users` — login accounts
- `pipeline_dashboard` (view) — aggregate counts for the top-of-page dashboard

## Security

- Row-level security enforced via `app_secret_valid()` function on every table
- Vault secret `app_secret` matches the Else CRM (same shared token across both projects)
- PDL API key stored in vault as `pdl_api_key`

## Initial Users

- `hfiser` — admin (Harvey Fiser)
- `mmccaa` — editor (Meg McCaa)
- `rharp`  — editor (Ryan Harp)
- `else`   — admin

Initial password for all accounts: **`ChangeMe2026!`** — each user should change it on first login via Settings.

## Admissions-Specific Fields

- `first_contact_date` — date of first contact (date picker)
- `source_of_contact` — how the prospect found us
- `potential_entry_term` — summer / fall / spring
- `potential_entry_year` — e.g. 2026
- `programs_of_interest` — array: MBA, MBAA, MACC, MACCA, data_analytics_cert, marketing_cert, nonprofit_cert
- `application_status` — inquiry / in_progress / submitted / complete / admitted / enrolled / declined / withdrawn
