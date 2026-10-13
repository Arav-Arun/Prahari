'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, Languages, Mic, Send, Square, Volume2, X } from 'lucide-react';
import {
  COMMUNICATION_LANGUAGES,
  INTERNATIONAL_TRAVELLER_LANGUAGES,
  isCommunicationLanguageCode,
  travellerLanguageLabel,
  type TravellerAssistanceLanguageCode,
} from '@/lib/languages';

type TravellerVoiceAssistantProps = {
  touristId: string | null;
  coords: { lat: number; lng: number } | null;
  preferredLanguage?: string | null;
  onUseInReport: (text: string) => void;
  onVoiceSos: (incident: any) => void;
  onClose: () => void;
};

type SpeechRecognitionLike = {
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function playWithDevice(text: string, language: string) {
  if (!('speechSynthesis' in window)) throw new Error('Speech playback is not supported by this browser.');
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}

export default function TravellerVoiceAssistant({ touristId, coords, preferredLanguage, onUseInReport, onVoiceSos, onClose }: TravellerVoiceAssistantProps) {
  const initialLanguage = isCommunicationLanguageCode(preferredLanguage) ? preferredLanguage : 'hi-IN';
  const [languageCode, setLanguageCode] = useState<TravellerAssistanceLanguageCode>(initialLanguage);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('Tap the microphone and speak.');
  const [transcript, setTranscript] = useState('');
  const [translation, setTranslation] = useState('');
  const [targetLanguage, setTargetLanguage] = useState<TravellerAssistanceLanguageCode>('en-IN');
  const [busy, setBusy] = useState<'transcribing' | 'translating' | 'sending' | 'speaking' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentIncident, setSentIncident] = useState<any | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const startBrowserRecognition = () => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) throw new Error('Live speech recognition is unavailable in this browser. Try a Chromium-based browser or type the report instead.');
    const recognition: SpeechRecognitionLike = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = languageCode;
    recognition.onstart = () => { setRecording(true); setStatus('Listening…'); };
    recognition.onresult = (event: any) => {
      const text = Array.from(event.results as any).map((result: any) => result?.[0]?.transcript || '').join(' ').trim();
      setTranscript(text);
      setTranslation('');
      setStatus('Done. Check the text below.');
    };
    recognition.onerror = (event: any) => setError(event?.error || 'Speech recognition failed.');
    recognition.onend = () => setRecording(false);
    recognition.start();
  };

  const start = async () => {
    setError(null);
    setTranscript('');
    setTranslation('');
    setSentIncident(null);
    if (!isCommunicationLanguageCode(languageCode)) {
      try { startBrowserRecognition(); } catch (cause: any) { setError(cause.message); }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstart = () => { setRecording(true); setStatus('Recording…'); };
      recorder.onstop = async () => {
        setRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (!audio.size) { setError('No audio was captured. Please try again.'); return; }
        setBusy('transcribing');
        setStatus('Transcribing…');
        try {
          const formData = new FormData();
          formData.append('file', audio, 'voice-emergency.webm');
          formData.append('language_code', languageCode);
          const response = await fetch('/api/sarvam/speech-to-text', { method: 'POST', body: formData });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.success || !data.transcript) throw new Error(data?.error || 'Speech could not be transcribed.');
          setTranscript(data.transcript);
          setStatus('Done. Check the text below.');
        } catch (cause: any) {
          setError(cause.message || 'Speech transcription could not be completed.');
        } finally { setBusy(null); }
      };
      recorder.start();
    } catch {
      try { startBrowserRecognition(); } catch (cause: any) { setError(cause.message || 'Microphone access is required.'); }
    }
  };

  const stop = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    try { recognitionRef.current?.stop(); } catch {}
    setRecording(false);
  };

  const speak = async (text: string, language: TravellerAssistanceLanguageCode) => {
    if (!text.trim()) return;
    setError(null);
    setBusy('speaking');
    try {
      if (isCommunicationLanguageCode(language)) {
        const response = await fetch('/api/sarvam/text-to-speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, languageCode: language }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || !data.audioBase64) throw new Error(data?.error || 'Sarvam speech playback could not be created.');
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const binary = atob(data.audioBase64);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        audioUrlRef.current = URL.createObjectURL(new Blob([bytes], { type: data.mimeType || 'audio/wav' }));
        await new Audio(audioUrlRef.current).play();
      } else {
        playWithDevice(text, language);
      }
    } catch (cause: any) {
      try {
        playWithDevice(text, language);
        setStatus('Using your device speech voice because the server voice was unavailable.');
      } catch {
        setError(cause.message || 'Speech playback could not start.');
      }
    } finally { setBusy(null); }
  };

  const translate = async () => {
    if (!transcript.trim()) return;
    setBusy('translating');
    setError(null);
    try {
      const response = await fetch('/api/traveller/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: transcript, sourceLanguage: languageCode, targetLanguage }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Translation could not be completed.');
      setTranslation(data.translatedText);
      setStatus('Translation ready.');
    } catch (cause: any) {
      setError(cause.message || 'Translation could not be completed.');
    } finally { setBusy(null); }
  };

  const resolveLocation = async () => {
    if (coords) return coords;
    try {
      const cached = localStorage.getItem('prahari_last_known_coords');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) return parsed;
      }
    } catch {}
    if (!navigator.geolocation) return null;
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 6_000 }));
      return { lat: position.coords.latitude, lng: position.coords.longitude };
    } catch { return null; }
  };

  const sendVoiceSos = async () => {
    if (!touristId || !transcript.trim()) return;
    setBusy('sending');
    setError(null);
    try {
      const location = await resolveLocation();
      if (!location) throw new Error('A current or last-known location is required to send a voice SOS. Enable location, then try again.');
      const response = await fetch('/api/incidents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touristId, type: 'VOICE_SOS', severity: 'CRITICAL', status: 'ACTIVE', transportType: 'INTERNET', location, voiceStatement: transcript, voiceStatementLanguage: languageCode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success || !data.incident) throw new Error(data?.error || 'Voice SOS could not be sent.');
      setSentIncident(data.incident);
      onVoiceSos(data.incident);
      setStatus('Voice SOS sent to the authority desk.');
    } catch (cause: any) {
      setError(cause.message || 'Voice SOS could not be sent.');
    } finally { setBusy(null); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="voice-assistant-title">
      <div className="modal-frame">
        <div className="modal-panel max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="voice-assistant-title" className="ui-display text-2xl">Voice help</h2>
            <p className="mt-1 text-sm leading-5 text-ink-soft">Speak in your language. Check the text before you send it.</p>
          </div>
          <button onClick={onClose} className="minimal-button minimal-button-secondary px-2.5" aria-label="Close"><X className="size-4" /></button>
        </div>

        <label className="mt-5 block text-sm font-medium">Language
          <select value={languageCode} disabled={recording || Boolean(busy)} onChange={(event) => { setLanguageCode(event.target.value as TravellerAssistanceLanguageCode); setTranscript(''); setTranslation(''); }} className="nb-input mt-1.5 text-sm">
            <optgroup label="Indian languages and English">{COMMUNICATION_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</optgroup>
            <optgroup label="Other languages (uses your browser's speech)">{INTERNATIONAL_TRAVELLER_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</optgroup>
          </select>
        </label>

        <section className="mt-4 rounded-xl border border-line bg-surface-2 p-6 text-center">
          <button onClick={recording ? stop : start} disabled={Boolean(busy)} className={`mx-auto flex size-24 items-center justify-center rounded-full text-white transition disabled:opacity-60 ${recording ? 'bg-ink' : 'bg-danger hover:bg-red-800'}`} aria-label={recording ? 'Stop recording' : 'Start recording'}>
            {recording ? <Square className="size-8 fill-current" /> : <Mic className="size-9" />}
          </button>
          <p className="mt-4 text-sm font-medium">{busy === 'transcribing' ? 'Transcribing…' : recording ? 'Recording — tap to stop' : status}</p>
        </section>

        {error && <p role="alert" className="mt-4 flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}

        {transcript && <section className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">What you said</h3>
            <button onClick={() => speak(transcript, languageCode)} disabled={Boolean(busy)} className="minimal-button minimal-button-secondary text-xs"><Volume2 className="size-4" /> Listen</button>
          </div>
          <textarea value={transcript} onChange={(event) => { setTranscript(event.target.value.slice(0, 2_000)); setTranslation(''); }} maxLength={2_000} rows={4} className="nb-input text-sm leading-6" aria-label="Review or correct the transcript" />
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as TravellerAssistanceLanguageCode)} className="nb-input text-sm">{[...COMMUNICATION_LANGUAGES, ...INTERNATIONAL_TRAVELLER_LANGUAGES].map((language) => <option key={language.code} value={language.code}>Translate to {language.label}</option>)}</select>
            <button onClick={translate} disabled={Boolean(busy)} className="minimal-button minimal-button-secondary"><Languages className="size-4" /> {busy === 'translating' ? 'Translating…' : 'Translate'}</button>
          </div>
          {translation && <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm leading-6"><div className="mb-2 flex items-center justify-between gap-2"><strong>{travellerLanguageLabel(targetLanguage)}</strong><button onClick={() => speak(translation, targetLanguage)} disabled={Boolean(busy)} className="text-xs font-semibold underline"><Volume2 className="mr-1 inline size-3.5" />Play</button></div>{translation}</div>}
          <div className="grid gap-2 sm:grid-cols-2">
            <button onClick={() => onUseInReport(transcript)} className="minimal-button minimal-button-secondary">Use in a report</button>
            <button onClick={sendVoiceSos} disabled={Boolean(busy) || Boolean(sentIncident)} className="minimal-button minimal-button-danger"><Send className="size-4" /> {busy === 'sending' ? 'Sending…' : sentIncident ? 'Voice SOS sent' : 'Send as voice SOS'}</button>
          </div>
          <p className="text-xs leading-5 text-ink-soft">A voice SOS sends these words and your location to the authority desk. Call <a href="tel:112" className="font-semibold text-ink">112</a> if you are in immediate danger.</p>
        </section>}
      </div>
    </div>
  </div>
);
}
