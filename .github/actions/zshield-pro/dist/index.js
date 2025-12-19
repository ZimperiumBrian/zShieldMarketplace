const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const FormData = require('form-data');

/* =========================
 * Inputs
 * ========================= */
const clientEnv = core.getInput('client_env', { required: false });
const consoleUrl = core.getInput('console_url', { required: false });
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
 * Constants
 * ========================= */
const STATUS_POLL_TIME = pollIntervalSeconds * 1000;
const MAX_POLL_TIME = timeoutMinutes * 60 * 1000;
const MAX_FILES = 5;

let loginResponse;
let baseUrl = consoleUrl ? consoleUrl : `https://${clientEnv}.zimperium.com`;
if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

core.debug(`Base URL: ${baseUrl}`);

/* =========================
 * Auth (mirrors zScan)
 * ========================= */
async function loginHttpRequest() {
  let expired = true;

  if (loginResponse && loginResponse.accessToken) {
    try {
      const claims = JSON.parse(
        Buffer.from(loginResponse.accessToken.split('.')[1], 'base64').toString('utf8')
      );
      if (Date.now() < claims.exp * 1000) {
        expired = false;
        return loginResponse;
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
    throw new Error(
      `Pattern matched ${files.length} files, exceeds max ${MAX_FILES}. Narrow the pattern.`
    );
  }
  return files;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function resolveTeamId(teamName) {
  const teams = await getTeams();
  const match = teams.find(t => t.name === teamName);

  if (!match) {
    const names = teams.map(t => t.name).join(', ');
    throw new Error(`Team "${teamName}" not found. Available teams: ${names}`);
  }

  core.info(`Resolved team "${teamName}" -> ${match.id}`);
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

async function resolveGroupId(groupName, teamId) {
  const groups = await getGroups();
  const matches = groups.filter(g => g.name === groupName);

  if (matches.length === 0) {
    const names = groups.map(g => g.name).join(', ');
    throw new Error(`Group "${groupName}" not found. Visible groups: ${names}`);
  }

  const teamScoped = matches.filter(g => g.team && g.team.id === teamId);
  if (teamScoped.length === 1) {
    core.info(`Resolved team-scoped group "${groupName}" -> ${teamScoped[0].id}`);
    return teamScoped[0].id;
  }
  if (teamScoped.length > 1) {
    throw new Error(
      `Group "${groupName}" is ambiguous within team ${teamId}.`
    );
  }

  const global = matches.filter(g => !g.team);
  if (global.length === 1) {
    core.info(`Resolved global group "${groupName}" -> ${global[0].id}`);
    return global[0].id;
  }
  if (global.length > 1) {
    throw new Error(`Multiple global groups named "${groupName}" found.`);
  }

  throw new Error(
    `Group "${groupName}" exists but is not accessible for team ${teamId}.`
  );
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
  form.append(
    'appProtectionRequest',
    JSON.stringify(protectionRequest),
    { contentType: 'application/json' }
  );

  const resp = await axios.post(
    `${baseUrl}/api/zapp/public/v1/builds/protect`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${auth.accessToken}`
      }
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
    core.info(
      `${new Date().toISOString()} - state=${build.state} protectedUrl=${build.protectedUrl ? 'present' : 'null'}`
    );

    if (build.protectedUrl) {
      return build;
    }

    if (build.state === 'FAILED' || build.state === 'ERROR') {
      throw new Error(`zShield build failed: ${JSON.stringify(build)}`);
    }

    await sleep(STATUS_POLL_TIME);
  }

  throw new Error('Timed out waiting for protected artifact.');
}

/* =========================
 * Download protected file
 * ========================= */
async function downloadProtected(url, inputFile) {
  const auth = await loginHttpRequest();
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    responseType: 'arraybuffer'
  });

  const baseName = path.basename(inputFile, path.extname(inputFile));
  const outPath =
    outputFileInput || `${baseName}_zshield_protected.apk`;

  fs.writeFileSync(outPath, Buffer.from(resp.data));
  core.info(`Protected file downloaded: ${outPath}`);
  return outPath;
}

/* =========================
 * Main
 * ========================= */
(async () => {
  try {
    core.debug(`app pattern: ${appFilePattern}`);
    core.debug(`team: ${teamName}`);
    core.debug(`group: ${groupName}`);

    const files = await getMatchingFiles(appFilePattern);

    const teamId = await resolveTeamId(teamName);
    const groupId = await resolveGroupId(groupName, teamId);

    for (const file of files) {
      core.info(`Submitting protection job for ${file}`);

      const protectionRequest = buildProtectionRequest(teamId, groupId);
      const submitResp = await submitProtect(file, protectionRequest);

      const buildId = submitResp.buildId;
      if (!buildId) {
        throw new Error(`Protect response missing buildId: ${JSON.stringify(submitResp)}`);
      }

      core.setOutput('build_id', buildId);

      const completed = await pollUntilProtected(buildId);
      const protectedPath = await downloadProtected(completed.protectedUrl, file);

      core.setOutput('protected_file', protectedPath);
    }

    core.info('zShield Pro Action Finished');
  } catch (err) {
    core.setFailed(err.message);
  }
})();
