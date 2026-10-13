/**
 * Offline SOS IndexedDB queue and duplicate-prevention store.
 * 
 * Ensures emergency SOS packets survive page refreshes, tab closures, and browser restarts.
 * Also stores seen packet IDs for duplicate prevention across relay attempts.
 */

import { SOSPacket, isValidSOSPacket, isPacketExpired } from './sosPacket';

// Keep the existing on-device database name so any already queued SOS is not
// stranded by this terminology change.
const DB_NAME = 'Prahari_SOS_Mesh_DB';
const DB_VERSION = 2;
const PACKET_STORE = 'sos_packets';
const DEDUP_STORE = 'seen_packet_ids';
const CHAT_STORE = 'chat_messages';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memoryChatMessages: SOSPacket[] = [];

function getDB(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!('indexedDB' in window)) {
    console.warn('[SOSQueue] IndexedDB not available, fallback to memory/localStorage.');
    return Promise.resolve(null);
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(PACKET_STORE)) {
            const store = db.createObjectStore(PACKET_STORE, { keyPath: 'packetId' });
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
          if (!db.objectStoreNames.contains(DEDUP_STORE)) {
            db.createObjectStore(DEDUP_STORE, { keyPath: 'packetId' });
          }
          if (!db.objectStoreNames.contains(CHAT_STORE)) {
            const chatStore = db.createObjectStore(CHAT_STORE, { keyPath: 'packetId' });
            chatStore.createIndex('incidentId', 'incidentId', { unique: false });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = (err) => {
          console.error('[SOSQueue] IndexedDB open error:', err);
          resolve(null);
        };
      } catch (err) {
        console.error('[SOSQueue] IndexedDB exception:', err);
        resolve(null);
      }
    });
  }
  return dbPromise;
}

