'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Languages, Loader2, Send } from 'lucide-react';
import { createChatPacket, SOSPacket } from '@/lib/sos-mesh/sosPacket';
import { COMMUNICATION_LANGUAGES, languageLabel } from '@/lib/languages';

interface AuthorityEmergencyChatProps {
  incidentId: string;
  touristName?: string;
  touristLanguage?: string;
}

export default function AuthorityEmergencyChat({ incidentId, touristName = 'Traveller', touristLanguage = 'en-IN' }: AuthorityEmergencyChatProps) {
  const [messages, setMessages] = useState<SOSPacket[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [outgoingLanguage, setOutgoingLanguage] = useState('en-IN');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translatingPacketId, setTranslatingPacketId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load the protected, server-persisted chat transcript.
  useEffect(() => {
    const fetchTranscript = async () => {
      try {
        const res = await fetch(`/api/chat-relay?incidentId=${encodeURIComponent(incidentId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.messages)) {
            setMessages(data.messages);
          }
        }
      } catch (e) {
        console.warn('[AuthorityEmergencyChat] Fetch transcript error:', e);
      }
    };

    void fetchTranscript();
    const interval = window.setInterval(fetchTranscript, 3000);

    return () => {
      window.clearInterval(interval);
    };
  }, [incidentId]);



  const handleSendResponse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;

    try {
      setSending(true);
      setTranslationError(null);
      let deliveredText = text.trim();
      if (outgoingLanguage !== touristLanguage) {
        const translationResponse = await fetch('/api/multilingual/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            incidentId,
            text: deliveredText,
            sourceLanguage: outgoingLanguage,
            targetLanguage: touristLanguage,
          }),
        });
        const translation = await translationResponse.json().catch(() => null);
        if (!translationResponse.ok || !translation?.success) throw new Error(translation?.error || 'Message translation could not be completed.');
        deliveredText = translation.translatedText;
      }
      const packet = createChatPacket({
        incidentId,
        touristId: 'POLICE-HQ',
        senderRole: 'authority',
        senderName: 'Authority desk',
        text: deliveredText,
        language: touristLanguage,
        ...(deliveredText !== text.trim() ? { originalText: text.trim(), originalLanguage: outgoingLanguage } : {}),
      });

      // 1. Post to Gateway API
      const res = await fetch('/api/chat-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packet }),
      });

      const result = await res.json().catch(() => null);
      if (res.ok && result?.success) {
        const authenticatedPacket = result.packet ?? packet;
        setMessages((prev) => [...prev, authenticatedPacket]);
        setText('');

      } else {
        throw new Error(result?.error || 'Failed to dispatch the translated response.');
      }
    } catch (err: any) {
      window.alert(err.message || 'Failed to dispatch chat response.');
    } finally {
      setSending(false);
    }
  };

  const translateIncoming = async (message: SOSPacket) => {
    if (!message.chatText || translations[message.packetId]) return;
    setTranslatingPacketId(message.packetId);
    setTranslationError(null);
    try {
      const response = await fetch('/api/multilingual/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          text: message.chatText,
          sourceLanguage: message.chatLanguage || touristLanguage,
          targetLanguage: 'en-IN',
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Message translation could not be completed.');
      setTranslations((current) => ({ ...current, [message.packetId]: result.translatedText }));
    } catch (error: any) {
      setTranslationError(error.message || 'Message translation could not be completed.');
    } finally {
      setTranslatingPacketId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Messages with {touristName}</h3>
        <span className="text-xs text-ink-soft">Traveller reads {languageLabel(touristLanguage)}</span>
      </div>

      <div className="max-h-64 min-h-[100px] space-y-3 overflow-y-auto rounded-xl border border-line bg-surface-2 p-3">
        {messages.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-soft">No messages yet.</p>
        ) : (
          messages.map((msg) => {
            const isAuthority = msg.senderRole === 'authority';
            const isVoice = msg.packetId?.startsWith('PKT-VOICE-') || msg.senderName?.includes('Voice SOS');
            return (
              <div key={msg.packetId} className={`flex flex-col ${isAuthority ? 'items-end' : 'items-start'}`}>
                <span className="mb-0.5 text-[10px] text-ink-soft">
                  {msg.senderName || (isAuthority ? 'Authority desk' : touristName)}{isVoice ? ' · voice SOS' : ''} · {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${isAuthority ? 'bg-ink text-white' : 'border border-line bg-surface'}`}>
                  {isAuthority && msg.originalText ? msg.originalText : msg.chatText}
                </div>
                {isAuthority && msg.originalText && (
                  <p className="mt-1 max-w-[85%] text-[10px] leading-4 text-ink-soft">Sent in {languageLabel(msg.chatLanguage)}: {msg.chatText}</p>
                )}
                {!isAuthority && translations[msg.packetId] && (
                  <p className="mt-1 max-w-[85%] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs leading-relaxed">
                    <span className="block text-[10px] text-ink-soft">English</span>
                    {translations[msg.packetId]}
                  </p>
                )}
                {!isAuthority && msg.chatText && !translations[msg.packetId] && !(msg.chatLanguage || touristLanguage).startsWith('en') && (
                  <button type="button" onClick={() => void translateIncoming(msg)} disabled={translatingPacketId === msg.packetId}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-ink-soft underline hover:text-ink disabled:opacity-50">
                    {translatingPacketId === msg.packetId ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />} Translate to English
                  </button>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {translationError && <p role="alert" className="text-xs text-danger">{translationError}</p>}

      <form onSubmit={handleSendResponse} className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Message ${touristName}…`}
            className="nb-input flex-1 text-sm"
          />
          <button type="submit" disabled={!text.trim() || sending} className="minimal-button minimal-button-primary">
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {outgoingLanguage === touristLanguage ? 'Send' : 'Translate & send'}
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          You write in
          <select value={outgoingLanguage} onChange={(event) => setOutgoingLanguage(event.target.value)} className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink">
            {COMMUNICATION_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
      </form>
    </div>
  );
}
