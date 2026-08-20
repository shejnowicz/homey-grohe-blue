const Homey = require('homey');

const { GroheClient } = require('../../lib/grohe-client');
const { findBlueHomeDevices } = require('../../lib/grohe-mapper');
const { safeError } = require('../../lib/redact');

class BlueHomeDriver extends Homey.Driver {
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
