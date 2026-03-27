import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

// Module-level token state
let _accessToken = null;
let _accountId = null;
let _refreshTokenValue = null;

export function getAccessToken() { return _accessToken; }
export function getAccountId() { return _accountId; }

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

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("Could not open browser automatically.");
  });
}

async function exchangeCode(code, verifier) {
  const res = await fetch(TOKEN_URL, {
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
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

function waitForCallback(state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:1455");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing code");
        return;
      }
      const agencyPort = process.env.PORT || 3000;
      res.writeHead(302, { Location: `http://localhost:${agencyPort}` });
      res.end();
      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start OAuth callback server on port 1455: ${err.message}`));
    });

    server.listen(1455, "127.0.0.1");

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out (3 minutes)"));
    }, 180_000);
  });
}

function scheduleRefresh(expiresIn) {
  const ms = Math.max((expiresIn - 60) * 1000, 10_000);
  setTimeout(async () => {
    try {
      const refreshed = await refreshAccessToken();
      _accessToken = refreshed.access_token;
      _refreshTokenValue = refreshed.refresh_token;
      _accountId = extractAccountId(_accessToken);
      console.log("OpenAI OAuth token refreshed.");
      if (refreshed.expires_in) scheduleRefresh(refreshed.expires_in);
    } catch (err) {
      console.error("Failed to refresh OpenAI token:", err.message);
    }
  }, ms);
}

/**
 * Run the OpenAI OAuth Authorization Code + PKCE flow.
 * Opens a browser for ChatGPT login, exchanges the code for tokens.
 * Token is available via getAccessToken() / getAccountId().
 */
export async function runOAuthFlow() {
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

  console.log("Opening browser for OpenAI authentication...");
  console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await waitForCallback(state);
  console.log("Authorization code received, exchanging for tokens...");

  const tokens = await exchangeCode(code, verifier);
  _accessToken = tokens.access_token;
  _refreshTokenValue = tokens.refresh_token;
  _accountId = extractAccountId(_accessToken);

  if (tokens.expires_in) {
    scheduleRefresh(tokens.expires_in);
  }
}
