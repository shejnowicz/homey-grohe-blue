const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const PROJECT_ROOT = path.join(__dirname, '..');

class FakeHomeyDriver {}
class FakeHomeyDevice {}

class FakeFlowCard {
  constructor(id) {
    this.id = id;
    this.triggerCalls = [];
  }

  registerRunListener(listener) {
    this.runListener = listener;
    return this;
  }

  async trigger(...args) {
    this.triggerCalls.push(args);
  }
}

function loadDriverAndDevice() {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') {
      return { Driver: FakeHomeyDriver, Device: FakeHomeyDevice };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const driverPath = require.resolve('../drivers/blue_home/driver');
    const devicePath = require.resolve('../drivers/blue_home/device');
    delete require.cache[driverPath];
    delete require.cache[devicePath];
    return {
      Driver: require(driverPath),
      Device: require(devicePath),
    };
  } finally {
    Module._load = originalLoad;
  }
}

function createFlowHarness() {
  const { Driver, Device } = loadDriverAndDevice();
  const actionCards = new Map();
  const conditionCards = new Map();
  const triggerCards = new Map();
  const getCard = (cards, id) => {
    if (!cards.has(id)) {
      cards.set(id, new FakeFlowCard(id));
    }
    return cards.get(id);
  };
  const driver = new Driver();
  driver.homey = {
    flow: {
      getActionCard: (id) => getCard(actionCards, id),
      getConditionCard: (id) => getCard(conditionCards, id),
      getDeviceTriggerCard: (id) => getCard(triggerCards, id),
    },
  };

  const device = new Device();
  const capabilityValues = new Map();
  const loggedErrors = [];
  device.driver = driver;
  device.setCapabilityValue = async (capability, value) => {
    capabilityValues.set(capability, value);
  };
  device.getCapabilityValue = (capability) => capabilityValues.get(capability);
  device.error = (error) => loggedErrors.push(error);

  return {
    driver,
    device,
    capabilityValues,
    actionCards,
    conditionCards,
    triggerCards,
    loggedErrors,
  };
}

function getDeviceArgument(card) {
  return card.args?.find(({ type, name }) => type === 'device' && name === 'device');
}

test('Flow manifest defines localized device cards and numeric low-threshold tokens', () => {
  const source = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'drivers/blue_home/driver.flow.compose.json'),
    'utf8',
  ));
  assert.deepEqual(source.actions.map(({ id }) => id), [
    'enable_auto_flush',
    'disable_auto_flush',
  ]);
  assert.deepEqual(source.conditions.map(({ id }) => id), ['auto_flush_enabled']);
  assert.deepEqual(source.triggers.map(({ id }) => id), [
    'auto_flush_changed',
    'device_online',
    'device_offline',
    'filter_low',
    'co2_low',
  ]);

  for (const card of [...source.actions, ...source.conditions, ...source.triggers]) {
    assert.equal(typeof card.title.en, 'string', card.id);
    assert.equal(typeof card.title.pl, 'string', card.id);
  }

  for (const id of ['filter_low', 'co2_low']) {
    const card = source.triggers.find((trigger) => trigger.id === id);
    assert.deepEqual(card.tokens.map(({ name, type }) => ({ name, type })), [
      { name: 'percentage', type: 'number' },
      { name: 'threshold', type: 'number' },
    ]);
  }

  const generated = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'app.json'), 'utf8'));
  for (const type of ['actions', 'conditions', 'triggers']) {
    const expectedIds = source[type].map(({ id }) => id);
    const generatedCards = generated.flow[type]
      .filter(({ id }) => expectedIds.includes(id));
    assert.equal(generatedCards.length, expectedIds.length, type);
    for (const card of generatedCards) {
      assert.deepEqual(getDeviceArgument(card), {
        type: 'device',
        name: 'device',
        filter: 'driver_id=blue_home',
      }, card.id);
    }
  }
});

test('Flow actions await confirmed automatic flushing control', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  const calls = [];
  const device = {
    async setAutoFlush(enabled) {
      calls.push(enabled);
    },
  };

  await harness.actionCards.get('enable_auto_flush').runListener({ device });
  await harness.actionCards.get('disable_auto_flush').runListener({ device });

  assert.deepEqual(calls, [true, false]);
});

test('Flow condition returns the current automatic flushing capability', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  const reads = [];
  const device = {
    getCapabilityValue(capability) {
      reads.push(capability);
      return true;
    },
  };

  const result = await harness.conditionCards.get('auto_flush_enabled').runListener({ device });

  assert.equal(result, true);
  assert.deepEqual(reads, ['grohe_auto_flush']);
});

