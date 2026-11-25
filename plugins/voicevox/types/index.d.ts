// voicevox keeps one $.state value of its own (isOn). It reads plamo-ja's, which plamo-ja's contract declares; this is a
// copy of that part, so voicevox type-checks without plamo-ja installed (it works without it, too).
export type PlamoSpeech = {
  id: number
  at: number
  text: string
  isWhole: boolean
  isRestart?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    voicevox: {
      /** Reading aloud is on: kept for the session, so a reload (a settings change) keeps it */
      isOn: boolean
      /** Something is queued or playing: the stop button above the prompt shows while it is */
      isSpeaking: boolean
    }
    'plamo-ja': {
      mode: 'off' | 'on' | 'on-input'
      speech: PlamoSpeech
    }
  }
}
