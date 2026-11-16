'use strict';

import Homey from 'homey';
import { DigestHttp } from '../../lib/DigestHttp';
import { HikvisionApi, ChannelInfo, DeviceInfo } from '../../lib/HikvisionApi';

interface ConnectionForm {
  address: string;
  port: number;
  use_https: boolean;
  username: string;
  password: string;
}

export = class NvrCameraDriver extends Homey.Driver {

  async onInit() {
    this.log('NvrCameraDriver has been initialized');
  }

  async onPair(session: Homey.Driver.PairSession) {
    let form: ConnectionForm | null = null;
    let info: DeviceInfo | null = null;
    let channels: ChannelInfo[] = [];

    session.setHandler('login', async (data: ConnectionForm) => {
      const api = new HikvisionApi(new DigestHttp({
        host: String(data.address || '').trim(),
        port: Number(data.port) || 80,
        secure: Boolean(data.use_https),
        username: String(data.username || ''),
        password: String(data.password || ''),
      }));
      info = await api.getDeviceInfo();
      channels = await api.getChannels();
      if (channels.length === 0) {
        throw new Error('Connected, but no video channels were found on this device.');
      }
      form = data;
      this.log(`Pairing NVR ${info.model} (${info.serial}): ${channels.length} channels`);
      return { name: info.name || info.model, channels: channels.length };
    });

    session.setHandler('list_devices', async () => {
      if (!form || !info) return [];
      const connection = form;
      const serial = info.serial || `${connection.address}-${connection.port}`;
      return channels.map((channel) => ({
        name: channel.name || `${info ? (info.name || info.model) : 'NVR'} CH${channel.id}`,
        data: { id: `hik-${serial}-ch${channel.id}` },
        settings: {
          address: String(connection.address).trim(),
          port: Number(connection.port) || 80,
          use_https: Boolean(connection.use_https),
          username: String(connection.username),
          password: String(connection.password),
          channel: channel.id,
        },
      }));
    });
  }

};
