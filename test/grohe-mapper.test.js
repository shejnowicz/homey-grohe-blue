const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findBlueHomeDevices, mapBlueHome } = require('../lib/grohe-mapper');

const dashboard = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/dashboard.json'), 'utf8'),
);

const blueHome = dashboard.locations[0].rooms[0].appliances[0];

test('findBlueHomeDevices returns only type 104 appliances with immutable IDs and separate routes', () => {
  const devices = findBlueHomeDevices(dashboard);

  assert.deepEqual(devices, [{
    id: 'appliance-fixture',
    name: 'Synthetic Blue Home',
    route: {
      locationId: 'location-fixture',
      roomId: 'room-fixture',
      applianceId: 'appliance-fixture',
    },
    model: 'Blue Home',
    firmware: '3.2.1',
  }]);
  assert.equal(devices.some(({ id }) => id === 'string-type-fixture'), false);
});

test('mapBlueHome maps the latest measurement and configuration state', () => {
  assert.deepEqual(mapBlueHome(blueHome), {
    online: true,
    autoFlush: true,
    filterPercent: 74,
    filterLiters: 2220,
    co2Percent: 31,
    co2Liters: 18,
    measurementTimestamp: '2026-08-19T08:15:00.000Z',
    idleMinutes: 12,
    stillCycles: 420,
    carbonatedCycles: 87,
    filterLow: false,
    co2Low: false,
  });
});

test('mapBlueHome maps the production status array and confirmation-gated auto flush', () => {
  const appliance = {
    state: { flush_confirmation_required: true },
    status: [{ type: 'connection', value: 1 }],
    config: { auto_flush_active: true, flush_confirmed: false },
  };

  assert.equal(mapBlueHome(appliance).online, true);
  assert.equal(mapBlueHome(appliance).autoFlush, false);
  appliance.status[0].value = 0;
  appliance.config.flush_confirmed = true;
  assert.equal(mapBlueHome(appliance).online, false);
  assert.equal(mapBlueHome(appliance).autoFlush, true);
});

test('production connection status accepts all observed online values', () => {
  for (const value of [1, true, 'connected']) {
    assert.equal(mapBlueHome({
      status: [{ type: 'connection', value }],
    }).online, true);
  }
  assert.equal(mapBlueHome({ status: [{ type: 'connection', value: 0 }] }).online, false);
});

test('auto flush is effective only when active and any required confirmation is present', () => {
  for (const [active, required, confirmed, expected] of [
    [false, false, false, false],
    [false, true, true, false],
    [true, false, false, true],
    [true, true, false, false],
    [true, true, true, true],
  ]) {
    assert.equal(mapBlueHome({
      state: { flush_confirmation_required: required },
      config: { auto_flush_active: active, flush_confirmed: confirmed },
    }).autoFlush, expected);
  }
});

test('mapBlueHome preserves zero measurements and applies low alarms at the inclusive threshold', () => {
  const appliance = {
    state: 'OFFLINE',
    config: { auto_flush_active: false },
    data_latest: {
      measurement: {
        remaining_filter: 10,
        remaining_filter_liters: 0,
        remaining_co2: 0,
        remaining_co2_liters: 0,
        timestamp: '2026-08-19T08:20:00.000Z',
        time_since_last_withdrawal: 0,
        open_close_cycles_still: 0,
        open_close_cycles_carbonated: 0,
      },
    },
  };

  assert.deepEqual(mapBlueHome(appliance), {
    online: false,
    autoFlush: false,
    filterPercent: 10,
    filterLiters: 0,
    co2Percent: 0,
    co2Liters: 0,
    measurementTimestamp: '2026-08-19T08:20:00.000Z',
    idleMinutes: 0,
    stillCycles: 0,
    carbonatedCycles: 0,
    filterLow: true,
    co2Low: true,
  });
});

test('mapBlueHome leaves missing measurements absent and does not raise low alarms', () => {
  assert.deepEqual(mapBlueHome({ state: 'OFFLINE', config: {} }), {
    online: false,
    autoFlush: false,
    filterPercent: undefined,
    filterLiters: undefined,
    co2Percent: undefined,
    co2Liters: undefined,
    measurementTimestamp: undefined,
    idleMinutes: undefined,
    stillCycles: undefined,
    carbonatedCycles: undefined,
    filterLow: false,
    co2Low: false,
  });
});

test('mapBlueHome treats null measurement containers and fields as absent', () => {
  const expected = {
    online: false,
    autoFlush: false,
    filterPercent: undefined,
    filterLiters: undefined,
    co2Percent: undefined,
    co2Liters: undefined,
    measurementTimestamp: undefined,
    idleMinutes: undefined,
    stillCycles: undefined,
    carbonatedCycles: undefined,
    filterLow: false,
    co2Low: false,
  };

  for (const dataLatest of [
    null,
    { measurement: null },
    {
      measurement: {
        remaining_filter: null,
        remaining_filter_liters: null,
        remaining_co2: null,
        remaining_co2_liters: null,
        timestamp: null,
        time_since_last_withdrawal: null,
        open_close_cycles_still: null,
        open_close_cycles_carbonated: null,
      },
    },
  ]) {
    assert.deepEqual(mapBlueHome({ state: 'OFFLINE', data_latest: dataLatest }), expected);
  }
});
