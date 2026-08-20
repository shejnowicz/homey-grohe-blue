const Homey = require('homey');

const { GroheClient } = require('../../lib/grohe-client');
const { findBlueHomeDevices } = require('../../lib/grohe-mapper');
const { safeError } = require('../../lib/redact');

class BlueHomeDriver extends Homey.Driver {
  async onInit() {
    this.autoFlushChangedTrigger = this.homey.flow.getDeviceTriggerCard('auto_flush_changed');
    this.deviceOnlineTrigger = this.homey.flow.getDeviceTriggerCard('device_online');
    this.deviceOfflineTrigger = this.homey.flow.getDeviceTriggerCard('device_offline');
    this.filterLowTrigger = this.homey.flow.getDeviceTriggerCard('filter_low');
    this.co2LowTrigger = this.homey.flow.getDeviceTriggerCard('co2_low');

    this.homey.flow.getActionCard('enable_auto_flush')
      .registerRunListener(({ device }) => device.setAutoFlush(true));
    this.homey.flow.getActionCard('disable_auto_flush')
      .registerRunListener(({ device }) => device.setAutoFlush(false));
    this.homey.flow.getConditionCard('auto_flush_enabled')
      .registerRunListener(({ device }) => (
        device.getCapabilityValue('grohe_auto_flush') === true
      ));
  }

  createPairingClient() {
    return new GroheClient();
  }

  async onPair(session) {
    let pairingClient;

    session.setHandler('login', async ({ username, password }) => {
      try {
        const client = this.createPairingClient();
        const tokens = await client.login(username, password);
        await this.homey.app.saveAccount({
          refreshToken: tokens.refresh_token,
          userId: username,
        });
        pairingClient = client;
        return true;
      } catch (error) {
        throw safeError(error);
      }
    });

    session.setHandler('list_devices', async () => {
      try {
        if (!pairingClient) {
          const error = new Error('GROHE login required');
          error.name = 'GroheAuthenticationError';
          throw error;
        }
        const dashboard = await pairingClient.getDashboard();
        return findBlueHomeDevices(dashboard).map((descriptor) => ({
          name: descriptor.name,
          data: { id: descriptor.id },
          store: {
            route: descriptor.route,
            model: descriptor.model,
            firmware: descriptor.firmware,
          },
        }));
      } catch (error) {
        throw safeError(error);
      }
    });
  }
}

module.exports = BlueHomeDriver;
