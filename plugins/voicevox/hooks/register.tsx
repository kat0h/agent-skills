import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { CHARACTERS } from './characters'

type Config = { url: string; speed: string; start: string; play: string }

// One utterance is at most this many characters. The engine's memory grows much faster than the text
// (about 0.35 GB at 100 chars, 1.4 GB at 300, over 20 GB at 1200, where the OOM killer ends it), and
// past about 4800 chars audio_query itself fails, so long replies are spoken in pieces, one after another.
const MAX_CHARS = 120

const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/
const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*\|?\s*:?-{3,}/ // a table's divider or a horizontal rule
const BOUNDARY = /[。！？!?\n]/g
const SENTENCE = /[^。！？!?]*[。！？!?]+|[^。！？!?]+$/g

// What plamo-ja publishes while it translates a fresh reply (see plamo-ja's types): read when it is on.
const PLAMO_MODE = { plugin: 'plamo-ja', key: 'mode' } as const

// Reading aloud is on or off for the session; kept in $.state so a reload (a settings change) keeps it.
const IS_ON = { plugin: 'voicevox', key: 'isOn' } as const

// Something is queued, being synthesized or playing: the band's stop button shows while it is.
const IS_SPEAKING = atom({ plugin: 'voicevox', key: 'isSpeaking' } as const, false)

let isOn = false
let isSpeaking = false
let speaker = '3' // VOICEVOX style id; kept in $.store
let speakerName: string | undefined // "ずんだもん (ノーマル)", as /speakers names the style; kept in $.store
let starting: Promise<boolean> | undefined // the engine being started by startCommand
const queue: string[] = [] // sentences not yet synthesized
let epoch = 0 // bumped by stop, so audio made before the stop is not played
let stoppedAt = 0 // plamo-ja replies queued before this are not spoken
let hasWarned = false
let speakingPid: string | undefined // the clip playing now, as its first line of output named it

// Synthesized clips, in order: the one playing (or next to play) first. While one plays the next is
// synthesized, so each clip starts the moment the one before ends, with no gap for the engine to work.
// At most AHEAD wait at once, and the engine makes one at a time (synthTail), for its memory's sake.
type Clip = { epoch: number; text: string; wav: Promise<string | undefined> }
const AHEAD = 2
const clips: Clip[] = []
let synthTail: Promise<unknown> = Promise.resolve()
let isPlaying = false

// Synthesizes one clip into a temporary WAV file and prints its path. The text goes in the POST body's
// urlencoded form via --get, as audio_query takes it in the query string.
const SYNTH_SH = `
url=$1 speaker=$2 text=$3 speed=$4
q=$(curl -sSf -X POST --get --data-urlencode "text=$text" "$url/audio_query?speaker=$speaker") || exit 3
q=$(printf '%s' "$q" | sed -E "s/\\"speedScale\\":[0-9.eE+-]+/\\"speedScale\\":$speed/")
f=$(mktemp --tmpdir voicevox-XXXXXX.wav) || exit 4
curl -sSf -H 'Content-Type: application/json' -d "$q" "$url/synthesis?speaker=$speaker" -o "$f" || { rm -f "$f"; exit 5; }
printf '%s\\n' "$f"
`

// Plays one clip with the playCommand ($2), which reads the WAV on stdin. The file is opened and then removed,
// so it is gone once the player closes it, killed or not. The shell prints its PID, then becomes the player
// (exec keeps the PID), so killing that PID stops the sound.
const PLAY_SH = `
exec 3< "$1" && rm -f "$1" || exit 3
echo $$
exec 0<&3 3<&-
eval "exec $2"
`

function kill($: EngineInterface, pid: string): void {
  void $.process.run(['kill', pid]).catch(() => undefined)
}

function discard($: EngineInterface, wav: string | undefined): void {
  if (wav) void $.process.run(['rm', '-f', wav]).catch(() => undefined)
}

function warn($: EngineInterface, config: Config, what: string, text: string, e: unknown): void {
  const reason = e instanceof Error ? e.message : String(e)
  $.ui.log(`voicevox: ${what} failed (${text.length} chars): ${reason}`, { to: 'debug' })
  if (!hasWarned) {
    hasWarned = true
    $.ui.toast(`⚠ VOICEVOX で読み上げられませんでした (${reason})。${config.url} を確認してください`)
  }
}

