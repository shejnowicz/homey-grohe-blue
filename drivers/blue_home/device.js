const Homey = require('homey');

const { mapBlueHome } = require('../../lib/grohe-mapper');
const { safeError } = require('../../lib/redact');

const POLL_INTERVAL_MS = 300_000;
const CONFIRMATION_DELAY_MS = 2_000;
const CONFIRMATION_READS = 5;

const CAPABILITY_FIELDS = [
  ['grohe_auto_flush', 'autoFlush'],
  ['grohe_online', 'online'],
  ['grohe_filter_percent', 'filterPercent'],
  ['grohe_co2_percent', 'co2Percent'],
  ['grohe_filter_liters', 'filterLiters'],
  ['grohe_co2_liters', 'co2Liters'],
  ['grohe_measurement_timestamp', 'measurementTimestamp'],
  ['grohe_idle_minutes', 'idleMinutes'],
  ['grohe_still_cycles', 'stillCycles'],
  ['grohe_carbonated_cycles', 'carbonatedCycles'],
  ['alarm_grohe_filter_low', 'filterLow'],
  ['alarm_grohe_co2_low', 'co2Low'],
];

function findAppliance(dashboard, route) {
  const location = dashboard?.locations?.find(({ id }) => id === route?.locationId);
  const room = location?.rooms?.find(({ id }) => id === route?.roomId);
  return room?.appliances?.find(({ appliance_id: id }) => id === route?.applianceId);
}

function missingApplianceError() {
  const error = new Error('GROHE request failed');
  error.name = 'GroheProtocolError';
  return error;
}

function confirmationError() {
  const error = new Error('GROHE request failed');
  error.name = 'GroheConfirmationError';
  return error;
}

class BlueHomeDevice extends Homey.Device {
  #pollTimer;

  #refreshPromise;

  #readFailures = 0;

  #availabilityLost = false;

  #operationTail = Promise.resolve();

  async onInit() {
    this.registerCapabilityListener(
      'grohe_auto_flush',
      (enabled) => this.setAutoFlush(enabled),
    );
    this.#pollTimer = this.homey.setInterval(
      () => this.refreshState().catch((error) => this.error(safeError(error))),
      POLL_INTERVAL_MS,
    );
    try {
      await this.refreshState();
    } catch (error) {
      this.error(safeError(error));
    }
  }

  refreshState() {
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    const refreshPromise = this.#enqueueOperation(() => this.#performRefresh());
    this.#refreshPromise = refreshPromise;
    refreshPromise.then(
      () => {
        if (this.#refreshPromise === refreshPromise) {
          this.#refreshPromise = undefined;
        }
      },
      () => {
        if (this.#refreshPromise === refreshPromise) {
          this.#refreshPromise = undefined;
        }
      },
    );
    return refreshPromise;
  }

  #enqueueOperation(operation) {
    const queued = this.#operationTail.then(operation, operation);
    this.#operationTail = queued.catch(() => undefined);
    return queued;
  }

  async #performRefresh() {
    const { state } = await this.#readAndApplyState();
    return state;
  }

  async #readAndApplyState() {
    let state;
    let appliance;
    try {
      const dashboard = await this.homey.app.getClient().getDashboard();
      appliance = findAppliance(dashboard, this.getStoreValue('route'));
      if (!appliance) {
        throw missingApplianceError();
      }

      state = mapBlueHome(appliance);
      await this.applyState(state);
    } catch (error) {
      await this.#recordReadFailure();
      throw safeError(error);
    }

    await this.#recordReadSuccess();
    return { appliance, state };
  }

  async #recordReadFailure() {
    this.#readFailures += 1;
    if (this.#readFailures >= 3 && !this.#availabilityLost) {
      await this.setUnavailable('GROHE request failed');
      this.#availabilityLost = true;
    }
  }

  async #recordReadSuccess() {
    this.#readFailures = 0;
    if (this.#availabilityLost) {
      await this.setAvailable();
      this.#availabilityLost = false;
    }
  }

  async applyState(state) {
    for (const [capability, field] of CAPABILITY_FIELDS) {
      if (state[field] !== undefined) {
        await this.setCapabilityValue(capability, state[field]);
      }
    }
  }

  setAutoFlush(enabled) {
    return this.#enqueueOperation(() => this.#performSetAutoFlush(enabled));
  }

  async #performSetAutoFlush(enabled) {
    const previousValue = this.getCapabilityValue('grohe_auto_flush');
    let rollbackValue = typeof previousValue === 'boolean' ? previousValue : undefined;

    try {
      const route = this.getStoreValue('route');
      await this.homey.app.getClient().setAutoFlush(route, enabled);

      for (let attempt = 0; attempt < CONFIRMATION_READS; attempt += 1) {
        if (attempt > 0) {
          await this.#delay(CONFIRMATION_DELAY_MS);
        }

        try {
          const { appliance } = await this.#readAndApplyState();
          const confirmedValue = appliance?.config?.auto_flush_active;
          if (typeof confirmedValue === 'boolean') {
            rollbackValue = confirmedValue;
          }
          if (confirmedValue === enabled) {
            return;
          }
        } catch {
          // A failed read consumes one confirmation attempt without repeating the PUT.
        }
      }

      throw confirmationError();
    } catch (error) {
      if (rollbackValue !== undefined) {
        try {
          await this.setCapabilityValue('grohe_auto_flush', rollbackValue);
        } catch (rollbackError) {
          throw safeError(rollbackError);
        }
      }
      throw safeError(error);
    }
  }

  #delay(milliseconds) {
    return new Promise((resolve) => {
      this.homey.setTimeout(resolve, milliseconds);
    });
  }

  onDeleted() {
    this.#clearPolling();
  }

  onUninit() {
    this.#clearPolling();
  }

  #clearPolling() {
    if (this.#pollTimer !== undefined) {
      this.homey.clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }
}

module.exports = BlueHomeDevice;
