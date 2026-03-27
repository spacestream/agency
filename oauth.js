import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TOKEN_FILE = resolve(".agency", "tokens.json");

// Module-level token state
let _accessToken = null;
let _accountId = null;
let _refreshTokenValue = null;

export function getAccessToken() { return _accessToken; }
export function getAccountId() { return _accountId; }
export function isAuthenticated() { return _accessToken !== null; }

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function extractAccountId(accessToken) {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No chatgpt_account_id in token");
    return accountId;
  } catch (err) {
    throw new Error(`Failed to extract accountId from token: ${err.message}`);
  }
}

// --- Token persistence ---

async function saveTokens() {
  try {
    await mkdir(dirname(TOKEN_FILE), { recursive: true });
    await writeFile(TOKEN_FILE, JSON.stringify({
      access_token: _accessToken,
      refresh_token: _refreshTokenValue,
    }), "utf8");
  } catch (err) {
    console.error("Failed to save tokens:", err.message);
  }
}

async function loadTokens() {
  try {
    const data = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
    if (!data.refresh_token) return false;

    _refreshTokenValue = data.refresh_token;
    const refreshed = await refreshAccessToken();
    _accessToken = refreshed.access_token;
    _refreshTokenValue = refreshed.refresh_token;
    _accountId = extractAccountId(_accessToken);
    await saveTokens();

    if (refreshed.expires_in) scheduleRefresh(refreshed.expires_in);

    console.log("Restored OAuth session from saved tokens.");
    return true;
  } catch {
    return false;
  }
}

// --- Token refresh ---

function scheduleRefresh(expiresIn) {
  const ms = Math.max((expiresIn - 60) * 1000, 10_000);
  setTimeout(async () => {
    try {
      const refreshed = await refreshAccessToken();
      _accessToken = refreshed.access_token;
      _refreshTokenValue = refreshed.refresh_token;
      _accountId = extractAccountId(_accessToken);
      await saveTokens();
      console.log("OpenAI OAuth token refreshed.");
      if (refreshed.expires_in) scheduleRefresh(refreshed.expires_in);
    } catch (err) {
      console.error("Failed to refresh OpenAI token:", err.message);
    }
  }, ms);
}

async function refreshAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: _refreshTokenValue,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  return res.json();
}

// --- Public API ---

/**
 * Try to restore a previous session from saved tokens.
 */
export async function tryRestoreSession() {
  return loadTokens();
}

/**
 * Build the OpenAI authorize URL and start a temporary callback server
 * on port 1455 (the registered redirect URI for the Codex CLI client).
 * Returns the authorize URL. When the callback is received, tokens are
 * exchanged and the user is redirected to the main app.
 */
export function startAuthFlow(agencyPort) {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    codex_cli_simplified_flow: "true",
    id_token_add_organizations: "true",
    originator: "agency",
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;

  // Start temporary callback server on port 1455
  const callbackServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:1455");
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (!code || returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid callback");
      callbackServer.close();
      return;
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
      }

      const tokens = await tokenRes.json();
      _accessToken = tokens.access_token;
      _refreshTokenValue = tokens.refresh_token;
      _accountId = extractAccountId(_accessToken);
      await saveTokens();

      if (tokens.expires_in) scheduleRefresh(tokens.expires_in);

      console.log("OpenAI OAuth authentication successful.");
      res.writeHead(302, { Location: `http://localhost:${agencyPort}` });
      res.end(() => callbackServer.close());
    } catch (err) {
      console.error("OAuth callback error:", err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Authentication failed: ${err.message}`, () => callbackServer.close());
    }
  });

  callbackServer.on("error", (err) => {
    console.error(`Failed to start callback server on port 1455: ${err.message}`);
  });

  callbackServer.listen(1455, "127.0.0.1");

  // Auto-close after 3 minutes
  setTimeout(() => {
    callbackServer.close();
  }, 180_000);

  return authUrl;
}
