# Homey GROHE Blue MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a Homey Pro SDK v3 developer app for GROHE Blue Home with account pairing, monitoring, alarms, Flow cards, and verified automatic-flushing control.

**Architecture:** A native Node.js client performs the GROHE OIDC form flow and REST calls. A pure mapper converts `/dashboard` payloads into a stable domain model; the Homey driver/device layer owns pairing, polling, capabilities, availability, and Flow integration.

**Tech Stack:** Node.js 22, CommonJS, Homey Apps SDK v3, Homey Compose, built-in `fetch`, `node:test`, Homey CLI 4.x.

**Spec:** `docs/superpowers/specs/2026-08-19-homey-grohe-blue-design.md`

**Shipped/live ruling (2026-08-20):** The implementation uses the custom capability IDs listed in Task 4. Enable sends one PUT with `auto_flush_active: true` and `flush_confirmed: true`; disable sends one PUT with only `auto_flush_active: false`. Effective enabled state requires confirmation only when `flush_confirmation_required` is explicitly true. No PUT retry is allowed. Watersystems may cache the UI state until logout/login, so Homey confirms from backend reads.

## Global Constraints

- Target Homey Pro using SDK v3 and Node.js 22.
- Communicate directly with `https://idp2-apigw.cloud.grohe.com/v3/iot`; no Home Assistant or intermediary service.
- Never persist the GROHE password and never log credentials, cookies, tokens, serial numbers, appliance IDs, or `presharedkey`.
- Use `appliance_id` only as immutable Homey `data.id`; mutable routing IDs belong in device store.
- Poll every 300 seconds; confirm writes with at most five reads spaced two seconds apart.
- Do not implement water dispensing, maintenance resets, 24-hour reminder writes, or App Store publication.

---

### Task 1: Project foundation and secret-safe logger

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `lib/redact.js`
- Create: `test/redact.test.js`

**Interfaces:**
- Produces: `redact(value): unknown` and `safeError(error): Error`.

- [ ] **Step 1: Write failing redaction tests** covering nested Authorization headers, cookies, access/refresh tokens, email, password, serial, appliance ID and `presharedkey`; assert ordinary measurements remain unchanged.
- [ ] **Step 2: Run `node --test test/redact.test.js`** and verify failure because `lib/redact.js` does not exist.
- [ ] **Step 3: Implement recursive redaction** using a deny-list of case-insensitive key fragments and make `safeError` retain only name, HTTP status and a generic message.
- [ ] **Step 4: Create package metadata** with scripts `test: node --test`, `lint: node --check ...`, `validate: homey app validate` and dependency `homey` compatible with SDK v3.
- [ ] **Step 5: Run `npm test`** and verify all redaction tests pass.
- [ ] **Step 6: Commit** with `git commit -m "chore: initialize GROHE Blue app"`.

### Task 2: GROHE cloud client

**Files:**
- Create: `lib/grohe-client.js`
- Create: `test/grohe-client.test.js`
- Create: `test/fixtures/login.html`
- Create: `test/fixtures/dashboard.json`

**Interfaces:**
- Produces class `GroheClient({ fetch, now, tokens })`.
- Produces methods `login(email, password)`, `setTokens(tokens)`, `getTokens()`, `refreshTokens()`, `getDashboard()`, `setAutoFlush(route, enabled)`.
- `route` is `{ locationId, roomId, applianceId }`.

- [ ] **Step 1: Write failing OIDC tests** for login form discovery, cookie forwarding, `ondus://` token exchange, invalid credentials, and redacted errors.
- [ ] **Step 2: Run `node --test test/grohe-client.test.js`** and confirm failure because the client is missing.
- [ ] **Step 3: Implement the minimal OIDC flow** with manual redirects and an in-memory cookie jar; clear the jar and password references after login.
- [ ] **Step 4: Add failing refresh tests** asserting refresh happens 60 seconds before expiry and one 401 refreshes once before retrying a safe GET.
- [ ] **Step 5: Implement refresh and authenticated GET** while serializing concurrent refreshes through one shared promise.
- [x] **Step 6: Add API tests** for `/dashboard` and exact asymmetric PUT bodies: enable `{config:{auto_flush_active:true,flush_confirmed:true}}`; disable `{config:{auto_flush_active:false}}`.
- [x] **Step 7: Implement dashboard and auto-flush methods** with one PUT only; do not retry after ambiguous network failure.
- [ ] **Step 8: Run `npm test`** and commit with `git commit -m "feat: add GROHE cloud client"`.

