"""Pushes scan results into the trade-management website's Supabase backend.

The website (../index.html + ../app.js) stores all of its data in one table,
`app_state(user_id, key, data jsonb)`, row-level-secured to `auth.uid() =
user_id`. Scan results are written under key `tm.scanner.v1` in that same
table, using the same project the site already talks to -- so a "Scanner"
tab on the site can just read it like it reads trades/positions/prefs.

Because of the RLS policy, a plain anon-key request can't write rows for a
user it hasn't authenticated as. So this module signs in with an email/
password (the same credentials you use to log into the site) to get a
user-scoped access token, then upserts through that.

Credentials are read from environment variables -- never hardcode them here:
  SCANNER_SUPABASE_EMAIL
  SCANNER_SUPABASE_PASSWORD

If either is unset, push_results() is a no-op (with a printed notice) so the
scanner still runs standalone without cloud delivery configured.
"""

import json
import os

import requests

# Same public project URL/anon key the website embeds in app.js. The anon key
# is meant to be public -- RLS on app_state is what actually protects data.
SUPABASE_URL = "https://aqqotvfzsvcmlaqyaakn.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxcW90dmZ6c3ZjbWxhcXlhYWtuIiwic"
    "m9sZSI6ImFub24iLCJpYXQiOjE3ODY4NDYxMDEsImV4cCI6MjEwMjQyMjEwMX0.Ic44bF9B4K1fGpfm8suCRs2p8gYgb9BFRDIGcfwJ-cg"
)
SCANNER_STATE_KEY = "scanner"


def _sign_in(email: str, password: str) -> tuple[str, str] | None:
    """Returns (access_token, user_id) or None on failure."""
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": password},
            timeout=15,
        )
    except requests.RequestException as e:
        print(f"Supabase sign-in failed: {e}")
        return None

    if resp.status_code != 200:
        print(f"Supabase sign-in failed: HTTP {resp.status_code} {resp.text[:200]}")
        return None

    body = resp.json()
    access_token = body.get("access_token")
    user_id = (body.get("user") or {}).get("id")
    if not access_token or not user_id:
        print("Supabase sign-in returned no access token / user id")
        return None
    return access_token, user_id


def push_results(payload: dict) -> bool:
    """Upserts `payload` under key tm.scanner.v1 for the credentialed user.

    Returns True on success, False (never raises) on any failure -- a failed
    cloud push should not fail the scan run itself.
    """
    email = os.environ.get("SCANNER_SUPABASE_EMAIL")
    password = os.environ.get("SCANNER_SUPABASE_PASSWORD")
    if not email or not password:
        print(
            "Skipping website delivery: set SCANNER_SUPABASE_EMAIL and "
            "SCANNER_SUPABASE_PASSWORD environment variables to enable it."
        )
        return False

    signed_in = _sign_in(email, password)
    if signed_in is None:
        return False
    access_token, user_id = signed_in

    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/app_state",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            data=json.dumps(
                {
                    "user_id": user_id,
                    "key": SCANNER_STATE_KEY,
                    "data": payload,
                }
            ),
            timeout=15,
        )
    except requests.RequestException as e:
        print(f"Supabase upsert failed: {e}")
        return False

    if resp.status_code not in (200, 201, 204):
        print(f"Supabase upsert failed: HTTP {resp.status_code} {resp.text[:200]}")
        return False

    print("Pushed scan results to the trade-management website.")
    return True
