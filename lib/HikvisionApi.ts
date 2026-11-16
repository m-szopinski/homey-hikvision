'use strict';

import { DigestHttp } from './DigestHttp';

export interface DeviceInfo {
  name: string;
  model: string;
  serial: string;
  firmware: string;
}

export interface ChannelInfo {
  id: number;
  name: string;
}

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1].trim() : '';
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g');
  const result: string[] = [];
  let match = re.exec(xml);
  while (match !== null) {
    result.push(match[1]);
    match = re.exec(xml);
  }
  return result;
}

/**
 * Thin wrapper over the ISAPI endpoints used during pairing.
 */
export class HikvisionApi {

  private client: DigestHttp;

  constructor(client: DigestHttp) {
    this.client = client;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const res = await this.client.get('/ISAPI/System/deviceInfo');
    if (res.statusCode !== 200) {
      throw new Error(`Device rejected the request (HTTP ${res.statusCode}). `
        + 'Check the address, port and that ISAPI/CGI integration is enabled '
        + '(System → Network → Advanced → Integration Protocol).');
    }
    return {
      name: tag(res.body, 'deviceName'),
      model: tag(res.body, 'model'),
      serial: tag(res.body, 'serialNumber'),
      firmware: tag(res.body, 'firmwareVersion'),
    };
  }

  /**
   * List video channels of an NVR/DVR: IP (InputProxy) channels plus analog
   * video inputs. The returned ids match the dynChannelID/channelID used in
   * event notifications.
   */
  async getChannels(): Promise<ChannelInfo[]> {
    const channels: ChannelInfo[] = [];

    const proxies = await this.client.get('/ISAPI/ContentMgmt/InputProxy/channels')
      .catch(() => ({ statusCode: 0, body: '' }));
    if (proxies.statusCode === 200) {
      for (const block of blocks(proxies.body, 'InputProxyChannel')) {
        const id = Number(tag(block, 'id'));
        if (Number.isFinite(id) && id > 0) {
          channels.push({ id, name: tag(block, 'name') });
        }
      }
    }

    const analog = await this.client.get('/ISAPI/System/Video/inputs/channels')
      .catch(() => ({ statusCode: 0, body: '' }));
    if (analog.statusCode === 200) {
      for (const block of blocks(analog.body, 'VideoInputChannel')) {
        const id = Number(tag(block, 'id'));
        const enabled = tag(block, 'videoInputEnabled');
        if (!Number.isFinite(id) || id <= 0) continue;
        if (enabled === 'false') continue;
        if (channels.some((ch) => ch.id === id)) continue;
        channels.push({ id, name: tag(block, 'name') });
      }
    }

    channels.sort((a, b) => a.id - b.id);
    return channels;
  }

}
