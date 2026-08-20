# GROHE Blue Home for Homey

Developer integration for monitoring and controlling GROHE Blue Home from Homey Pro. The app discovers Blue Home appliances through the GROHE cloud, publishes filter and CO₂ measurements, and controls automatic flushing with API confirmation.

## Features

- GROHE Watersystems account pairing through Homey's credential view
- Online state, filter/CO₂ percentages, and remaining liters
- Localized measurement time, idle time, and still/carbonated cycle counters
- Low filter and CO₂ alarms
- Confirmed automatic-flushing control from the device and Flow
- Flow actions, condition, and edge-based state/low-level triggers
- Five-minute polling with retained measurements and three-failure availability handling

## Verified hardware status

The developer app has been installed and run on an owner-confirmed Homey Pro. A real account paired successfully, a type-104 Blue Home appliance was discovered, and Homey displayed online state, filter/CO₂ percentages and liters, localized timestamp, idle time, and counters. Enable and disable were exercised against the backend and confirmed in Homey; the final state after the owner's last Enable is enabled.

The GROHE Watersystems UI may cache automatic-flushing state until logout/login. Homey therefore confirms writes from subsequent API reads, not from immediate Watersystems UI rendering. Real low-level threshold crossings, controlled outage behavior, and expired-session re-login remain pending; those paths are covered by automated tests only.

## Local development

Requirements:

- Node.js 22 or newer
- Homey CLI
- Homey Pro 12.9.0 or newer for live verification

```sh
npm install
npm test
npm run lint
npm run validate
```

`npm run lint` syntax-checks every tracked or newly added project JavaScript file while excluding dependency and generated Homey build trees.

Never pass a GROHE email, password, token, cookie, appliance identifier, or preshared key as a shell argument or environment assignment. Do not place credentials in `.env`, `env.json`, logs, screenshots, issues, or repository files.

## Pairing and re-login

1. Add a device in Homey and select GROHE Blue Home.
2. Enter the Watersystems account email and password only in Homey's pairing credential view.
3. Select the intended discovered appliance.
4. Verify monitoring values before changing automatic flushing.

The password is used only during pairing. Homey private app settings retain only the refresh token and account identifier. If token refresh fails, repeat the add-device login flow to replace the private session; cancel before adding a duplicate if the appliance is already paired.

## Automatic-flushing semantics

- Enable sends one PUT with `auto_flush_active: true` and `flush_confirmed: true`.
- Disable sends one PUT with `auto_flush_active: false` and leaves confirmation untouched.
- If the API explicitly requires confirmation, enabled is effective only when both active and confirmed are true.
- Ambiguous PUT failures are never retried automatically.

## Verification and security

The evidence matrix is maintained in [docs/verification/2026-08-19-homey-pro.md](docs/verification/2026-08-19-homey-pro.md).

- Cloud-operation errors are sanitized.
- Logs and reports must redact credentials, authorization/cookie headers, tokens, serials, appliance IDs, and preshared keys.
- Do not commit captures, generated Homey builds, or Homey CLI logs.

Licensed under the MIT License. See [LICENSE](LICENSE).
