#!/usr/bin/env python3
"""
Generate X OAuth2 user token (Authorization Code + PKCE).

Run:
  python3 skills/x/scripts/get_x_oauth2_user_token.py

Required env:
  X_CLIENT_ID

Optional env:
  X_CLIENT_SECRET
  X_OAUTH2_REDIRECT_URI   (default: http://127.0.0.1:8080/callback)
  X_OAUTH2_SCOPES         (default: tweet.read tweet.write users.read offline.access)
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from dotenv import load_dotenv


AUTH_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.x.com/2/oauth2/token"


def _b64url_no_pad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _make_code_verifier() -> str:
    return _b64url_no_pad(os.urandom(32))


def _make_code_challenge(verifier: str) -> str:
    return _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())


def _build_authorize_url(
    *,
    client_id: str,
    redirect_uri: str,
    scope: str,
    state: str,
    code_challenge: str,
) -> str:
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{AUTH_URL}?{urlencode(query)}"


def _extract_code_and_state(input_text: str) -> tuple[str, str | None]:
    text = input_text.strip()
    if "://" not in text and "code=" not in text:
        return text, None
    parsed = urlparse(text)
    query = parse_qs(parsed.query)
    code = query.get("code", [None])[0]
    state = query.get("state", [None])[0]
    if not code:
        raise ValueError("No `code` found in callback URL.")
    return code, state


def main() -> int:
    load_dotenv()
    client_id = os.getenv("X_CLIENT_ID")
    client_secret = os.getenv("X_CLIENT_SECRET")
    redirect_uri = os.getenv("X_OAUTH2_REDIRECT_URI", "http://127.0.0.1:8080/callback")
    scope = os.getenv("X_OAUTH2_SCOPES", "tweet.read tweet.write users.read offline.access")

    if not client_id:
        print("ERROR: Missing X_CLIENT_ID in environment.")
        return 1

    state = secrets.token_urlsafe(24)
    verifier = _make_code_verifier()
    challenge = _make_code_challenge(verifier)
    auth_url = _build_authorize_url(
        client_id=client_id,
        redirect_uri=redirect_uri,
        scope=scope,
        state=state,
        code_challenge=challenge,
    )

    print("\nOpen this URL in your browser and authorize:\n")
    print(auth_url)
    print("\nPaste the callback URL (or just the `code` value):")
    user_input = input("> ")

    try:
        code, returned_state = _extract_code_and_state(user_input)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 1

    if returned_state and returned_state != state:
        print("ERROR: State mismatch. Aborting.")
        return 1

    data: dict[str, str] = {
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    # Confidential clients use Basic auth; public clients send client_id in body.
    auth = None
    if client_secret:
        auth = (client_id, client_secret)
    else:
        data["client_id"] = client_id

    response = requests.post(TOKEN_URL, headers=headers, data=data, auth=auth, timeout=30)
    payload = (
        response.json()
        if response.headers.get("content-type", "").startswith("application/json")
        else {"raw": response.text}
    )

    if response.status_code >= 400:
        print(f"ERROR: Token exchange failed ({response.status_code})")
        print(payload)
        return 1

    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    expires_in = payload.get("expires_in")
    token_type = payload.get("token_type")
    granted_scope = payload.get("scope")

    print("\nSuccess. Add/update these in your .env:\n")
    if access_token:
        print(f"X_OAUTH2_USER_TOKEN={access_token}")
    if refresh_token:
        print(f"X_OAUTH2_REFRESH_TOKEN={refresh_token}")
    print(f"X_OAUTH2_REDIRECT_URI={redirect_uri}")
    print(f"X_OAUTH2_SCOPES={scope}")
    print("\nToken metadata:")
    print(f"  token_type  = {token_type}")
    print(f"  expires_in  = {expires_in}s")
    print(f"  scope       = {granted_scope}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
