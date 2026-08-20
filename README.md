# GROHE Blue Home for Homey

Developer integration for monitoring and controlling GROHE Blue Home from Homey Pro. The app discovers Blue Home appliances from the GROHE cloud, publishes filter and CO₂ measurements, and controls automatic flushing with API confirmation.

## Features

- GROHE account pairing through Homey's credential view
- Online state, filter/CO₂ percentages and remaining liters
- Last measurement, idle time, and still/carbonated cycle counters
- Low filter and CO₂ alarms
- Confirmed automatic-flushing control from the device and Flow
- Flow actions, condition, and edge-based state/low-level triggers
- Five-minute polling with retained measurements and three-failure availability handling

## Local development

Requirements:

- Node.js 22 or newer
- Homey CLI
- A Homey Pro running Homey 12.9.0 or newer for the separately authorized live phase

Install dependencies and run local checks:

```sh
npm install
npm test
npm run lint
homey app validate
```

Never pass a GROHE email, password, token, cookie, appliance identifier, or preshared key as a shell argument or environment assignment. Shell commands are retained in history and may be visible to other processes. Do not place credentials in `.env`, `env.json`, logs, screenshots, issue text, or repository files. Common local secret/log files are ignored as a last line of defense, not as a storage recommendation.

Live Homey selection, installation, and pairing must be performed only after confirming the intended hub with its owner. This repository's local verification does not select a hub or contact a real account/device.

## Pairing securely

1. In the Homey mobile or web interface, add a device and select GROHE Blue Home.
2. Enter the GROHE Watersystems account email and password only in Homey's pairing credential view.
3. Wait for the Blue Home device list, select the intended appliance, and add it.
4. Verify the device identity and measurements against the GROHE Watersystems app before changing automatic flushing.

The password is used only during pairing. The app persists the refresh token and account identifier in Homey's private app settings; it does not store the password or access token in device data/settings.

## Re-login

When token refresh fails, the app removes the stale stored account and reports that GROHE login is required. To authenticate again without putting credentials in a terminal:

1. Open Homey's add-device flow for GROHE Blue Home.
2. Enter credentials in the Homey pairing view and continue until the appliance list loads; successful login replaces the private account session.
3. If the appliance is already paired, cancel before adding a duplicate and refresh the existing device. If Homey does not recover it, remove/re-add only after reviewing dependent Flows and obtaining the owner's approval.

## Verification

The local/live evidence matrix is maintained in [docs/verification/2026-08-19-homey-pro.md](docs/verification/2026-08-19-homey-pro.md). PENDING live rows must not be marked PASS without direct, redacted evidence and restoration of the user's original automatic-flushing state.

## Security

- Errors exposed by cloud operations are sanitized.
- PUT requests are never automatically retried after ambiguous failure.
- Logs and bug reports must redact credentials, authorization/cookie headers, tokens, serials, appliance IDs, and preshared keys.
- Do not commit generated captures or Homey CLI logs.

This is a developer project and has not yet completed the live Homey Pro/device verification phase.
