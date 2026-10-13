'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Send, Wifi, WifiOff } from 'lucide-react';
import { createChatPacket, SOSPacket } from '@/lib/sos-mesh/sosPacket';
import { saveChatMessage, getChatMessagesForIncident } from '@/lib/sos-mesh/indexedDbQueue';
import { COMMUNICATION_LANGUAGES, languageLabel } from '@/lib/languages';

interface OfflineEmergencyChatProps {
  incidentId: string;
  touristId: string;
  touristName?: string;
  latitude?: number;
  longitude?: number;
}

export default function OfflineEmergencyChat({
  incidentId,
  touristId,
  touristName = 'Tourist',
  latitude,
  longitude,
}: OfflineEmergencyChatProps) {
  const [messages, setMessages] = useState<SOSPacket[]>([]);
  const [text, setText] = useState('');
  const [messageLanguage, setMessageLanguage] = useState('en-IN');
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Monitor network status
  useEffect(() => {
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load locally retained messages. The server transcript is fetched separately
  // when online; local messages remain visibly pending until that succeeds.
  useEffect(() => {
    void (async () => {
      const stored = await getChatMessagesForIncident(incidentId);
      setMessages(stored);
    })();

    let syncing = false;
    const sync = async () => {
      if (syncing || !navigator.onLine) return;
      syncing = true;
      try {
        const locallyQueued = await getChatMessagesForIncident(incidentId);
        for (const packet of locallyQueued.filter((message) => message.senderRole === 'tourist' && message.lastKnownTransport !== 'INTERNET')) {
          const delivery = await fetch('/api/chat-relay', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packet }),
          }).catch(() => null);
          const delivered = delivery ? await delivery.json().catch(() => null) : null;
          if (delivery?.ok && delivered?.success && delivered.packet) void saveChatMessage(delivered.packet);
        }
        const res = await fetch(`/api/chat-relay?incidentId=${encodeURIComponent(incidentId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.messages)) {
            for (const msg of data.messages) {
              void saveChatMessage(msg);
            }
            setMessages((prev) => {
              const combinedMap = new Map<string, SOSPacket>();
              for (const m of prev) combinedMap.set(m.packetId, m);
              for (const m of data.messages) combinedMap.set(m.packetId, m);
              return Array.from(combinedMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            });
          }
        }
      } catch {
        // The locally retained message remains pending for the next connection.
      } finally {
        syncing = false;
      }
    };

    void sync();
    const syncInterval = window.setInterval(() => void sync(), 4_000);

    return () => {
      window.clearInterval(syncInterval);
    };
  }, [incidentId]);



  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const packet = createChatPacket({
      incidentId,
      touristId,
      senderRole: 'tourist',
      senderName: touristName,
      text: text.trim(),
      language: messageLanguage,
      latitude,
      longitude,
    });

    // Persist first; a failed delivery remains locally queued for a later
    // authenticated connection.
    await saveChatMessage(packet);
    setMessages((prev) => [...prev, packet]);
    setText('');

    try {
      const response = await fetch('/api/chat-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packet }),
      });
      const delivered = await response.json().catch(() => null);
      if (response.ok && delivered?.success && delivered.packet) {
        await saveChatMessage(delivered.packet);
        setMessages((current) => current.map((message) => message.packetId === packet.packetId ? delivered.packet : message));
      }
    } catch {
      // Retained locally and retried by the online sync loop.
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Messages with the authority desk</h3>
        <span className="flex items-center gap-1 text-xs text-ink-soft">
          {isOnline ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5 text-warning" />}
          {isOnline ? 'Online' : 'Offline — messages will send later'}
        </span>
      </div>

      <div className="mt-3 max-h-56 min-h-[100px] space-y-3 overflow-y-auto rounded-lg bg-surface-2 p-3">
        {messages.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-soft">No messages yet.</p>
        ) : (
          messages.map((msg) => {
            const isTourist = msg.senderRole === 'tourist';
            return (
              <div key={msg.packetId} className={`flex flex-col ${isTourist ? 'items-end' : 'items-start'}`}>
                <span className="mb-0.5 text-[10px] text-ink-soft">
                  {isTourist ? 'You' : msg.senderName || 'Authority desk'} · {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {isTourist && msg.lastKnownTransport !== 'INTERNET' ? ' · pending' : ''}
                </span>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${isTourist ? 'bg-ink text-white' : 'border border-line bg-surface'}`}>
                  {msg.chatText}
                </div>
                {msg.senderRole === 'authority' && msg.originalText && (
                  <p className="mt-1 max-w-[85%] text-[10px] leading-4 text-ink-soft">Original ({languageLabel(msg.originalLanguage)}): {msg.originalText}</p>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a message…"
            className="nb-input flex-1 text-sm"
          />
          <button type="submit" disabled={!text.trim()} className="minimal-button minimal-button-primary">
            <Send className="size-4" /> Send
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          Writing in
          <select value={messageLanguage} onChange={(event) => setMessageLanguage(event.target.value)} className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink">
            {COMMUNICATION_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
      </form>
    </div>
  );
}
