const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

class FakeHomeyDevice {}

function loadDevice() {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') {
      return { Device: FakeHomeyDevice };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../drivers/blue_home/device')];
    return require('../drivers/blue_home/device');
  } finally {
    Module._load = originalLoad;
  }
}

const dashboard = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/dashboard.json'), 'utf8'),
);

const route = {
  locationId: 'location-fixture',
  roomId: 'room-fixture',
  applianceId: 'appliance-fixture',
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({
  getDashboard = async () => dashboard,
  setAutoFlush = async () => undefined,
} = {}) {
  const Device = loadDevice();
  const device = new Device();
  const intervals = [];
  const clearedIntervals = [];
  const capabilityListeners = new Map();
  const capabilityValues = new Map();
  const capabilityWrites = [];
  const dashboardCalls = [];
  const autoFlushCalls = [];
  const timeouts = [];
  const unavailableMessages = [];
  const availableCalls = [];
  const loggedErrors = [];
  const client = {
    async getDashboard() {
      dashboardCalls.push(undefined);
      return getDashboard();
    },
    async setAutoFlush(...args) {
      autoFlushCalls.push(args);
      return setAutoFlush(...args);
    },
  };

  device.homey = {
    app: {
      getClient() {
        return client;
      },
    },
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      clearedIntervals.push(timer);
    },
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timeouts.push(timer);
      callback();
      return timer;
    },
  };
  device.getStoreValue = (key) => (key === 'route' ? route : undefined);
  device.registerCapabilityListener = (capability, listener) => {
    capabilityListeners.set(capability, listener);
  };
  device.setCapabilityValue = async (capability, value) => {
    capabilityWrites.push({ capability, value });
    capabilityValues.set(capability, value);
  };
  device.getCapabilityValue = (capability) => capabilityValues.get(capability);
  device.setUnavailable = async (message) => {
    unavailableMessages.push(message);
  };
  device.setAvailable = async () => {
    availableCalls.push(undefined);
  };
  device.error = (error) => {
    loggedErrors.push(error);
  };

  return {
    device,
    intervals,
    clearedIntervals,
    capabilityListeners,
    capabilityValues,
    capabilityWrites,
    dashboardCalls,
    autoFlushCalls,
    timeouts,
    unavailableMessages,
    availableCalls,
    loggedErrors,
  };
}

function dashboardWithAutoFlush(value) {
  const result = structuredClone(dashboard);
  const appliance = result.locations[0].rooms[0].appliances[0];
  if (value === undefined) {
    delete appliance.config.auto_flush_active;
  } else {
    appliance.config.auto_flush_active = value;
  }
  return result;
}

test('initializes with an immediate refresh and a 300-second Homey polling timer', async () => {
  const harness = createHarness();

  await harness.device.onInit();

  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].milliseconds, 300_000);
  assert.deepEqual(Object.fromEntries(harness.capabilityValues), {
    grohe_auto_flush: true,
    grohe_online: true,
    grohe_filter_percent: 74,
    grohe_co2_percent: 31,
    grohe_filter_liters: 2220,
    grohe_co2_liters: 18,
    grohe_measurement_timestamp: '2026-08-19T08:15:00.000Z',
    grohe_idle_minutes: 12,
    grohe_still_cycles: 420,
    grohe_carbonated_cycles: 87,
    alarm_grohe_filter_low: false,
    alarm_grohe_co2_low: false,
  });

  await harness.intervals[0].callback();
  assert.equal(harness.dashboardCalls.length, 2);
});

