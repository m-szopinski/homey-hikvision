# Hikvision Cameras & NVR for Homey

Homey app that brings **real-time events** from Hikvision IP cameras, NVRs and DVRs
to Homey Flows — motion, line crossing, intrusion, region entrance/exit, tamper,
face detection and more.

Works on every Homey Pro, **including Homey Pro (Early 2019)** — the app has no
runtime dependencies and targets SDK v3 with `compatibility >= 5.0.0`.

## Why another Hikvision app?

Existing integrations typically *poll* the device for its event status. Polling
has two fundamental problems:

- **Delay** — an event is only noticed on the next poll cycle (seconds later).
- **Missed events** — a line crossing lasts well under a second; if it starts
  and ends between two polls, it is never seen at all.

This app instead keeps a **persistent connection to the device's ISAPI alert
stream** (`/ISAPI/Event/notification/alertStream`). The camera/NVR *pushes*
every event over that connection the moment it happens, so a Flow triggers with
sub-second latency and short-lived events are never lost. On top of that:

- A **watchdog** detects silently dead (half-open) TCP connections via the
  device's heartbeat and reconnects automatically — the classic cause of
  "events just stopped arriving some day".
- Automatic **reconnection with backoff** after network hiccups or device
  reboots; the device tile shows unavailable while the connection is down.
- One NVR = **one connection**, shared by all of its channel devices.
- **Digest authentication** (with Basic fallback) and optional HTTPS,
  implemented dependency-free.

## Devices

| Driver | Use for |
| --- | --- |
| **Camera** | An IP camera you connect to directly (by its own IP address). |
| **NVR / DVR camera (channel)** | A camera connected through a Hikvision NVR/DVR. During pairing the app lists all channels of the recorder; each channel becomes a Homey device. Events are routed by channel number (`dynChannelID`). |

Both device types expose the capabilities **Motion alarm**, **Smart event
alarm** (any VCA event: line crossing, intrusion, …) and **Tamper alarm**.

## Flow triggers

- Motion detected
- Line crossed
- Intrusion detected
- Region entered / Region exited
- **An event was received** — fires for *every* event type and carries tags
  `Event type`, `Channel` and `Description`, so you can react to anything the
  device reports (face detection, loitering, scene change, …).

## Device requirements

1. Enable the integration protocol: *Configuration → Network → Advanced
   Settings → Integration Protocol → Enable Hikvision-CGI / ISAPI*
   (on some firmware: enable *CGI* and set authentication to *digest*).
2. The account used must have permission for *Remote: Notify Surveillance
   Center / Alarm* (an admin account always works; a dedicated operator
   account is recommended).
3. Configure and arm the detections themselves (motion, line crossing,
   intrusion …) in the camera/NVR web interface, and make sure their schedule
   is active. The app receives whatever the device reports.

## Development

```bash
npm install
npm run build     # type-check / compile
npx homey app validate
npx homey app run # run on your Homey in development mode
```

Releases are handled by the GitHub Actions workflows (validate on push,
version + publish via *workflow dispatch*), the same setup as
[homey-aqara-t1](https://github.com/m-szopinski/homey-aqara-t1).

## License

GPL-3.0 — see [LICENSE](LICENSE).
