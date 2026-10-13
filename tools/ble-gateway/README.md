# BLE relay gateway

An optional Linux / Raspberry Pi gateway that accepts an SOS over Bluetooth from a traveller's phone with no internet, stores it on disk, and uploads it to the authority desk once the gateway itself is online. Travellers with Wi-Fi or mobile data never need it.

Web Bluetooth only lets a browser act as a GATT client, so phones cannot relay to each other over Bluetooth; this gateway is the peripheral they write to.

## Run

```bash
cd tools/ble-gateway
npm install
PRAHARI_GATEWAY_ID=GW-JAIPUR-01 \
PRAHARI_API_BASE_URL=https://your-prahari-deployment.example \
PRAHARI_MESH_GATEWAY_KEY='same-secret-as-the-web-server' \
npm start
```

Set the same `PRAHARI_MESH_GATEWAY_KEY` on the web deployment. Never put it in browser code or the BLE payload. `npm test` covers the queue and framing logic without hardware.

In the app, the traveller opens **Offline options → Pair gateway** on the SOS card. A Bluetooth acknowledgement means the gateway saved the packet, not that the desk has it.

## Protocol

- Service UUID `5b0d0e1a-4f4e-4ef4-ae52-9f901d4c0101`, writable characteristic `5b0d0e1a-4f4e-4ef4-ae52-9f901d4c0102` (write with response).
- Each frame is `0x50 0x52 0x01 <frame-count> <frame-index> <up to 15 bytes of UTF-8 JSON>`, which fits the baseline 20-byte GATT write.
- The reassembled JSON is a version-1 `SOSPacket`. The gateway validates it, caps size and TTL, deduplicates by `packetId` and writes it to disk before acknowledging.
- On uplink it adds its own hop and POSTs the packet to `/api/sos-relay` with the header `X-Prahari-Mesh-Gateway-Key`. The server checks the signature, expiry, traveller and duplicate incident ID before recording it.