interface QueuedPacketRecord {
  packetId: string;
  packet: SOSPacket;
  status: 'QUEUED' | 'RELAYED' | 'DELIVERED' | 'EXPIRED' | 'CANCELLED';
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

// Fallback in-memory map for non-browser/SSR environments
const memoryQueue = new Map<string, QueuedPacketRecord>();
const memorySeenPackets = new Set<string>();

/**
 * Saves a packet into local persistent queue.
 */
export async function saveQueuedPacket(
  packet: SOSPacket,
  status: QueuedPacketRecord['status'] = 'QUEUED'
): Promise<boolean> {
  const record: QueuedPacketRecord = {
    packetId: packet.packetId,
    packet,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
  };

  memoryQueue.set(packet.packetId, record);
  await markPacketAsSeen(packet.packetId);

  const db = await getDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PACKET_STORE, 'readwrite');
      const store = tx.objectStore(PACKET_STORE);
      store.put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Updates status of a queued packet.
 */
export async function updateQueuedPacketStatus(
  packetId: string,
  status: QueuedPacketRecord['status'],
  lastError?: string
): Promise<boolean> {
  const mem = memoryQueue.get(packetId);
  if (mem) {
    mem.status = status;
    mem.updatedAt = Date.now();
    mem.lastAttemptAt = Date.now();
    if (lastError) mem.lastError = lastError;
  }

  const db = await getDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PACKET_STORE, 'readwrite');
      const store = tx.objectStore(PACKET_STORE);
      const getReq = store.get(packetId);
      getReq.onsuccess = () => {
        const existing: QueuedPacketRecord | undefined = getReq.result;
        if (existing) {
          existing.status = status;
          existing.updatedAt = Date.now();
          existing.lastAttemptAt = Date.now();
          existing.retryCount += 1;
          if (lastError) existing.lastError = lastError;
          store.put(existing);
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Retrieves all pending packets awaiting upload/relay.
 */
export async function getPendingQueuedPackets(): Promise<QueuedPacketRecord[]> {
  const db = await getDB();
  if (!db) {
    return Array.from(memoryQueue.values()).filter(
      (r) => (r.status === 'QUEUED' || r.status === 'RELAYED') && !isPacketExpired(r.packet)
    );
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PACKET_STORE, 'readonly');
      const store = tx.objectStore(PACKET_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const records: QueuedPacketRecord[] = req.result || [];
        const valid = records.filter(
          (r) => (r.status === 'QUEUED' || r.status === 'RELAYED') && !isPacketExpired(r.packet)
        );
        resolve(valid);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Retrieves all queued packets (for UI monitoring).
 */
export async function getAllQueuedPackets(): Promise<QueuedPacketRecord[]> {
  const db = await getDB();
  if (!db) {
    return Array.from(memoryQueue.values());
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PACKET_STORE, 'readonly');
      const store = tx.objectStore(PACKET_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Duplicate Prevention: Check if packet ID or Nostr event ID has been seen previously.
 */
export async function hasSeenPacket(packetId: string, nostrId?: string): Promise<boolean> {
  if (memorySeenPackets.has(packetId) || (nostrId && memorySeenPackets.has(nostrId))) return true;

  const db = await getDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DEDUP_STORE, 'readonly');
      const store = tx.objectStore(DEDUP_STORE);
      const req = store.get(packetId);
      req.onsuccess = () => {
        const exists = Boolean(req.result);
        if (exists) {
          memorySeenPackets.add(packetId);
          if (nostrId) memorySeenPackets.add(nostrId);
          resolve(true);
        } else if (nostrId) {
          const req2 = store.get(nostrId);
          req2.onsuccess = () => {
            const exists2 = Boolean(req2.result);
            if (exists2) {
              memorySeenPackets.add(packetId);
              memorySeenPackets.add(nostrId);
            }
            resolve(exists2);
          };
          req2.onerror = () => resolve(false);
        } else {
          resolve(false);
        }
      };
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Duplicate Prevention: Mark packet ID and Nostr event ID as seen.
 */
export async function markPacketAsSeen(packetId: string, nostrId?: string): Promise<void> {
  memorySeenPackets.add(packetId);
  if (nostrId) memorySeenPackets.add(nostrId);

  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(DEDUP_STORE, 'readwrite');
    const store = tx.objectStore(DEDUP_STORE);
    store.put({ packetId, seenAt: Date.now() });
    if (nostrId && nostrId !== packetId) {
      store.put({ packetId: nostrId, seenAt: Date.now() });
    }
  } catch (err) {
    console.warn('[SOSQueue] markPacketAsSeen error:', err);
  }
}

/**
 * Removes a packet from local storage upon user cancellation or resolved status.
 */
export async function removeQueuedPacket(packetId: string): Promise<boolean> {
  memoryQueue.delete(packetId);
  const db = await getDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PACKET_STORE, 'readwrite');
      const store = tx.objectStore(PACKET_STORE);
      store.delete(packetId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Persists an emergency chat packet in local IndexedDB while it awaits sync.
 */
export async function saveChatMessage(packet: SOSPacket): Promise<boolean> {
  const existingIdx = memoryChatMessages.findIndex((m) => m.packetId === packet.packetId);
  if (existingIdx >= 0) {
    memoryChatMessages[existingIdx] = packet;
  } else {
    memoryChatMessages.push(packet);
  }

  const db = await getDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CHAT_STORE, 'readwrite');
      const store = tx.objectStore(CHAT_STORE);
      store.put(packet);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Retrieves stored emergency chat messages for an incident.
 */
export async function getChatMessagesForIncident(incidentId: string): Promise<SOSPacket[]> {
  const memList = memoryChatMessages.filter((m) => m.incidentId === incidentId);
  const db = await getDB();
  if (!db) return memList.sort((a, b) => a.timestamp - b.timestamp);

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CHAT_STORE, 'readonly');
      const store = tx.objectStore(CHAT_STORE);
      const index = store.index('incidentId');
      const req = index.getAll(incidentId);

      req.onsuccess = () => {
        const dbItems: SOSPacket[] = req.result || [];
        const combinedMap = new Map<string, SOSPacket>();
        for (const item of memList) combinedMap.set(item.packetId, item);
        for (const item of dbItems) combinedMap.set(item.packetId, item);
        const sorted = Array.from(combinedMap.values()).sort((a, b) => a.timestamp - b.timestamp);
        resolve(sorted);
      };
      req.onerror = () => resolve(memList.sort((a, b) => a.timestamp - b.timestamp));
    } catch {
      resolve(memList.sort((a, b) => a.timestamp - b.timestamp));
    }
  });
}
