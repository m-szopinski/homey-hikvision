'use strict';

import Homey from 'homey';
import { ConnectionManager } from './lib/ConnectionManager';

export = class HikvisionApp extends Homey.App {

  connections!: ConnectionManager;

  async onInit() {
    this.connections = new ConnectionManager(this.log.bind(this));
    this.log('Hikvision app has been initialized');
  }

  async onUninit() {
    this.connections.destroy();
  }

};