### Task 3: Blue Home discovery and state mapper

**Files:**
- Create: `lib/grohe-mapper.js`
- Create: `test/grohe-mapper.test.js`
- Modify: `test/fixtures/dashboard.json`

**Interfaces:**
- Produces `findBlueHomeDevices(dashboard): BlueHomeDescriptor[]`.
- Produces `mapBlueHome(appliance): BlueHomeState`.
- Descriptor fields: `id`, `name`, `route`, `model`, `firmware`.
- State fields: `online`, `autoFlush`, `filterPercent`, `filterLiters`, `co2Percent`, `co2Liters`, `measurementTimestamp`, `idleMinutes`, `stillCycles`, `carbonatedCycles`, `filterLow`, `co2Low`.
- Live ruling: status arrays accept connection values `1`, `true`, or `connected`; `autoFlush` requires `flush_confirmed` only when confirmation is explicitly required.

- [ ] **Step 1: Write failing discovery tests** proving only `type: 104` devices are returned and routing IDs are preserved separately from immutable ID.
- [ ] **Step 2: Run the mapper test** and verify failure.
- [ ] **Step 3: Implement discovery** without depending on device display names.
- [ ] **Step 4: Write failing mapping tests** for the captured Blue Home payload, missing `data_latest`, offline state, zero values and low-level thresholds (`<=10`).
- [ ] **Step 5: Implement null-safe mapping**; never convert missing values to zero.
- [ ] **Step 6: Run `npm test`** and commit with `git commit -m "feat: map GROHE Blue devices"`.

### Task 4: Homey manifest, capabilities and pairing

**Files:**
- Create: `.homeycompose/app.json`
- Create: `.homeycompose/capabilities/grohe_auto_flush.json`
- Create: `.homeycompose/capabilities/grohe_online.json`
- Create: `.homeycompose/capabilities/grohe_filter_percent.json`
- Create: `.homeycompose/capabilities/grohe_co2_percent.json`
- Create: `.homeycompose/capabilities/grohe_filter_liters.json`
- Create: `.homeycompose/capabilities/grohe_co2_liters.json`
- Create: `.homeycompose/capabilities/grohe_measurement_timestamp.json`
- Create: `.homeycompose/capabilities/grohe_idle_minutes.json`
- Create: `.homeycompose/capabilities/grohe_still_cycles.json`
- Create: `.homeycompose/capabilities/grohe_carbonated_cycles.json`
- Create: `.homeycompose/capabilities/alarm_grohe_filter_low.json`
- Create: `.homeycompose/capabilities/alarm_grohe_co2_low.json`
- Create: `assets/icon.svg`
- Create: `drivers/blue_home/assets/icon.svg`
- Create: `drivers/blue_home/driver.compose.json`
- Create: `drivers/blue_home/driver.js`
- Create: `drivers/blue_home/pair/login_credentials.html`
- Create: `app.js`
- Create: `locales/en.json`
- Create: `locales/pl.json`
- Create: `test/pairing.test.js`

**Interfaces:**
- App produces `getClient()` and `saveAccount({ refreshToken, userId })`.
- Driver consumes `GroheClient` and `findBlueHomeDevices`.
- Pairing returns `{name, data:{id}, store:{route, model, firmware}}`.

- [ ] **Step 1: Write failing pairing tests** with mocked Homey session: credentials are passed only to login, password is absent from returned devices/store/settings, and refresh token is persisted.
- [ ] **Step 2: Create Compose manifest** with app id `com.seweryn.groheblue`, SDK 3, platform `local`, category `appliances`, connectivity `cloud`, English and Polish names.
- [ ] **Step 3: Define custom capabilities** for auto flush, percentages, liters, timestamp, idle minutes, cycles and low-level alarms; mark monitoring values read-only and Insights-enabled where numeric.
- [ ] **Step 4: Implement custom credential pairing view and handlers** `login` then `list_devices`; map every type-104 appliance to immutable device data.
- [ ] **Step 5: Implement account storage** retaining refresh token/user ID only; add re-login behavior when refresh fails.
- [ ] **Step 6: Run tests and `homey app validate`**; fix schema errors before continuing.
- [ ] **Step 7: Commit** with `git commit -m "feat: add Homey pairing and capabilities"`.