test('applyState preserves last measurements when later mapped values are missing', async () => {
  const harness = createHarness();
  await harness.device.applyState({
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

  await harness.device.applyState({
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

  assert.deepEqual(Object.fromEntries(harness.capabilityValues), {
    grohe_auto_flush: false,
    grohe_online: false,
    grohe_filter_percent: 74,
    grohe_co2_percent: 31,
    grohe_filter_liters: 2220,
    grohe_co2_liters: 18,
    grohe_measurement_timestamp: '2026-08-19T08:15:00.000Z',
    grohe_idle_minutes: 12,
    grohe_still_cycles: 420,
    grohe_carbonated_cycles: 87,
    alarm_grohe_filter_low: false,
    alarm_grohe_co2_low: false,
  });
});

test('concurrent refreshes share one in-flight dashboard read', async () => {
  const pendingDashboard = createDeferred();
  const harness = createHarness({
    getDashboard: () => pendingDashboard.promise,
  });

  const first = harness.device.refreshState();
  const second = harness.device.refreshState();

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(harness.dashboardCalls.length, 1);

  pendingDashboard.resolve(dashboard);
  await first;
});

for (const lifecycleMethod of ['onDeleted', 'onUninit']) {
  test(`${lifecycleMethod} clears the Homey polling timer`, async () => {
    const harness = createHarness();
    await harness.device.onInit();

    await harness.device[lifecycleMethod]();

    assert.deepEqual(harness.clearedIntervals, [harness.intervals[0]]);
  });
}

test('only the third consecutive read failure marks the device unavailable', async () => {
  let attempt = 0;
  const harness = createHarness({
    getDashboard: async () => {
      attempt += 1;
      throw new Error(`transport secret ${attempt}`);
    },
  });

  for (let expectedFailures = 1; expectedFailures <= 3; expectedFailures += 1) {
    await assert.rejects(
      harness.device.refreshState(),
      (error) => {
        assert.equal(error.message, 'GROHE request failed');
        assert.equal(error.message.includes('transport secret'), false);
        return true;
      },
    );
    assert.equal(
      harness.unavailableMessages.length,
      expectedFailures === 3 ? 1 : 0,
    );
  }

  assert.deepEqual(harness.unavailableMessages, ['GROHE request failed']);
});

test('a successful read after three failures restores availability and retains measurements', async () => {
  const sparseDashboard = {
    locations: [{
      id: 'location-fixture',
      rooms: [{
        id: 'room-fixture',
        appliances: [{
          appliance_id: 'appliance-fixture',
          type: 104,
          state: 'OFFLINE',
          config: {},
        }],
      }],
    }],
  };
  const responses = [
    dashboard,
    new Error('first secret failure'),
    new Error('second secret failure'),
    new Error('third secret failure'),
    sparseDashboard,
  ];
  const harness = createHarness({
    getDashboard: async () => {
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  });

  await harness.device.refreshState();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(harness.device.refreshState());
  }
  await harness.device.refreshState();

  assert.deepEqual(harness.unavailableMessages, ['GROHE request failed']);
  assert.equal(harness.availableCalls.length, 1);
  assert.equal(harness.capabilityValues.get('grohe_online'), false);
  assert.equal(harness.capabilityValues.get('grohe_filter_percent'), 74);
  assert.equal(harness.capabilityValues.get('grohe_filter_liters'), 2220);
  assert.equal(harness.capabilityValues.get('grohe_co2_percent'), 31);
  assert.equal(harness.capabilityValues.get('grohe_co2_liters'), 18);
});

test('an API-reported offline state updates grohe_online without changing Homey availability', async () => {
  const offlineDashboard = structuredClone(dashboard);
  offlineDashboard.locations[0].rooms[0].appliances[0].state = 'OFFLINE';
  const harness = createHarness({
    getDashboard: async () => offlineDashboard,
  });

  await harness.device.refreshState();

  assert.equal(harness.capabilityValues.get('grohe_online'), false);
  assert.deepEqual(harness.unavailableMessages, []);
  assert.deepEqual(harness.availableCalls, []);
});

test('an initial read failure is logged safely without aborting device initialization', async () => {
  const harness = createHarness({
    getDashboard: async () => {
      throw new Error('initial secret failure');
    },
  });

  await harness.device.onInit();

  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.unavailableMessages.length, 0);
  assert.equal(harness.loggedErrors.length, 1);
  assert.equal(harness.loggedErrors[0].message, 'GROHE request failed');
  assert.equal(harness.loggedErrors[0].message.includes('initial secret'), false);
});

test('registers a grohe_auto_flush capability listener that delegates to confirmed control', async () => {
  const harness = createHarness();
  await harness.device.onInit();

  await harness.capabilityListeners.get('grohe_auto_flush')(true);

  assert.deepEqual(harness.autoFlushCalls, [[route, true]]);
  assert.equal(harness.dashboardCalls.length, 2);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
});

test('does not retry a rejected PUT and rolls the displayed capability back safely', async () => {
  const harness = createHarness({
    setAutoFlush: async () => {
      throw new Error('ambiguous write secret');
    },
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    (error) => {
      assert.equal(error.message, 'GROHE request failed');
      assert.equal(error.message.includes('ambiguous write secret'), false);
      return true;
    },
  );

  assert.deepEqual(harness.autoFlushCalls, [[route, true]]);
  assert.equal(harness.dashboardCalls.length, 0);
  assert.deepEqual(harness.capabilityWrites, [{
    capability: 'grohe_auto_flush',
    value: false,
  }]);
});

test('performs at most five confirmation reads two seconds apart and waits for a match', async () => {
  const responses = [
    dashboardWithAutoFlush(false),
    dashboardWithAutoFlush(false),
    dashboardWithAutoFlush(false),
    dashboardWithAutoFlush(false),
    dashboardWithAutoFlush(true),
  ];
  const harness = createHarness({
    getDashboard: async () => responses.shift(),
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await harness.device.setAutoFlush(true);

  assert.deepEqual(harness.autoFlushCalls, [[route, true]]);
  assert.equal(harness.dashboardCalls.length, 5);
  assert.deepEqual(
    harness.timeouts.map(({ milliseconds }) => milliseconds),
    [2_000, 2_000, 2_000, 2_000],
  );
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
});

test('rejects after five non-matching confirmations and restores the confirmed state', async () => {
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(false),
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { message: 'GROHE request failed' },
  );

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 5);
  assert.deepEqual(
    harness.timeouts.map(({ milliseconds }) => milliseconds),
    [2_000, 2_000, 2_000, 2_000],
  );
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), false);
  assert.deepEqual(harness.capabilityWrites.at(-1), {
    capability: 'grohe_auto_flush',
    value: false,
  });
});

test('does not accept a missing API auto-flush field as confirmation of false', async () => {
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(undefined),
  });
  harness.capabilityValues.set('grohe_auto_flush', true);

  await assert.rejects(
    harness.device.setAutoFlush(false),
    { message: 'GROHE request failed' },
  );

  assert.equal(harness.dashboardCalls.length, 5);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
});

test('serializes polling behind an in-flight auto-flush write', async () => {
  const pendingWrite = createDeferred();
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(true),
    setAutoFlush: () => pendingWrite.promise,
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  const write = harness.device.setAutoFlush(true);
  await Promise.resolve();
  const refresh = harness.device.refreshState();
  await Promise.resolve();

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 0);

  pendingWrite.resolve();
  await write;
  await refresh;

  assert.equal(harness.dashboardCalls.length, 2);
});
