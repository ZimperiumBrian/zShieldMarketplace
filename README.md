# Zimperium zShield Pro GitHub Action

## Mobile Application Protection and Hardening

The **Zimperium zShield Pro GitHub Action** protects your mobile application binary (Android APK/AAB or iOS IPA) using **zShield Pro**.  
It applies advanced security hardening techniques—such as encryption and runtime protections—and downloads the **protected build** for further use in your CI/CD pipeline.

---

## Features

* Protect Android and iOS mobile app binaries using zShield Pro
* Apply encryption and runtime protection policies automatically
* Resolve **team** and **policy group** by name (no UUIDs required)
* Support for **team-scoped and global policy groups**
* Download the protected application artifact for:
  * Re-signing
  * Distribution
  * Additional scanning (e.g., zScan)
* Designed for CI/CD automation
* Mirrors the behavior and usability of the zScan Marketplace action

---

## Example Workflow

### Console URL

You must provide the full base URL of your Zimperium tenant using `console_url`.

Examples:

* `https://zc202.zimperium.com`
* `https://ziap.zimperium.com`
* `https://mtd.example.com`

Do **not** include a trailing slash.

```yaml
- name: Protect App with zShield Pro
  uses: zimperium/zshield-pro-action@v0.1.0
  timeout-minutes: 60
  with:
    console_url: https://ziap.zimperium.com
    client_id: ${{ vars.Z_CLIENT_ID }}
    client_secret: ${{ secrets.Z_CLIENT_SECRET }}
    app_file: ./app-release.apk
    team_name: Apps
    group_name: Default Group
```

The protected app is downloaded to the GitHub Actions workspace and exposed as an output.

---

## Outputs

| Output           | Description                                  |
| ---------------- | -------------------------------------------- |
| `build_id`       | zShield Pro build identifier                 |
| `protected_file` | Path to the downloaded protected application |

You can upload the protected artifact using `actions/upload-artifact`:

```yaml
- name: Upload protected app
  uses: actions/upload-artifact@v4
  with:
    name: protected-app
    path: ${{ steps.zshield.outputs.protected_file }}
```

---

## GitHub Prerequisites

* This action must run on an **ubuntu-latest** GitHub Actions runner
* No GitHub Advanced Security (GHAS) license is required
* For Android:
  * The protected APK **must be re-signed** before installation or distribution

---

## Get Started

### Step 1 – Get API Keys

1. Log in to the zConsole.
2. Click the **Account Management** gear icon.
3. Select **Authorizations**.
4. Click **Generate API Key**.
5. Enter a description.
6. Grant required permissions for zShield Pro.
7. Save and copy:
   * **Client ID**
   * **Client Secret**

---

### Step 2 – Add Secrets and Variables to GitHub

1. In your GitHub repository, go to **Settings**.
2. Navigate to **Secrets and Variables → Actions**.
3. Add:
   * `Z_CLIENT_ID` (repository variable)
   * `Z_CLIENT_SECRET` (repository secret)

For more details, see the  
[GitHub Secrets documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets).

---

### Step 3 – Add zShield Pro to a Workflow

1. Create or edit a workflow in `.github/workflows/`.
2. Add the zShield Pro action step.
3. Point `app_file` to your built mobile application.
4. Commit and run the workflow.

---

## Protection Policy Configuration

### Default Behavior

If no protection policy is provided, the action applies a **default CI-safe policy**, equivalent to:

```json
{
  "description": "CI zShield Pro protection",
  "signatureVerification": false,
  "staticDexEncryption": true,
  "resourceEncryption": true,
  "metadataEncryption": true,
  "codeObfuscation": false,
  "runtimeProtection": true,
  "autoScanBuild": true
}
```

This default is suitable for most CI and demo workflows.

---

### Inline Policy Override (Recommended for Demos)

You may override the default policy inline using `app_protection_request`:

```yaml
- name: Protect with zShield Pro
  uses: zimperium/zshield-pro-action@v0.1.0
  with:
    console_url: https://zc202.zimperium.com
    client_id: ${{ vars.Z_CLIENT_ID }}
    client_secret: ${{ secrets.Z_CLIENT_SECRET }}
    app_file: app-release.apk
    team_name: Apps
    group_name: Default Group
    app_protection_request: |
      {
        "description": "Demo CI policy",
        "runtimeProtection": true,
        "autoScanBuild": true
      }
```

Inline JSON is ideal for demos and quick experimentation.

---

### File-Based Policy Override (Recommended for Production)

For larger or platform-specific policies, use a file:

```yaml
- name: Protect with zShield Pro
  uses: zimperium/zshield-pro-action@v0.1.0
  with:
    console_url: https://zc202.zimperium.com
    client_id: ${{ vars.Z_CLIENT_ID }}
    client_secret: ${{ secrets.Z_CLIENT_SECRET }}
    app_file: app-release.apk
    team_name: Apps
    group_name: Default Group
    app_protection_request_file: .github/zshield-policy.json
```

This approach is recommended for production pipelines and complex configurations.

---

### Policy Precedence

Protection policies are applied using the following order:

1. `app_protection_request` (inline JSON)
2. `app_protection_request_file`
3. Built-in default policy

---

## Policy Group Resolution Behavior

Policy groups are resolved deterministically:

1. A **team-scoped group** matching `group_name` is selected first.
2. Otherwise, a **global group** with the same name is selected.
3. If multiple matches exist, the action fails with a clear error.
4. If no match is found, the action fails.

This ensures safe and predictable policy application.

---

## Adding zShield Pro to an Existing Workflow

You can add this action to any existing build pipeline after your mobile app is built:

```yaml
- name: Build Android App
  run: ./gradlew assembleRelease

- name: Protect with zShield Pro
  uses: zimperium/zshield-pro-action@v0.1.0
  with:
    console_url: https://zc202.zimperium.com
    client_id: ${{ vars.Z_CLIENT_ID }}
    client_secret: ${{ secrets.Z_CLIENT_SECRET }}
    app_file: app/build/outputs/apk/release/app-release.apk
    team_name: Apps
    group_name: Default Group
```

---

## If You Run Into Issues

Please file issues in the repository where this action is hosted. Include:

* The workflow snippet
* The error message
* The expected behavior

Suggestions and enhancements are welcome.

---

## License

This action is licensed under the **MIT License**, consistent with other Zimperium Marketplace actions.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
...
```

---

## Enhancements

Improvements and pull requests are welcome.  
This action is intentionally designed to evolve alongside the zShield Pro API.