function setSpeaking($: EngineInterface, value: boolean): void {
  if (isSpeaking === value) return
  isSpeaking = value
  void update($, IS_SPEAKING, () => value).catch(() => undefined)
}

/**
 * Empties the queue, drops the clips made ahead and kills the one playing now. The readers are kept: a
 * reader from before the stop goes on following its text silently (its epoch is old), so the rest of a
 * block being streamed is not spoken, nor read again from its start; a new block or step is spoken.
 */
function stop($: EngineInterface): void {
  queue.length = 0
  epoch++
  stoppedAt = Date.now()
  setSpeaking($, false)
  for (const clip of clips.splice(0)) void clip.wav.then(wav => discard($, wav))
  if (speakingPid !== undefined) kill($, speakingPid)
  speakingPid = undefined
}

/** Splits `text` into pieces of at most MAX_CHARS, at sentence ends, else at 、 or spaces, else anywhere. */
function chunks(text: string): string[] {
  const out: string[] = []
  for (let s of text.match(SENTENCE) ?? []) {
    while (s.length > MAX_CHARS) {
      const head = s.slice(0, MAX_CHARS)
      const cut = Math.max(head.lastIndexOf('、'), head.lastIndexOf(' '), head.lastIndexOf('，'))
      const end = cut > MAX_CHARS / 3 ? cut + 1 : MAX_CHARS
      out.push(s.slice(0, end))
      s = s.slice(end)
    }
    if (s.trim()) out.push(s)
  }
  return out
}

/** Adds `text` to the end of the one speech queue, sentence by sentence. */
function say($: EngineInterface, config: Config, text: string): void {
  if (!isOn || !text.trim()) return
  queue.push(...chunks(text))
  pump($, config)
}

async function synthesize($: EngineInterface, config: Config, text: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['bash', '-c', SYNTH_SH, 'voicevox-synth', config.url, speaker, text, config.speed],
      { timeoutMs: 120_000 },
    )
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
    return stdout.trim() || undefined
  } catch (e) {
    warn($, config, 'synthesis', text, e)
    return undefined
  }
}

/**
 * Starts making clips of the waiting sentences, up to AHEAD ahead, then makes sure they are played.
 * Sentences waiting together are joined, up to MAX_CHARS, into one clip.
 */
function pump($: EngineInterface, config: Config): void {
  while (queue.length > 0 && clips.length < AHEAD) {
    let text = queue.shift()!
    while (queue.length > 0 && text.length + queue[0]!.length <= MAX_CHARS) text += queue.shift()!
    const mine = epoch
    const wav = synthTail.then(async () => {
      if (starting) await starting // made once the engine being started answers
      return mine === epoch ? synthesize($, config, text) : undefined
    })
    synthTail = wav
    clips.push({ epoch: mine, text, wav })
    setSpeaking($, true)
  }
  void play($, config)
}

/** Plays the clips in order, each as soon as it is made and the one before has ended. */
async function play($: EngineInterface, config: Config): Promise<void> {
  if (isPlaying) return
  isPlaying = true
  try {
    while (clips.length > 0) {
      const clip = clips[0]!
      const wav = await clip.wav
      if (clips[0] === clip) clips.shift()
      if (clip.epoch !== epoch) {
        discard($, wav)
        continue
      }
      pump($, config) // a place is free: make the next clip while this one plays
      if (wav) await playClip($, config, clip, wav)
    }
  } finally {
    isPlaying = false
    speakingPid = undefined
    if (clips.length === 0 && queue.length === 0) setSpeaking($, false)
  }
}

async function playClip($: EngineInterface, config: Config, clip: Clip, wav: string): Promise<void> {
  const child = $.process.spawn({ argv: ['bash', '-c', PLAY_SH, 'voicevox-play', wav, config.play] })
  let err = ''
  let out = ''
  try {
    for await (const piece of child) {
      if (piece.stream === 'stderr') {
        err += piece.text
        continue
      }
      if (speakingPid !== undefined || out.includes('\n')) continue
      out += piece.text
      const pid = out.match(/^(\d+)\n/)?.[1]
      if (pid === undefined) continue
      // Stopped before the PID was known: end it now.
      if (clip.epoch === epoch) speakingPid = pid
      else kill($, pid)
    }
    const { code } = await child.result
    // A stopped clip ends by a signal: not an error.
    if (code !== 0 && clip.epoch === epoch) throw new Error(err.trim() || `exit ${code}`)
  } catch (e) {
    if (clip.epoch === epoch) warn($, config, 'playback', clip.text, e)
  } finally {
    speakingPid = undefined
  }
}

