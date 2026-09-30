# Signaling protocol v1

Clients connect to `/signal` with a WebSocket and send JSON objects containing `protocol: 1`.
The service stores room lifecycle and membership only. SDP and ICE messages are relayed transiently and are never persisted. Playback synchronization belongs on the WebRTC DataChannel and is not accepted by this protocol.

## Client messages

```json
{"protocol":1,"type":"create","name":"Host","media":{"mediaType":"movie","tmdbId":42}}
{"protocol":1,"type":"create","name":"Host","media":{"mediaType":"movie","tmdbId":42},"mode":"host-stream","capabilities":["host-stream-v1"]}
{"protocol":1,"type":"join","name":"Guest","code":"ABC234","capabilities":["host-stream-v1"]}
{"protocol":1,"type":"resume","code":"ABC234","participantId":"uuid","reconnectToken":"opaque-token","capabilities":["host-stream-v1"]}
{"protocol":1,"type":"relay","targetId":"uuid","kind":"offer","payload":{"type":"offer","sdp":"..."}}
{"protocol":1,"type":"relay","targetId":"uuid","kind":"answer","payload":{"type":"answer","sdp":"..."}}
{"protocol":1,"type":"relay","targetId":"uuid","kind":"ice","payload":{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}}
{"protocol":1,"type":"change-media","media":{"mediaType":"tv","tmdbId":99,"seasonNumber":2,"episodeNumber":4}}
{"protocol":1,"type":"leave"}
```

TMDB identity is low-frequency room metadata, not a playback source. The service accepts only `movie` or `tv`, numeric TMDB IDs, and season/episode numbers for TV.

Room mode defaults to `independent` when omitted, preserving existing clients and stored rooms. `host-stream` creation requires the `host-stream-v1` capability. Joining or resuming a host-stream room also requires that capability; older clients receive `UPGRADE_REQUIRED`. The service stores and returns the mode as room lifecycle metadata. It never receives media bytes.

## Server messages

- `room`: assigned room, participant identity, host designation, reconnect token, roster, and expiry.
- `roster`: public participant IDs, names, roles, and connected state.
- `peer-joined` / `peer-left`: host peer-negotiation notifications.
- `signal`: transient `offer`, `answer`, or `ice` payload from another participant.
- `media-changed`: updated TMDB identity.
- `room-closed`: room closure reason.
- `error`: stable error code and a human-readable message.

Signaling follows a star topology: the host may relay only to guests, and each guest may relay only to the host. Rooms contain at most eight participants. Explicit host departure closes the room; unexpected disconnects have a 15-second resume window. Rooms expire after 12 hours.

Messages are limited to 64 KiB. Unknown fields, source URLs, magnets, filenames, torrent/debrid/provider details, credentials, API keys, and session/file identifiers are rejected. The service never accepts playback position, play, pause, seek, buffering, or heartbeat state.
