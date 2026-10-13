'use client';

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import QRCode from 'qrcode';
import { QrCode, Link as LinkIcon } from 'lucide-react';
import { globalWebRtcTransport, PeerMeshInfo } from '@/lib/sos-mesh/transports/webRtcTransport';

export default function PeerMeshConnect() {
  const [peers, setPeers] = useState<PeerMeshInfo[]>([]);
  const [mode, setMode] = useState<'IDLE' | 'HOST' | 'JOIN'>('IDLE');
  const [offerCode, setOfferCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [offerInput, setOfferInput] = useState('');
  const [answerOutput, setAnswerOutput] = useState('');
  const [activePeerId, setActivePeerId] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    const unsub = globalWebRtcTransport.subscribePeers((updated: PeerMeshInfo[]) => {
      setPeers(updated);
    });
    return () => unsub();
  }, []);

  const handleStartHost = async () => {
    try {
      setMode('HOST');
      setStatusMsg('Creating a pairing code…');
      const { offerSdp, peerId } = await globalWebRtcTransport.createOffer();
      setOfferCode(offerSdp);
      setActivePeerId(peerId);

      const url = await QRCode.toDataURL(offerSdp, { margin: 2, width: 200, color: { dark: '#1d1c1a', light: '#ffffff' } });
      setQrDataUrl(url);
      setStatusMsg('Show this code to the other phone, then paste its reply below.');
    } catch (err: any) {
      setStatusMsg(`Could not create a pairing code: ${err.message}`);
    }
  };

  const handleCompleteHostHandshake = async () => {
    if (!answerInput.trim() || !activePeerId) return;
    try {
      const ok = await globalWebRtcTransport.completeHandshake(activePeerId, answerInput.trim());
      if (ok) {
        setStatusMsg('Paired.');
        setMode('IDLE');
      } else {
        setStatusMsg('Pairing failed. Check the reply code and try again.');
      }
    } catch (err: any) {
      setStatusMsg(`Error: ${err.message}`);
    }
  };

  const handleJoinMesh = async () => {
    if (!offerInput.trim()) return;
    try {
      setStatusMsg('Reading pairing code…');
      const { answerSdp, peerId } = await globalWebRtcTransport.acceptOffer(offerInput.trim());
      setAnswerOutput(answerSdp);
      setActivePeerId(peerId);
      setStatusMsg('Copy this reply back to the first phone.');
    } catch (err: any) {
      setStatusMsg(`That pairing code is not valid: ${err.message}`);
    }
  };

  const connectedCount = peers.filter((p) => p.status === 'CONNECTED').length;

  return (
    <div className="space-y-3 text-sm text-ink">
      <p className="text-xs text-ink-soft">
        {connectedCount > 0 ? `${connectedCount} nearby device${connectedCount === 1 ? '' : 's'} paired` : 'No devices paired'}
        {statusMsg && mode === 'IDLE' ? ` · ${statusMsg}` : ''}
      </p>

      {mode === 'IDLE' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={handleStartHost} className="minimal-button minimal-button-secondary text-xs">
            <QrCode className="size-3.5" /> Show pairing code
          </button>
          <button type="button" onClick={() => { setStatusMsg(''); setMode('JOIN'); }} className="minimal-button minimal-button-secondary text-xs">
            <LinkIcon className="size-3.5" /> Enter a code
          </button>
        </div>
      )}

      {mode === 'HOST' && (
        <div className="space-y-3">
          <p>{statusMsg}</p>
          {qrDataUrl && (
            <Image src={qrDataUrl} alt="Pairing QR code" width={160} height={160} unoptimized className="mx-auto rounded-lg border border-line bg-white p-1" />
          )}
          <textarea readOnly value={offerCode} aria-label="Pairing code" className="nb-input h-12 font-mono text-[10px]" />
          <input
            type="text"
            value={answerInput}
            onChange={(e) => setAnswerInput(e.target.value)}
            placeholder="Paste the reply from the other phone"
            className="nb-input font-mono text-xs"
          />
          <div className="flex gap-2">
            <button type="button" onClick={handleCompleteHostHandshake} className="minimal-button minimal-button-primary flex-1 text-xs">Pair</button>
            <button type="button" onClick={() => setMode('IDLE')} className="minimal-button minimal-button-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {mode === 'JOIN' && (
        <div className="space-y-3">
          {statusMsg && <p>{statusMsg}</p>}
          <textarea
            value={offerInput}
            onChange={(e) => setOfferInput(e.target.value)}
            placeholder="Paste the pairing code from the other phone"
            className="nb-input h-14 font-mono text-[10px]"
          />
          <button type="button" onClick={handleJoinMesh} className="minimal-button minimal-button-primary w-full text-xs">Create reply</button>
          {answerOutput && (
            <textarea readOnly value={answerOutput} aria-label="Reply code" className="nb-input h-12 font-mono text-[10px]" />
          )}
          <button type="button" onClick={() => setMode('IDLE')} className="minimal-button minimal-button-secondary w-full text-xs">Back</button>
        </div>
      )}
    </div>
  );
}
