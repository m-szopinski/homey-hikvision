'use strict';

import Homey from 'homey';
import { DigestHttp } from '../../lib/DigestHttp';
import { HikvisionApi } from '../../lib/HikvisionApi';

interface ConnectionForm {
  address: string;
  port: number;
  use_https: boolean;
  username: string;
  password: string;
}

export = class CameraDriver extends Homey.Driver {

  async onInit() {
    this.log('CameraDriver has been initialized');
  }

  async onPair(session: Homey.Driver.PairSession) {
    // Called by the custom pair view with the connection form; verifies the
    // connection and returns the device identity so the view can create the
    // device with sensible defaults.
    session.setHandler('validate', async (form: ConnectionForm) => {
      const api = new HikvisionApi(new DigestHttp({
        host: String(form.address || '').trim(),
        port: Number(form.port) || 80,
        secure: Boolean(form.use_https),
        username: String(form.username || ''),
        password: String(form.password || ''),
      }));
      const info = await api.getDeviceInfo();
      this.log(`Pairing validated: ${info.model} (${info.serial})`);
      return info;
    });
  }

};