### Task 5: Device polling, availability and automatic flushing

**Files:**
- Create: `drivers/blue_home/device.js`
- Create: `test/device.test.js`
- Modify: `lib/grohe-client.js`

**Interfaces:**
- Device produces `refreshState()`, `applyState(state)`, `setAutoFlush(enabled)`.
- Device consumes `homey.app.getClient()`, `mapBlueHome`, and route from store.

- [ ] **Step 1: Write failing device tests** for initial refresh, 300-second Homey timer, capability mapping and timer cleanup in both `onDeleted` and `onUninit`.
- [ ] **Step 2: Implement polling** with a single-flight refresh promise and Homey-managed timers.
- [ ] **Step 3: Write failing availability tests** proving errors one and two preserve availability, error three calls `setUnavailable`, and a later success calls `setAvailable` without clearing last measurements.
- [ ] **Step 4: Implement failure counting and recovery** with sanitized error messages.
- [ ] **Step 5: Write failing auto-flush tests** for capability listener, no PUT retry, five confirmation reads, success only on matching state, and rollback of the displayed capability after rejection.
- [ ] **Step 6: Implement `setAutoFlush`** and serialize it with polling.
- [ ] **Step 7: Run `npm test`** and commit with `git commit -m "feat: monitor and control GROHE Blue"`.

### Task 6: Flow cards and threshold triggers

**Files:**
- Create: `drivers/blue_home/driver.flow.compose.json`
- Modify: `drivers/blue_home/driver.js`
- Modify: `drivers/blue_home/device.js`
- Create: `test/flow-cards.test.js`

**Interfaces:**
- Actions call `args.device.setAutoFlush(true|false)`.
- Condition returns `args.device.getCapabilityValue('grohe_auto_flush')`.
- Device triggers state changes and threshold crossings only, not every poll.

- [ ] **Step 1: Write failing manifest tests** asserting two actions, one condition, auto-flush change, online/offline, filter-low and CO₂-low triggers with a device argument filtered to `blue_home`.
- [ ] **Step 2: Define driver Flow cards** with English and Polish titles and numeric threshold tokens for filter/CO₂ triggers.
- [ ] **Step 3: Write failing listener tests** for actions and condition.
- [ ] **Step 4: Register listeners in driver** and delegate writes to the device.
- [ ] **Step 5: Write failing edge-trigger tests** proving triggers fire only when values cross state/threshold boundaries.
- [ ] **Step 6: Implement trigger comparisons** using the previous successfully applied state.
- [ ] **Step 7: Run tests and validation**; commit with `git commit -m "feat: add GROHE Blue Flow cards"`.

### Task 7: Developer installation and real-device verification

**Live status (2026-08-20):** Steps 3–6 were exercised successfully for hub selection, developer run/install, pairing, type-104 discovery, monitoring, and backend/Homey enable/disable confirmation. Watersystems UI caching requires logout/login to refresh. Step 7 remains mock-only; expired-session re-login and real threshold crossings remain pending. Final owner-requested state is enabled.

**Files:**
- Create: `README.md`
- Create: `README.txt`
- Create: `docs/verification/2026-08-19-homey-pro.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces a repeatable verification record covering every MVP criterion.

- [ ] **Step 1: Document local development** without credentials in command history or repository; include pairing and re-login instructions.
- [ ] **Step 2: Run `npm test`, `npm run lint`, `homey app validate` and an Aikido scan**; record exact outputs and resolve all actionable findings.
- [x] **Step 3: Run `homey select current`** and verify the selected Homey with the user-provided target before any installation.
- [x] **Step 4: Install/run the developer app** with Homey CLI; no secret-bearing evidence is retained.
- [x] **Step 5: Pair the GROHE account and Blue Home**; observe online, filter, CO₂, liters, statistics and localized timestamp without retaining identifiers.
- [x] **Step 6: Test auto flush against backend/Homey confirmation** in both directions with one PUT each; document Watersystems UI caching and leave the final owner-requested state enabled.
- [ ] **Step 7: Exercise offline handling** with a mocked/controlled network failure if disrupting the real hub would affect other automations.
- [ ] **Step 8: Complete the verification matrix** with evidence for each criterion and no stored secrets.
- [ ] **Step 9: Commit** with `git commit -m "docs: verify GROHE Blue on Homey Pro"`.