test('initial state is silent and later state boundaries trigger only once per crossing', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  const normal = {
    autoFlush: false,
    online: true,
    filterPercent: 11,
    co2Percent: 11,
    filterLow: false,
    co2Low: false,
  };
  const lowAndOffline = {
    autoFlush: true,
    online: false,
    filterPercent: 10,
    co2Percent: 9,
    filterLow: true,
    co2Low: true,
  };

  await harness.device.applyState(normal);
  await harness.device.applyState(normal);
  for (const card of harness.triggerCards.values()) {
    assert.deepEqual(card.triggerCalls, [], card.id);
  }

  await harness.device.applyState(lowAndOffline);
  await harness.device.applyState(lowAndOffline);

  assert.deepEqual(harness.triggerCards.get('auto_flush_changed').triggerCalls, [[
    harness.device,
    { enabled: true },
  ]]);
  assert.deepEqual(harness.triggerCards.get('device_online').triggerCalls, []);
  assert.deepEqual(harness.triggerCards.get('device_offline').triggerCalls, [[
    harness.device,
    {},
  ]]);
  assert.deepEqual(harness.triggerCards.get('filter_low').triggerCalls, [[
    harness.device,
    { percentage: 10, threshold: 10 },
  ]]);
  assert.deepEqual(harness.triggerCards.get('co2_low').triggerCalls, [[
    harness.device,
    { percentage: 9, threshold: 10 },
  ]]);

  await harness.device.applyState(normal);
  await harness.device.applyState(lowAndOffline);

  assert.equal(harness.triggerCards.get('device_online').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('device_offline').triggerCalls.length, 2);
  assert.equal(harness.triggerCards.get('filter_low').triggerCalls.length, 2);
  assert.equal(harness.triggerCards.get('co2_low').triggerCalls.length, 2);
});

test('failed capability application does not advance the trigger comparison state', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  const normal = {
    autoFlush: false,
    online: true,
    filterPercent: 11,
    filterLow: false,
  };
  const changed = {
    autoFlush: true,
    online: false,
    filterPercent: 10,
    filterLow: true,
  };
  await harness.device.applyState(normal);
  let failOnline = true;
  harness.device.setCapabilityValue = async (capability, value) => {
    if (capability === 'grohe_online' && failOnline) {
      throw new Error('capability application failed');
    }
    harness.capabilityValues.set(capability, value);
  };

  await assert.rejects(harness.device.applyState(changed), {
    message: 'capability application failed',
  });
  for (const card of harness.triggerCards.values()) {
    assert.deepEqual(card.triggerCalls, [], card.id);
  }

  failOnline = false;
  await harness.device.applyState(changed);

  assert.equal(harness.triggerCards.get('auto_flush_changed').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('device_offline').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('filter_low').triggerCalls.length, 1);
});

test('missing mapped values neither trigger nor erase the previous comparison state', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  await harness.device.applyState({
    autoFlush: false,
    online: true,
    filterLow: false,
    co2Low: false,
  });

  await harness.device.applyState({
    autoFlush: undefined,
    online: true,
    filterLow: false,
    co2Low: false,
  });
  assert.deepEqual(
    harness.triggerCards.get('auto_flush_changed').triggerCalls,
    [],
  );

  await harness.device.applyState({
    autoFlush: true,
    online: true,
    filterLow: false,
    co2Low: false,
  });
  assert.deepEqual(
    harness.triggerCards.get('auto_flush_changed').triggerCalls,
    [[harness.device, { enabled: true }]],
  );
});

test('a rejected trigger is safely logged while later edges dispatch once', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  await harness.device.applyState({
    autoFlush: false,
    online: true,
    filterPercent: 11,
    co2Percent: 11,
    filterLow: false,
    co2Low: false,
  });
  const autoFlushCard = harness.triggerCards.get('auto_flush_changed');
  autoFlushCard.trigger = async function trigger(...args) {
    this.triggerCalls.push(args);
    throw new Error('flow trigger secret');
  };
  const changed = {
    autoFlush: true,
    online: false,
    filterPercent: 10,
    co2Percent: 9,
    filterLow: true,
    co2Low: true,
  };

  await harness.device.applyState(changed);
  await harness.device.applyState(changed);

  assert.equal(autoFlushCard.triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('device_offline').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('filter_low').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('co2_low').triggerCalls.length, 1);
  assert.equal(harness.loggedErrors.length, 1);
  assert.equal(harness.loggedErrors[0].message, 'GROHE request failed');
  assert.equal(harness.loggedErrors[0].message.includes('flow trigger secret'), false);
});

test('missing percentages do not create duplicate low-level crossings', async () => {
  const harness = createFlowHarness();
  await harness.driver.onInit();
  const normal = {
    filterPercent: 11,
    co2Percent: 11,
    filterLow: false,
    co2Low: false,
  };
  const low = {
    filterPercent: 10,
    co2Percent: 9,
    filterLow: true,
    co2Low: true,
  };
  const missing = {
    filterPercent: undefined,
    co2Percent: undefined,
    filterLow: false,
    co2Low: false,
  };

  await harness.device.applyState(normal);
  await harness.device.applyState(low);
  await harness.device.applyState(missing);
  await harness.device.applyState(low);

  assert.equal(harness.triggerCards.get('filter_low').triggerCalls.length, 1);
  assert.equal(harness.triggerCards.get('co2_low').triggerCalls.length, 1);

  await harness.device.applyState(normal);
  await harness.device.applyState(low);

  assert.equal(harness.triggerCards.get('filter_low').triggerCalls.length, 2);
  assert.equal(harness.triggerCards.get('co2_low').triggerCalls.length, 2);
});
