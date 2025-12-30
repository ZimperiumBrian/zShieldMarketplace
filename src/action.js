const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const FormData = require('form-data');

/* =========================
 * Inputs
 * ========================= */
const consoleUrl = core.getInput('console_url', { required: true });
const clientId = core.getInput('client_id', { required: true });
const clientSecret = core.getInput('client_secret', { required: true });
const appFilePattern = core.getInput('app_file', { required: true });

const teamName = core.getInput('team_name', { required: true });
const groupName = core.getInput('group_name', { required: true });

const protectionJsonInline = core.getInput('app_protection_request', { required: false });
const protectionJsonFile = core.getInput('app_protection_request_file', { required: false });

const timeoutMinutes = parseInt(core.getInput('timeout_minutes') || '60', 10);
const pollIntervalSeconds = parseInt(core.getInput('poll_interval_seconds') || '15', 10);
const outputFileInput = core.getInput('output_file', { required: false });

/* =========================
 * Base URL normalization
 * ========================= */
let baseUrl = consoleUrl;

if (!/^https?:\/\//i.test(baseUrl)) {
  throw new Error(`console_url must include scheme (https://...). Got: ${baseUrl}`);
}

if (baseUrl.endsWith('/')) {
  baseUrl = baseUrl.slice(0, -1);
}

core.debug(`Base URL: ${baseUrl}`);

/* =========================
 * Constants
 * ========================= */
const STATUS_POLL_TIME = pollIntervalSeconds * 1000;
const MAX_POLL_TIME = timeoutMinutes * 60 * 1000;
const MAX_FILES = 5; // enforced by getMatchingFiles()

let loginResponse;

/* =========================
 * Helpers
 * ========================= */
function base64UrlDecodeToJson(b64url) {
  // JWT payload is base64url; normalize to base64
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(b64url.length / 4) * 4, '=');

  const jsonStr = Buffer.from(normalized, 'base64').toString('utf8');
  return JSON.parse(jsonStr);
}

function ensureAbsoluteWorkspacePath(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const ws = process.env.GITHUB_WORKSPACE || process.cwd();
  return path.join(ws, p);
}

