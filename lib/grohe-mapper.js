const BLUE_HOME_TYPE = 104;
const LOW_LEVEL_THRESHOLD = 10;

function present(value) {
  return value === null ? undefined : value;
}

function onlineState(appliance) {
  const state = appliance?.state
    ?? appliance?.status?.online
    ?? appliance?.status?.connection;

  if (typeof state === 'boolean') {
    return state;
  }

  if (typeof state === 'string') {
    return ['ONLINE', 'CONNECTED', 'AVAILABLE'].includes(state.toUpperCase());
  }

  return false;
}

function mapBlueHome(appliance = {}) {
  const measurement = appliance?.data_latest?.measurement || {};
  const filterPercent = present(measurement.remaining_filter);
  const co2Percent = present(measurement.remaining_co2);

  return {
    online: onlineState(appliance),
    autoFlush: appliance?.config?.auto_flush_active === true,
    filterPercent,
    filterLiters: present(measurement.remaining_filter_liters),
    co2Percent,
    co2Liters: present(measurement.remaining_co2_liters),
    measurementTimestamp: present(measurement.timestamp),
    idleMinutes: present(measurement.time_since_last_withdrawal),
    stillCycles: present(measurement.open_close_cycles_still),
    carbonatedCycles: present(measurement.open_close_cycles_carbonated),
    filterLow: typeof filterPercent === 'number' && filterPercent <= LOW_LEVEL_THRESHOLD,
    co2Low: typeof co2Percent === 'number' && co2Percent <= LOW_LEVEL_THRESHOLD,
  };
}

function findBlueHomeDevices(dashboard = {}) {
  const devices = [];
  for (const location of dashboard?.locations || []) {
    for (const room of location?.rooms || []) {
      for (const appliance of room?.appliances || []) {
        if (appliance?.type !== BLUE_HOME_TYPE) {
          continue;
        }

        devices.push({
          id: appliance.appliance_id,
          name: appliance.name,
          route: {
            locationId: location.id,
            roomId: room.id,
            applianceId: appliance.appliance_id,
          },
          model: appliance.model,
          firmware: appliance.firmware ?? appliance.version,
        });
      }
    }
  }
  return devices;
}

module.exports = { findBlueHomeDevices, mapBlueHome };
