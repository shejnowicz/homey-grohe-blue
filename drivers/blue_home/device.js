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

function lifecycleError() {
  const error = new Error('GROHE request failed');
  error.name = 'GroheLifecycleError';
  return error;
}

class BlueHomeDevice extends Homey.Device {
  #pollTimer;

  #refreshPromise;

  #readFailures = 0;

  #availabilityLost = false;

  #operationTail = Promise.resolve();

  #disposed = false;

  #pendingDelays = new Set();

  #lastConfirmedAutoFlush;

  #previousAppliedState;

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
    if (this.#disposed) {
      return Promise.reject(lifecycleError());
    }
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
    if (this.#disposed) {
      return Promise.reject(lifecycleError());
    }
    const run = () => {
      this.#assertActive();
      return operation();
    };
    const queued = this.#operationTail.then(run, run);
    this.#operationTail = queued.catch(() => undefined);
    return queued;
  }

  async #performRefresh() {
    const { state } = await this.#fetchState();
    this.#assertActive();
    try {
      await this.applyState(state);
    } catch (error) {
      throw safeError(error);
    }
    return state;
  }

  async #fetchState() {
    let state;
    let appliance;
    try {
      this.#assertActive();
      const dashboard = await this.homey.app.getClient().getDashboard();
      this.#assertActive();
      appliance = findAppliance(dashboard, this.getStoreValue('route'));
      if (!appliance) {
        throw missingApplianceError();
      }

      state = mapBlueHome(appliance);
    } catch (error) {
      if (this.#disposed || error?.name === 'GroheLifecycleError') {
        throw safeError(error);
      }
      try {
        await this.#recordReadFailure();
      } catch (availabilityError) {
        this.error(safeError(availabilityError));
      }
      throw safeError(error);
    }

    const confirmedAutoFlush = appliance?.config?.auto_flush_active;
    if (typeof confirmedAutoFlush === 'boolean') {
      this.#lastConfirmedAutoFlush = confirmedAutoFlush;
    }
    try {
      await this.#recordReadSuccess();
    } catch (availabilityError) {
      this.error(safeError(availabilityError));
    }
    this.#assertActive();
    return { appliance, state };
  }

  async #recordReadFailure() {
    this.#assertActive();
    this.#readFailures += 1;
    if (this.#readFailures >= 3 && !this.#availabilityLost) {
      await this.setUnavailable('GROHE request failed');
      this.#availabilityLost = true;
    }
  }

  async #recordReadSuccess() {
    this.#assertActive();
    this.#readFailures = 0;
    if (this.#availabilityLost) {
      await this.setAvailable();
      this.#availabilityLost = false;
    }
  }

  async applyState(state) {
    for (const [capability, field] of CAPABILITY_FIELDS) {
      if (state[field] !== undefined) {
        this.#assertActive();
        await this.setCapabilityValue(capability, state[field]);
      }
    }
    const previousState = this.#previousAppliedState;
    const appliedState = { ...previousState };
    for (const [field, value] of Object.entries(state)) {
      if (value !== undefined) {
        appliedState[field] = value;
      }
    }
    this.#previousAppliedState = appliedState;
    if (previousState) {
      await this.#triggerStateChanges(previousState, appliedState);
    }
  }

  async #triggerStateChanges(previousState, state) {
    if (
      typeof state.autoFlush === 'boolean'
      && typeof previousState.autoFlush === 'boolean'
      && state.autoFlush !== previousState.autoFlush
      && this.driver?.autoFlushChangedTrigger
    ) {
      await this.driver.autoFlushChangedTrigger.trigger(this, {
        enabled: state.autoFlush,
      });
    }
    if (
      typeof state.online === 'boolean'
      && typeof previousState.online === 'boolean'
      && state.online !== previousState.online
    ) {
      const trigger = state.online
        ? this.driver?.deviceOnlineTrigger
        : this.driver?.deviceOfflineTrigger;
      if (trigger) {
        await trigger.trigger(this, {});
      }
    }
    if (
      state.filterLow === true
      && previousState.filterLow === false
      && this.driver?.filterLowTrigger
    ) {
      await this.driver.filterLowTrigger.trigger(this, {
        percentage: state.filterPercent,
        threshold: 10,
      });
    }
    if (
      state.co2Low === true
      && previousState.co2Low === false
      && this.driver?.co2LowTrigger
    ) {
      await this.driver.co2LowTrigger.trigger(this, {
        percentage: state.co2Percent,
        threshold: 10,
      });
    }
  }

  setAutoFlush(enabled) {
    return this.#enqueueOperation(() => this.#performSetAutoFlush(enabled));
  }

  async #performSetAutoFlush(enabled) {
    const previousValue = this.getCapabilityValue('grohe_auto_flush');
    let rollbackValue = typeof previousValue === 'boolean'
      ? previousValue
      : this.#lastConfirmedAutoFlush;
    let confirmationReads = 0;

    try {
      this.#assertActive();
      const route = this.getStoreValue('route');
      await this.homey.app.getClient().setAutoFlush(route, enabled);
      this.#assertActive();

      for (let attempt = 0; attempt < CONFIRMATION_READS; attempt += 1) {
        if (attempt > 0) {
          await this.#delay(CONFIRMATION_DELAY_MS);
        }

        confirmationReads += 1;
        const { appliance, state } = await this.#fetchState();
        const confirmedValue = appliance?.config?.auto_flush_active;
        if (typeof confirmedValue === 'boolean') {
          rollbackValue = confirmedValue;
        }
        try {
          await this.applyState(
            typeof confirmedValue === 'boolean'
              ? state
              : { ...state, autoFlush: undefined },
          );
        } catch (applicationError) {
          if (this.#disposed || applicationError?.name === 'GroheLifecycleError') {
            throw lifecycleError();
          }
          this.error(safeError(applicationError));
        }
        this.#assertActive();
        if (confirmedValue === enabled) {
          return;
        }
      }

      throw confirmationError();
    } catch (error) {
      const operationError = safeError(error);
      await this.#restoreAutoFlush(
        rollbackValue,
        confirmationReads < CONFIRMATION_READS,
      );
      throw operationError;
    }
  }

  async #restoreAutoFlush(rollbackValue, canReadForRecovery) {
    if (this.#disposed) {
      return;
    }

    let confirmedValue = rollbackValue;
    if (typeof confirmedValue !== 'boolean' && canReadForRecovery) {
      try {
        const { appliance } = await this.#fetchState();
        confirmedValue = appliance?.config?.auto_flush_active;
      } catch (rollbackReadError) {
        if (!this.#disposed) {
          this.error(safeError(rollbackReadError));
        }
        return;
      }
    }

    if (typeof confirmedValue === 'boolean' && !this.#disposed) {
      try {
        await this.setCapabilityValue('grohe_auto_flush', confirmedValue);
      } catch (rollbackError) {
        if (!this.#disposed) {
          this.error(safeError(rollbackError));
        }
      }
    }
  }

  #delay(milliseconds) {
    this.#assertActive();
    return new Promise((resolve) => {
      const pending = {
        settled: false,
        timer: undefined,
        settle: undefined,
      };
      pending.settle = () => {
        if (pending.settled) {
          return;
        }
        pending.settled = true;
        this.#pendingDelays.delete(pending);
        resolve();
      };
      this.#pendingDelays.add(pending);
      pending.timer = this.homey.setTimeout(pending.settle, milliseconds);
      if (this.#disposed) {
        this.homey.clearTimeout(pending.timer);
        pending.settle();
      }
    });
  }

  onDeleted() {
    this.#dispose();
  }

  onUninit() {
    this.#dispose();
  }

  #assertActive() {
    if (this.#disposed) {
      throw lifecycleError();
    }
  }

  #dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearPolling();
    for (const pending of [...this.#pendingDelays]) {
      this.homey.clearTimeout(pending.timer);
      pending.settle();
    }
  }

  #clearPolling() {
    if (this.#pollTimer !== undefined) {
      this.homey.clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }
}

module.exports = BlueHomeDevice;
