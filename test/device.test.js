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
  setCapabilityValue,
  deviceRoute = route,
  autoRunTimeouts = true,
  language = 'en-GB',
  timezone = 'UTC',
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
  const clearedTimeouts = [];
  const unavailableMessages = [];
  const availableCalls = [];
  const loggedErrors = [];
  const loggedMessages = [];
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
    i18n: { getLanguage: () => language },
    clock: { getTimezone: () => timezone },
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
      if (autoRunTimeouts) {
        callback();
      }
      return timer;
    },
    clearTimeout(timer) {
      clearedTimeouts.push(timer);
    },
  };
  device.getStoreValue = (key) => (key === 'route' ? deviceRoute : undefined);
  device.registerCapabilityListener = (capability, listener) => {
    capabilityListeners.set(capability, listener);
  };
  device.setCapabilityValue = async (capability, value) => {
    capabilityWrites.push({ capability, value });
    if (setCapabilityValue) {
      await setCapabilityValue(capability, value);
    }
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
  device.log = (...args) => {
    loggedMessages.push(args);
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
    clearedTimeouts,
    unavailableMessages,
    availableCalls,
    loggedErrors,
    loggedMessages,
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

function dashboardWithConfirmedAutoFlush(active, required, confirmed) {
  const result = dashboardWithAutoFlush(active);
  const appliance = result.locations[0].rooms[0].appliances[0];
  appliance.state = { flush_confirmation_required: required };
  appliance.config.flush_confirmed = confirmed;
  return result;
}

test('logs only changed boolean auto-flush diagnostics without appliance data', async () => {
  const first = dashboardWithConfirmedAutoFlush(true, true, false);
  const appliance = first.locations[0].rooms[0].appliances[0];
  appliance.serial = 'secret-serial';
  appliance.email = 'secret@example.invalid';
  const second = structuredClone(first);
  const third = dashboardWithConfirmedAutoFlush(false, true, false);
  const responses = [first, second, third];
  const harness = createHarness({ getDashboard: async () => responses.shift() });

  await harness.device.refreshState();
  await harness.device.refreshState();
  await harness.device.refreshState();

  assert.deepEqual(harness.loggedMessages, [
    ['GROHE auto-flush diagnostic', {
      active: true,
      confirmed: false,
      confirmationRequired: true,
    }],
    ['GROHE auto-flush diagnostic', {
      active: false,
      confirmed: false,
      confirmationRequired: true,
    }],
  ]);
  assert.deepEqual(Object.keys(harness.loggedMessages[0][1]).sort(), [
    'active',
    'confirmationRequired',
    'confirmed',
  ]);
  assert.equal(JSON.stringify(harness.loggedMessages).includes('secret'), false);
});

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
    grohe_measurement_timestamp: '19/08/2026, 08:15',
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
    grohe_measurement_timestamp: '19/08/2026, 08:15',
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

test('waits for effective auto flush confirmation, not merely the active flag', async () => {
  const responses = [
    dashboardWithConfirmedAutoFlush(true, true, false),
    dashboardWithConfirmedAutoFlush(true, true, true),
  ];
  const harness = createHarness({ getDashboard: async () => responses.shift() });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await harness.device.setAutoFlush(true);

  assert.equal(harness.dashboardCalls.length, 2);
  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
});

test('formats API measurement timestamps for the Homey locale and timezone safely', async () => {
  const harness = createHarness({ language: 'pl-PL', timezone: 'Europe/Warsaw' });
  await harness.device.applyState({ measurementTimestamp: '2026-08-20T11:00:00.000Z' });
  assert.equal(harness.capabilityValues.get('grohe_measurement_timestamp'), '20.08.2026, 13:00');

  await harness.device.applyState({ measurementTimestamp: 'not-a-date' });
  assert.equal(harness.capabilityValues.get('grohe_measurement_timestamp'), 'not-a-date');
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

test('a rejected confirmation read aborts instead of accepting a later match', async () => {
  const responses = [
    new Error('confirmation read secret'),
    dashboardWithAutoFlush(true),
  ];
  const harness = createHarness({
    getDashboard: async () => {
      const response = responses.shift();
      if (response instanceof Error) {
        response.name = 'GroheReadError';
        throw response;
      }
      return response;
    },
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { name: 'GroheReadError', message: 'GROHE request failed' },
  );

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), false);
});

test('a capability application failure neither counts as a read failure nor blocks raw confirmation', async () => {
  const responses = [
    dashboardWithAutoFlush(true),
    new Error('first cloud failure'),
    new Error('second cloud failure'),
  ];
  const harness = createHarness({
    getDashboard: async () => {
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
    setCapabilityValue: async (capability) => {
      if (capability === 'grohe_filter_percent') {
        throw new Error('Homey capability failure');
      }
    },
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await harness.device.setAutoFlush(true);
  await assert.rejects(harness.device.refreshState());
  await assert.rejects(harness.device.refreshState());

  assert.equal(harness.dashboardCalls.length, 3);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
  assert.deepEqual(harness.unavailableMessages, []);
});

test('serializes an auto-flush write behind an in-flight poll', async () => {
  const pendingRead = createDeferred();
  const harness = createHarness({
    getDashboard: () => pendingRead.promise,
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  const refresh = harness.device.refreshState();
  await Promise.resolve();
  const write = harness.device.setAutoFlush(true);
  await Promise.resolve();

  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.autoFlushCalls.length, 0);

  pendingRead.resolve(dashboardWithAutoFlush(true));
  await refresh;
  await write;

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 2);
});

test('selects the appliance by the complete stored route when IDs collide', async () => {
  const collisionDashboard = structuredClone(dashboard);
  collisionDashboard.locations[0].rooms.unshift({
    id: 'wrong-room-fixture',
    appliances: [{
      appliance_id: 'appliance-fixture',
      state: 'OFFLINE',
      config: { auto_flush_active: false },
    }],
  });
  const harness = createHarness({
    getDashboard: async () => collisionDashboard,
  });

  await harness.device.refreshState();

  assert.equal(harness.capabilityValues.get('grohe_online'), true);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), true);
  assert.equal(harness.capabilityValues.get('grohe_filter_percent'), 74);
});

test('applies numeric zero measurements without treating them as missing', async () => {
  const harness = createHarness();

  await harness.device.applyState({
    filterPercent: 0,
    filterLiters: 0,
    co2Percent: 0,
    co2Liters: 0,
    idleMinutes: 0,
    stillCycles: 0,
    carbonatedCycles: 0,
  });

  assert.deepEqual(Object.fromEntries(harness.capabilityValues), {
    grohe_filter_percent: 0,
    grohe_co2_percent: 0,
    grohe_filter_liters: 0,
    grohe_co2_liters: 0,
    grohe_idle_minutes: 0,
    grohe_still_cycles: 0,
    grohe_carbonated_cycles: 0,
  });
});

for (const lifecycleMethod of ['onDeleted', 'onUninit']) {
  test(`${lifecycleMethod} prevents an in-flight refresh and queued write from mutating after teardown`, async () => {
    const pendingRead = createDeferred();
    const harness = createHarness({
      getDashboard: () => pendingRead.promise,
    });

    const refresh = harness.device.refreshState();
    await Promise.resolve();
    const write = harness.device.setAutoFlush(true);
    await harness.device[lifecycleMethod]();
    pendingRead.resolve(dashboard);

    await assert.rejects(refresh, { message: 'GROHE request failed' });
    await assert.rejects(write, { message: 'GROHE request failed' });
    assert.deepEqual(harness.capabilityWrites, []);
    assert.deepEqual(harness.unavailableMessages, []);
    assert.deepEqual(harness.availableCalls, []);
    assert.equal(harness.autoFlushCalls.length, 0);
  });
}

test('teardown after an in-flight PUT prevents confirmation and capability mutation', async () => {
  const pendingWrite = createDeferred();
  const harness = createHarness({
    setAutoFlush: () => pendingWrite.promise,
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  const write = harness.device.setAutoFlush(true);
  await Promise.resolve();
  await harness.device.onDeleted();
  pendingWrite.resolve();

  await assert.rejects(write, { message: 'GROHE request failed' });
  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 0);
  assert.deepEqual(harness.capabilityWrites, []);
});

test('teardown during confirmation capability application cannot turn a matched read into success', async () => {
  const pendingCapability = createDeferred();
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(true),
    setCapabilityValue: (capability) => (
      capability === 'grohe_auto_flush' ? pendingCapability.promise : undefined
    ),
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  const write = harness.device.setAutoFlush(true);
  for (let turn = 0; turn < 100 && harness.capabilityWrites.length === 0; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.capabilityWrites.length, 1);

  await harness.device.onDeleted();
  pendingCapability.resolve();

  await assert.rejects(write, { message: 'GROHE request failed' });
  assert.equal(harness.capabilityWrites.length, 1);
});

test('teardown cancels and settles a pending Homey confirmation delay', async () => {
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(false),
    autoRunTimeouts: false,
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  const write = harness.device.setAutoFlush(true);
  for (let turn = 0; turn < 100 && harness.timeouts.length === 0; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.timeouts.length, 1);

  await harness.device.onUninit();
  const outcome = await Promise.race([
    write.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25)),
  ]);

  assert.equal(outcome, 'rejected');
  assert.deepEqual(harness.clearedTimeouts, [harness.timeouts[0]]);
  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.capabilityWrites.length, 12);
});

test('future operations after teardown perform no cloud or Homey mutation', async () => {
  const harness = createHarness();
  await harness.device.onDeleted();

  await assert.rejects(harness.device.refreshState(), { message: 'GROHE request failed' });
  await assert.rejects(harness.device.setAutoFlush(true), { message: 'GROHE request failed' });

  assert.equal(harness.dashboardCalls.length, 0);
  assert.equal(harness.autoFlushCalls.length, 0);
  assert.deepEqual(harness.capabilityWrites, []);
});

test('a missing prior display value is restored from a safe server read after PUT rejection', async () => {
  const writeError = new Error('ambiguous write secret');
  writeError.name = 'GroheWriteError';
  const harness = createHarness({
    setAutoFlush: async () => {
      throw writeError;
    },
    getDashboard: async () => dashboardWithAutoFlush(false),
  });
  harness.capabilityValues.set('grohe_auto_flush', null);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { name: 'GroheWriteError', message: 'GROHE request failed' },
  );

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), false);
});

