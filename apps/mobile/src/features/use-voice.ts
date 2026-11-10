/**
 * Listening for quick add (TXN-07) on the phone's speech service (Google's on Android, Apple's on iOS). Montra
 * keeps no audio: only the words come back, into the sentence box.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { currentLocale } from '../i18n';
import { speechLang, voiceErrorKey, withHeard } from './voice';

export interface Voice {
  listening: boolean;
  /** A message key to show, or null. */
  errorKey: string | null;
  /** The recognizer's own words for an unexpected error. */
  errorDetail: string | null;
  /** Starts listening; what's heard is added after `before`. */
  start(before: string): Promise<void>;
  stop(): void;
  /** Stops without a result (leaving the screen). */
  cancel(): void;
}

export function useVoice(onText: (text: string) => void): Voice {
  const [listening, setListening] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const before = useRef('');
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useSpeechRecognitionEvent('result', (e) => {
    const heard = e.results[0]?.transcript ?? '';
    onTextRef.current(withHeard(before.current, heard));
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('nomatch', () => setErrorKey(voiceErrorKey('nomatch')));
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    setErrorKey(voiceErrorKey(e.error));
    setErrorDetail(e.message || e.error);
  });

  const start = useCallback(async (text: string) => {
    setErrorKey(null);
    setErrorDetail(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setErrorKey('mobile.capture.voice_unavailable');
        return;
      }
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setErrorKey('mobile.capture.voice_denied');
        return;
      }
      before.current = text;
      ExpoSpeechRecognitionModule.start({
        lang: speechLang(currentLocale),
        interimResults: true,
        continuous: false,
        // Not forcing on-device: Android then fails ("language not supported") when the offline language pack
        // isn't downloaded. The phone's speech service picks, and may use the network.
      });
      setListening(true);
    } catch (e) {
      setListening(false);
      setErrorKey('mobile.capture.voice_failed');
      setErrorDetail((e as Error).message);
    }
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);
  const cancel = useCallback(() => {
    ExpoSpeechRecognitionModule.abort();
    setListening(false);
    setErrorKey(null);
  }, []);

  // Never leave the microphone on behind the screen.
  useEffect(() => () => ExpoSpeechRecognitionModule.abort(), []);

  return { listening, errorKey, errorDetail, start, stop, cancel };
}
