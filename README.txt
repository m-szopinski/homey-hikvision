Real-time events from Hikvision IP cameras, NVRs and DVRs.

Instead of polling, this app keeps a persistent connection to the device's ISAPI alert stream, so the camera pushes every event to Homey the moment it happens — motion, line crossing, intrusion, region entrance/exit, tamper, face detection and more trigger your Flows with sub-second latency, and short events are never missed.

Supports directly connected cameras as well as cameras behind an NVR/DVR (each recorder channel becomes its own Homey device, sharing a single connection to the recorder). The connection is monitored with a heartbeat watchdog and re-established automatically after network issues or device reboots.

On the device, enable the ISAPI/CGI integration protocol and arm the detections you want to use; the app receives whatever the device reports.