test('a missing prior display value remains unchanged when recovery has no raw boolean', async () => {
  const harness = createHarness({
    setAutoFlush: async () => {
      throw new Error('ambiguous write secret');
    },
    getDashboard: async () => dashboardWithAutoFlush(undefined),
  });
  harness.capabilityValues.set('grohe_auto_flush', null);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { message: 'GROHE request failed' },
  );

  assert.equal(harness.dashboardCalls.length, 1);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), null);
  assert.deepEqual(harness.capabilityWrites, []);
});

test('rollback recovery never exceeds five total dashboard reads after a PUT', async () => {
  const harness = createHarness({
    getDashboard: async () => dashboardWithAutoFlush(undefined),
  });
  harness.capabilityValues.set('grohe_auto_flush', null);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { message: 'GROHE request failed' },
  );

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.dashboardCalls.length, 5);
  assert.equal(harness.capabilityValues.get('grohe_auto_flush'), null);
});

test('rollback setter failure does not mask the original sanitized operation error', async () => {
  const writeError = new Error('ambiguous write secret');
  writeError.name = 'GroheWriteError';
  const harness = createHarness({
    setAutoFlush: async () => {
      throw writeError;
    },
    setCapabilityValue: async (capability) => {
      if (capability === 'grohe_auto_flush') {
        const error = new Error('rollback setter secret');
        error.name = 'HomeyCapabilityError';
        throw error;
      }
    },
  });
  harness.capabilityValues.set('grohe_auto_flush', false);

  await assert.rejects(
    harness.device.setAutoFlush(true),
    { name: 'GroheWriteError', message: 'GROHE request failed' },
  );

  assert.equal(harness.autoFlushCalls.length, 1);
  assert.equal(harness.loggedErrors.length, 1);
  assert.equal(harness.loggedErrors[0].message, 'GROHE request failed');
});