function formatAxiosError(err) {
  if (!err) return 'Unknown error';
  if (err.response) {
    const status = err.response.status;
    const statusText = err.response.statusText || '';
    let body = err.response.data;

    // Try to make response readable (avoid dumping raw buffers)
    if (Buffer.isBuffer(body)) {
      body = body.toString('utf8');
    }
    if (typeof body === 'object') {
      try { body = JSON.stringify(body); } catch (_) {}
    }

    return `HTTP ${status} ${statusText} - ${body}`;
  }
  return err.message ? err.message : String(err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
 * Auth (mirrors zScan)
 * ========================= */
async function loginHttpRequest() {
  core.setSecret(clientSecret); // mask secret in logs

  let expired = true;

  if (loginResponse && loginResponse.accessToken) {
    try {
      const parts = loginResponse.accessToken.split('.');
      if (parts.length >= 2) {
        const claims = base64UrlDecodeToJson(parts[1]);
        if (Date.now() < claims.exp * 1000) {
          expired = false;
          return loginResponse;
        }
      }
    } catch (_) {
      expired = true;
    }
  }

  if (expired) {
    const url = `${baseUrl}/api/auth/v1/api_keys/login`;
    core.debug(`Authenticating with ${url}`);

    const resp = await axios.post(
      url,
      { clientId, secret: clientSecret },
      { headers: { 'Content-Type': 'application/json' } }
    );

    loginResponse = resp.data;
    if (!loginResponse || !loginResponse.accessToken) {
      throw new Error(`Login response missing accessToken: ${JSON.stringify(resp.data)}`);
    }

    core.setSecret(loginResponse.accessToken);
    core.info('Authentication successful');
    return loginResponse;
  }
}

/* =========================
 * Utilities
 * ========================= */
async function getMatchingFiles(pattern) {
  const files = await glob.glob(pattern);

  if (files.length === 0) {
    throw new Error(`No files found matching pattern: ${pattern}`);
  }
  if (files.length > MAX_FILES) {
    throw new Error(`Pattern matched ${files.length} files, exceeds max ${MAX_FILES}. Narrow the pattern.`);
  }

  return files;
}

/* =========================
 * Team lookup (zScan-style)
 * ========================= */
async function getTeams() {
  const auth = await loginHttpRequest();
  const resp = await axios.get(
    `${baseUrl}/api/auth/public/v1/teams`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  );
  return resp.data.content;
}

async function resolveTeamId(teamNameArg) {
  const teams = await getTeams();
  const match = teams.find(t => t.name === teamNameArg);

  if (!match) {
    const names = teams.map(t => t.name).join(', ');
    throw new Error(`Team "${teamNameArg}" not found. Available teams: ${names}`);
  }

  core.info(`Resolved team "${teamNameArg}" -> ${match.id}`);
  return match.id;
}

/* =========================
 * Group lookup (team-scoped > global)
 * ========================= */
async function getGroups() {
  const auth = await loginHttpRequest();
  const resp = await axios.get(
    `${baseUrl}/api/mtd-policy/public/v1/groups`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  );
  return resp.data;
}

async function resolveGroupId(groupNameArg, teamId) {
  const groups = await getGroups();
  const matches = groups.filter(g => g.name === groupNameArg);

  if (matches.length === 0) {
    const names = groups.map(g => g.name).join(', ');
    throw new Error(`Group "${groupNameArg}" not found. Visible groups: ${names}`);
  }

  const teamScoped = matches.filter(g => g.team && g.team.id === teamId);
  if (teamScoped.length === 1) {
    core.info(`Resolved team-scoped group "${groupNameArg}" -> ${teamScoped[0].id}`);
    return teamScoped[0].id;
  }
  if (teamScoped.length > 1) {
    throw new Error(`Group "${groupNameArg}" is ambiguous within team ${teamId}.`);
  }

  const global = matches.filter(g => !g.team);
  if (global.length === 1) {
    core.info(`Resolved global group "${groupNameArg}" -> ${global[0].id}`);
    return global[0].id;
  }
  if (global.length > 1) {
    throw new Error(`Multiple global groups named "${groupNameArg}" found.`);
  }

  throw new Error(`Group "${groupNameArg}" exists but is not accessible for team ${teamId}.`);
}

/* =========================
 * Protection request builder
 * ========================= */
function buildProtectionRequest(teamId, groupId) {
  let req;

  if (protectionJsonFile) {
    req = JSON.parse(fs.readFileSync(protectionJsonFile, 'utf8'));
  } else if (protectionJsonInline) {
    req = JSON.parse(protectionJsonInline);
  } else {
    req = {
      description: 'CI zShield Pro protection',
      signatureVerification: false,
      staticDexEncryption: true,
      resourceEncryption: true,
      metadataEncryption: true,
      codeObfuscation: false,
      runtimeProtection: true,
      autoScanBuild: true
    };
  }

  req.teamId = teamId;
  req.groupId = groupId;
  return req;
}

/* =========================
 * Submit protect job
 * ========================= */
async function submitProtect(filePath, protectionRequest) {
  const auth = await loginHttpRequest();

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('appProtectionRequest', JSON.stringify(protectionRequest), { contentType: 'application/json' });

  const resp = await axios.post(
    `${baseUrl}/api/zapp/public/v1/builds/protect`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${auth.accessToken}`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return resp.data;
}

/* =========================
 * Poll build
 * ========================= */
async function getBuild(buildId) {
  const auth = await loginHttpRequest();
  const resp = await axios.get(
    `${baseUrl}/api/zapp/public/v1/builds/${buildId}`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  );
  return resp.data;
}

async function pollUntilProtected(buildId) {
  const start = Date.now();

  while (Date.now() - start < MAX_POLL_TIME) {
    const build = await getBuild(buildId);

    core.info(`${new Date().toISOString()} - state=${build.state} protectedUrl=${build.protectedUrl ? 'present' : 'null'}`);

    if (build.protectedUrl) {
      return build;
    }

    if (build.state === 'FAILED' || build.state === 'ERROR') {
      throw new Error(`zShield build failed: ${JSON.stringify(build)}`);
    }

    await sleep(STATUS_POLL_TIME);
  }

  throw new Error(`Timed out waiting for protected artifact after ${timeoutMinutes} minutes.`);
}

/* =========================
 * Download protected file
 * ========================= */
async function getProtectedLink(buildId) {
  const auth = await loginHttpRequest();
  const url = `${baseUrl}/api/zapp/public/v1/builds/${buildId}/protected`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json'
    }
  });

  // Expect { name, url }
  if (!resp.data || !resp.data.url) {
    throw new Error(`Unexpected /protected response: ${JSON.stringify(resp.data)}`);
  }

  return resp.data; // { name, url }
}

async function downloadFromSignedUrl(signedUrl, inputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const outPath = outputFileInput || `${baseName}_zshield_protected.apk`;

  const resp = await axios.get(signedUrl, {
    responseType: 'arraybuffer',
    maxRedirects: 5,     // curl -L behavior
    proxy: false,        // avoid GH runner proxy weirdness
    headers: {
      Accept: 'application/octet-stream'
    },
    validateStatus: () => true
  });

  const ct = String(resp.headers?.['content-type'] || '');

  if (resp.status < 200 || resp.status >= 300) {
    const head = Buffer.from(resp.data || []).slice(0, 500).toString('utf8');
    throw new Error(`Signed URL download failed HTTP ${resp.status} content-type="${ct}". First bytes:\n${head}`);
  }

  if (ct.includes('text/html')) {
    const head = Buffer.from(resp.data || []).slice(0, 1000).toString('utf8');
    throw new Error(`Signed URL returned HTML (not APK). First bytes:\n${head}`);
  }

  const data = Buffer.from(resp.data);

  // APK is a ZIP, should start with "PK"
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4B) {
    const head = data.slice(0, 500).toString('utf8');
    throw new Error(`Downloaded file is not APK/ZIP. content-type="${ct}" size=${data.length}. First bytes:\n${head}`);
  }

  fs.writeFileSync(outPath, data);
  core.info(`Protected APK downloaded OK: ${outPath} (${data.length} bytes)`);
  return outPath;
}

/* =========================
 * Main
 * ========================= */
async function run() {
  core.debug(`app pattern: ${appFilePattern}`);
  core.debug(`team: ${teamName}`);
  core.debug(`group: ${groupName}`);

  const files = await getMatchingFiles(appFilePattern);

  // Recommended: enforce exactly one artifact for Pro
  if (files.length !== 1) {
    throw new Error(`app_file must resolve to exactly 1 file for zShield Pro. Matched: ${files.join(', ')}`);
  }

  const file = files[0];

  const teamId = await resolveTeamId(teamName);
  const groupId = await resolveGroupId(groupName, teamId);

  core.info(`Submitting protection job for ${file}`);

  const protectionRequest = buildProtectionRequest(teamId, groupId);
  const submitResp = await submitProtect(file, protectionRequest);

  const buildId = submitResp.buildId;
  if (!buildId) {
    throw new Error(`Protect response missing buildId: ${JSON.stringify(submitResp)}`);
  }

  core.setOutput('build_id', String(buildId));

  await pollUntilProtected(buildId);

  // Per API docs: must fetch signed download URL explicitly
  const link = await getProtectedLink(buildId);

  // Download the actual APK from the signed URL
  const protectedPath = await downloadFromSignedUrl(link.url, file);

  core.setOutput('protected_file', protectedPath);

  core.info('zShield Pro Action Finished');
}

run().catch((err) => {
  core.setFailed(formatAxiosError(err));
});