/** One line of Japanese markdown as VOICEVOX should read it: links as their text, no URLs or markup. */
function speechLine(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/, '')
    .replace(/[`*#>]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // VOICEVOX pauses at a space next to Japanese ("Obsidian を RPM で" breathes three times and reads を
    // alone as オ), so only a space between two English words or numbers, where it reads the words apart
    // without a pause, is kept.
    .replace(/(?<![A-Za-z0-9]) | (?![A-Za-z0-9])/g, '')
}

/** How far a growing text has been read out, and whether that point is inside a code block. */
type Reader = { epoch: number; spoken: number; inFence: boolean }
const reader = (): Reader => ({ epoch, spoken: 0, inFence: false })
const readers = new Map<string, Reader>() // by plamo-ja speech id or turn block

/**
 * Speaks a growing text up to its last sentence boundary (`isWhole`: all of it). Code blocks are skipped,
 * and so is anything with no Japanese in it (an English sentence, a lone path).
 */
function readOut($: EngineInterface, config: Config, r: Reader, soFar: string, isWhole = false): void {
  let end = isWhole ? soFar.length : -1
  if (!isWhole) for (const m of soFar.matchAll(BOUNDARY)) end = m.index! + 1
  if (end <= r.spoken) return
  const segment = soFar.slice(r.spoken, end)
  r.spoken = end
  const lines: string[] = []
  for (const line of segment.split('\n')) {
    if (FENCE.test(line)) {
      r.inFence = !r.inFence
      continue
    }
    if (r.inFence || RULE.test(line)) continue
    const text = speechLine(line)
    if (text) lines.push(/[。！？!?、]$/.test(text) ? text : `${text}。`)
  }
  const text = lines.join('')
  if (JA.test(text) && r.epoch === epoch) say($, config, text)
}

async function isPlamoOn($: EngineInterface): Promise<boolean> {
  try {
    const { value } = await $.state.get(PLAMO_MODE)
    return value !== undefined && value !== 'off'
  } catch {
    return false // plamo-ja is not installed
  }
}

async function isEngineUp($: EngineInterface, config: Config): Promise<boolean> {
  try {
    return (await $.http.fetch(`${config.url}/version`)).ok
  } catch {
    return false
  }
}

/** The port to publish when the URL is this machine's, else undefined (an engine elsewhere is not ours to start). */
function localPort(url: string): string | undefined {
  const m = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?(?:\/|$)/)
  return m ? (m[1] ?? (url.startsWith('https') ? '443' : '80')) : undefined
}

/**
 * Runs the startCommand (with the URL's port as $1) unless the engine already answers, then waits until it does.
 * Resolves whether the engine is up; concurrent callers share one start.
 */
function ensureEngine($: EngineInterface, config: Config): Promise<boolean> {
  starting ??= (async () => {
    try {
      if (await isEngineUp($, config)) return true
      const port = localPort(config.url)
      if (port === undefined || !config.start) return false
      $.ui.status('VOICEVOX エンジンを起動中…')
      const run = await $.process.run(
        ['bash', '-c', config.start, 'voicevox-start', port],
        { timeoutMs: 600_000 }, // a first run may pull a container image
      )
      if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `startCommand: exit ${run.exitCode}`)
      for (let i = 0; i < 120; i++) {
        if (await isEngineUp($, config)) {
          $.ui.toast('VOICEVOX エンジンを起動しました')
          return true
        }
        await $.clock.sleep(500)
      }
      throw new Error(`${config.url} が 60 秒たっても応答しません`)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      $.ui.log(`voicevox: engine start failed: ${reason}`, { to: 'debug' })
      $.ui.toast(`⚠ VOICEVOX エンジンを起動できませんでした (${reason})`)
      return false
    } finally {
      $.ui.status(undefined)
      starting = undefined
    }
  })()
  return starting
}

/**
 * The system prompt section that has Claude write in the voice's character: the official first and second
 * person, profile and, where the character has one, the fixed sentence ending. Undefined for a voice the
 * table does not know.
 */
function persona(name: string): string | undefined {
  const m = name.match(/^(.*?)\s*\(([^()]*)\)$/)
  const [who, style] = m ? [m[1]!, m[2]!] : [name, undefined]
  const c = CHARACTERS[who]
  if (!c) return undefined
  const lines = [
    '# 読み上げのキャラクター',
    `あなたの応答は VOICEVOX の「${who}」${style ? `（${style}）` : ''}の声で読み上げられている。` +
      `ユーザーへの日本語の返事は、${who}として、このキャラクターの話し方で書くこと。`,
    `- 一人称: ${c.me.join(' / ')}`,
    `- 相手の呼び方: ${c.you.join(' / ')}`,
    `- 語尾・口調: ${c.speech ?? '決まった語尾はない。プロフィールに合う自然な口調にし、語尾を作り込みすぎない'}`,
    `- プロフィール: ${c.profile}`,
  ]
  if (style && !/^(ノーマル|ふつう)$/.test(style)) lines.push(`- スタイル「${style}」の声なので、その雰囲気を少し出す`)
  lines.push(
    '口調を変えるのは会話の文だけにする。コード、コマンド、パス、識別子、コミットメッセージ、ファイルに書く文章、' +
      'ツールへの入力はキャラクターの口調にしない。内容の正確さと簡潔さは変えない。' +
      'ユーザーがこの会話で別の話し方を指示したら、そちらに従う。',
  )
  return lines.join('\n')
}

/** The style's name for the speaker id, from /speakers when not known yet; stored with the id. */
async function nameOf($: EngineInterface, config: Config): Promise<string | undefined> {
  if (speakerName !== undefined) return speakerName
  const styles = await speakerStyles($, config)
  if (typeof styles === 'string') return undefined
  speakerName = styles.find(s => s.id === speaker)?.name
  if (speakerName !== undefined) {
    await $.store.set('speakerName', speakerName)
    await $.store.set('speakerNameId', speaker)
  }
  return speakerName
}

type Speaker = { name: string; styles: { name: string; id: number }[] }

async function speakerStyles($: EngineInterface, config: Config): Promise<{ id: string; name: string }[] | string> {
  const res = await $.http.fetch(`${config.url}/speakers`).catch(() => undefined)
  if (!res?.ok) return `⚠ ${config.url}/speakers に接続できません${res ? ` (HTTP ${res.status})` : ''}`
  return (JSON.parse(res.text) as Speaker[]).flatMap(s => s.styles.map(t => ({ id: String(t.id), name: `${s.name} (${t.name})` })))
}

export const register: Register = (on, options) => {
  const config: Config = {
    url: String(options.url ?? 'http://127.0.0.1:50021').replace(/\/+$/, ''),
    // VOICEVOX's speedScale; anything but a plain positive number falls back to 1.0
    speed: /^\d+(\.\d+)?$/.test(String(options.speed ?? '').trim()) ? String(options.speed).trim() : '1.0',
    start: String(options.startCommand ?? '').trim(),
    play: String(options.playCommand ?? '').trim() || 'aplay -q -',
  }

  on('session.start', async ($, e, next) => {
    isOn = (await $.state.get(IS_ON)).value === true
    await update($, IS_SPEAKING, () => false) // a reload ended whatever was playing
    speaker = String((await $.store.get('speaker')) ?? options.speaker ?? '3')
    const stored = await $.store.get('speakerName')
    // A name stored for another id (the default changed in settings) is looked up again.
    speakerName = typeof stored === 'string' && (await $.store.get('speakerNameId')) === speaker ? stored : undefined
    await $.command.register({
      name: 'voicevox',
      description: '応答を VOICEVOX で読み上げる (on / off / speaker [ID|名前] で話者の一覧・切り替え)',
      argumentHint: '[on|off|speaker [id|name]]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'voicevox' }, async ($, e) => {
    const [sub = 'on', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'on' || sub === 'off') {
      isOn = sub === 'on'
      await $.state.set(IS_ON, isOn)
      hasWarned = false
      if (!isOn) {
        stop($)
        return { text: 'VOICEVOX 読み上げ: オフ' }
      }
      const isUp = await isEngineUp($, config)
      if (!isUp) void ensureEngine($, config).then(up => (up ? nameOf($, config) : undefined))
      const name = isUp ? await nameOf($, config) : speakerName
      const label = `話者 ${speaker}${name ? `: ${name}` : ''}`
      if (isUp) return { text: `VOICEVOX 読み上げ: オン (${label})` }
      return { text: `VOICEVOX 読み上げ: オン (${label})。エンジンが応答しないので起動しています` }
    }
    if (sub !== 'speaker') return { text: '使い方: /voicevox [on|off|speaker [ID|名前]]' }
    await ensureEngine($, config)
    const styles = await speakerStyles($, config)
    if (typeof styles === 'string') return { text: styles }
    const want = rest.join(' ')
    if (!want) return { text: styles.map(s => `${s.id === speaker ? '*' : ' '} ${s.id}: ${s.name}`).join('\n') }
    const hit = styles.find(s => s.id === want) ?? styles.find(s => s.name.includes(want))
    if (!hit) return { text: `⚠ 話者「${want}」が見つかりません。/voicevox speaker で一覧を表示します` }
    speaker = hit.id
    speakerName = hit.name
    await $.store.set('speaker', speaker)
    await $.store.set('speakerName', speakerName)
    await $.store.set('speakerNameId', speaker)
    const p = persona(hit.name)
    const how = p ? '（読み上げ中は、このキャラクターの口調で話します）' : '（このキャラクターの口調の情報はありません）'
    return { text: `VOICEVOX 話者: ${hit.id}: ${hit.name} ${how}` }
  })

  // While reading aloud, Claude writes as the voice's character. Not with plamo-ja on: Claude writes English
  // then, and the voice reads PLaMo's translation.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!isOn || speakerName === undefined || (await isPlamoOn($))) return result
    const text = persona(speakerName)
    if (!text) return result
    return { sections: [...result.sections, { id: 'voicevox:persona', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (isOn && !e.command && !e.isMeta) stop($) // the user has moved on
    return next(e)
  }).catch(($, e, next) => next(e))

  // Typing in the prompt box stops the speech: the person is reading, or has moved on. A cursor move does not.
  on('prompt.edit', ($, e, next) => {
    if (isSpeaking && (e.inputText !== '' || e.start !== e.end)) stop($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // While speaking, a row above the prompt with a button that stops it (a click, or ctrl+x tab then s).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isOn || e.props.hasSurvey || !(await read($, IS_SPEAKING))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>🔊 読み上げ中 </Text>
        <Button key="stop" label="止める" hotkey="s" onPress={() => stop($)} />
      </Box>
    )
  })

  // plamo-ja on: speak its Japanese translation of each fresh reply as it streams.
  on('state.set', { plugin: 'plamo-ja', key: 'speech' }, async ($, e, next) => {
    const result = await next(e)
    const s = e.value
    if (isOn && s && s.at >= stoppedAt) {
      const key = `plamo:${s.id}`
      const r = readers.get(key) ?? readers.set(key, reader()).get(key)!
      if (s.isRestart) Object.assign(r, { spoken: 0, inFence: false })
      readOut($, config, r, s.text, s.isWhole)
      if (s.isWhole) readers.delete(key)
    }
    return result
  }).catch(($, e, next) => next(e)) // never hold up plamo-ja's write
  on('state.set', { plugin: 'plamo-ja', key: 'mode' }, async ($, e, next) => {
    if (e.value === 'off') stop($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // plamo-ja off (or absent): Claude writes Japanese, spoken sentence by sentence as it streams.
  on('turn.step', async function* ($, e, next) {
    if (!isOn || e.agentId !== undefined || (await isPlamoOn($))) return yield* next(e)
    const blocks = new Map<number, string>()
    const readerOf = (index: number) => {
      const key = `${e.turnId}:${e.index}:${index}`
      return readers.get(key) ?? readers.set(key, reader()).get(key)!
    }
    const stream = next(e)
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done) return step.value
        const chunk = step.value
        if (chunk.kind === 'text') {
          const text = (blocks.get(chunk.index) ?? '') + chunk.text
          blocks.set(chunk.index, text)
          readOut($, config, readerOf(chunk.index), text)
        }
        yield chunk
      }
    } finally {
      for (const [index, text] of [...blocks].sort(([a], [b]) => a - b)) {
        readOut($, config, readerOf(index), text, true)
        readers.delete(`${e.turnId}:${e.index}:${index}`)
      }
    }
  })
}
