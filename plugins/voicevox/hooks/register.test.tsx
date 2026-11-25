import type { On, PromptEditInput, PromptEditResult, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

declare function setTimeout(callback: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await sleep(10)
  expect(condition()).toBe(true)
}

const OPTIONS = { url: 'http://127.0.0.1:50021', speaker: '3', speed: '1.0', startCommand: 'start-engine "$1"', playCommand: 'aplay -q -' }
const SPEAKERS = [
  { name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }] },
  { name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }, { name: 'あまあま', id: 1 }] },
  { name: '春日部つむぎ', styles: [{ name: 'ノーマル', id: 8 }] },
  { name: 'まだいないキャラ', styles: [{ name: 'ノーマル', id: 999 }] },
]
const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
const STEP = { turnId: 't1', index: 0, model: 'm', messageCount: 1 }

/** The VOICEVOX engine's HTTP API, answering while `isUp()`; every URL fetched is kept. */
function api(on: On, isUp: () => boolean = () => true) {
  const urls: string[] = []
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    if (!isUp()) throw new Error('ECONNREFUSED')
    if (e.url.endsWith('/version')) return ok('"0.26.1"')
    if (e.url.endsWith('/speakers')) return ok(JSON.stringify(SPEAKERS))
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  return urls
}

function engine(on: On, store: Record<string, unknown> = {}) {
  on('command.register', () => ({ value: { command: 'voicevox' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_, e) => ({ text: e.text, cursor: e.cursor }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
}

/**
 * The host side of speech: synthesis (`process.run` of the synth script) makes `/tmp/clip-N.wav`, and
 * playback (`process.spawn` of the play script) "plays" one for `ms`. Spoken clips are kept in the order
 * played, with the time each synthesis started and each playback ended, and every PID killed.
 */
type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

function speaker(on: On, ms = 0, synthMs = 0, start?: (argv: readonly string[]) => RunResult) {
  const made = new Map<string, { text: string; speaker: string }>()
  const spoken: { text: string; speaker: string }[] = []
  const synthStarts: number[] = []
  const playEnds: number[] = []
  const killed: string[] = []
  let playing = 0
  let spawns = 0
  let most = 0
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'kill') killed.push(e.argv[1]!)
    if (e.argv[3] === 'voicevox-start' && start) return { value: start(e.argv) }
    if (e.argv[3] === 'voicevox-synth') {
      synthStarts.push(Date.now())
      await sleep(synthMs)
      const wav = `/tmp/clip-${made.size}.wav`
      made.set(wav, { text: e.argv[6]!, speaker: e.argv[5]! })
      return { value: { exitCode: 0, stdout: `${wav}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    expect(e.argv[3]).toBe('voicevox-play')
    playing++
    most = Math.max(most, playing)
    const pid = String(1000 + spawns++)
    yield { stream: 'stdout', text: `${pid}\n` }
    for (let t = 0; t < ms && !killed.includes(pid); t += 5) await sleep(5)
    playing--
    if (killed.includes(pid)) return { value: { code: null, signal: 'SIGTERM' } }
    spoken.push(made.get(e.argv[4]!)!)
    playEnds.push(Date.now())
    return { value: { code: 0, signal: null } }
  })
  return { spoken, most: () => most, synthStarts, playEnds, killed }
}

const voicevox = ($: Engine, args: string) =>
  $.command.run({ command: 'voicevox', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

function reply(on: On, pieces: string[]) {
  on('turn.step', async function* (_, e) {
    for (const text of pieces) {
      yield { kind: 'text', index: 0, text }
      await sleep(5)
    }
    return { turnId: e.turnId, index: e.index, answer: pieces.join(''), toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

async function step($: Engine, turnId = 't1') {
  const stream = $.turn.step({ ...STEP, turnId })
  while (!(await stream.next()).done) {}
}

test('nothing is spoken until /voicevox on', { options: OPTIONS }, async ($, on) => {
  engine(on)
  reply(on, ['こんにちは。'])
  const { spoken } = speaker(on)
  await step($)
  await sleep(20)
  expect(spoken.length).toBe(0)
})

test('a Japanese reply is spoken sentence by sentence as Claude writes it, code skipped', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['こんにちは。今日は', 'いい天気ですね。\n\n```sh\nls\n```\n\nそれでは', 'また。'])
  const { spoken } = speaker(on)
  await voicevox($, 'on')
  await step($)
  await until(() => spoken.map(s => s.text).join('').includes('また。'))
  expect(spoken.map(s => s.text).join('')).toBe('こんにちは。今日はいい天気ですね。それではまた。')
  await voicevox($, 'off')
})

test('a reply of over 1000 characters is spoken in utterances of at most 120, in order, one at a time', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  const sentence = 'ずんだもんはずんだ餅の妖精で、東北地方の名物を広めるために毎日がんばっているのだ。'
  const long = sentence.repeat(30) + 'くぎりのない' + 'とてもながいぶんしょう'.repeat(30) + '。'
  expect(long.length).toBeGreaterThan(1000)
  reply(on, [long])
  const { spoken, most } = speaker(on, 2)
  await voicevox($, 'on')
  await step($)
  await until(() => spoken.map(s => s.text).join('') === long)
  expect(spoken.length).toBeGreaterThan(10)
  for (const s of spoken) expect(s.text.length).toBeLessThanOrEqual(120)
  expect(most()).toBe(1)
  await voicevox($, 'off')
})

test('/voicevox speaker lists the engine speakers, switches by id or name, and keeps the choice', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = {}
  engine(on, store)
  api(on)
  reply(on, ['話者を変えました。'])
  const { spoken } = speaker(on)
  const list = (await voicevox($, 'speaker')).text
  expect(list).toContain('* 3: ずんだもん (ノーマル)')
  expect(list).toContain('  2: 四国めたん (ノーマル)')
  expect((await voicevox($, 'speaker めたん')).text).toContain('2: 四国めたん')
  expect(store.speaker).toBe('2')
  expect((await voicevox($, 'speaker 1')).text).toContain('1: ずんだもん (あまあま)')
  expect((await voicevox($, 'speaker だれ')).text).toContain('見つかりません')
  expect(store.speaker).toBe('1')
  await voicevox($, 'on')
  await step($)
  await until(() => spoken.length > 0)
  expect(spoken[0]!.speaker).toBe('1')
  await voicevox($, 'off')
})

test('/voicevox off kills the clip playing and drops the queue and the clips made ahead', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。'])
  const { spoken, killed } = speaker(on, 10_000)
  await voicevox($, 'on')
  await step($)
  await sleep(50) // the first clip is playing, the next made ahead
  await voicevox($, 'off')
  await until(() => killed.length > 0)
  expect(killed).toEqual(['1000'])
  await sleep(30)
  expect(spoken.length).toBe(0)
})

test('the next clip is synthesized while one plays, so playback runs on without a gap for synthesis', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。'])
  const { spoken, synthStarts, playEnds } = speaker(on, 60, 40)
  await voicevox($, 'on')
  await step($)
  await until(() => spoken.length === 3)
  expect(spoken.map(s => s.text)).toEqual(['一つ目の文です。', '二つ目の文です。', '三つ目の文です。'])
  // the second clip was being made before the first finished playing
  expect(synthStarts[1]!).toBeLessThan(playEnds[0]!)
  await voicevox($, 'off')
})

const START_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('/voicevox on runs startCommand when the engine does not answer, and speaks once it does', { options: OPTIONS }, async ($, on) => {
  engine(on)
  let isUp = false
  api(on, () => isUp)
  const runs: string[][] = []
  const start = (argv: readonly string[]) => {
    runs.push([...argv])
    isUp = true
    return START_OK
  }
  reply(on, ['起動したのだ。'])
  const { spoken } = speaker(on, 0, 0, start)
  expect((await voicevox($, 'on')).text).toContain('起動しています')
  await step($)
  await until(() => spoken.length > 0)
  expect(runs).toEqual([['bash', '-c', 'start-engine "$1"', 'voicevox-start', '50021']])
  expect(spoken[0]!.text).toBe('起動したのだ。')
  await voicevox($, 'off')
})

test('/voicevox on starts nothing without a startCommand', { options: { ...OPTIONS, startCommand: '' } }, async ($, on) => {
  engine(on)
  api(on, () => false)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: START_OK }
  })
  await voicevox($, 'on')
  await sleep(20)
  expect(runs).toEqual([])
  await voicevox($, 'off')
})

test('/voicevox on runs no startCommand when the engine already answers', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: START_OK }
  })
  expect((await voicevox($, 'on')).text).toBe('VOICEVOX 読み上げ: オン (話者 3: ずんだもん (ノーマル))')
  await sleep(20)
  expect(runs).toEqual([])
  await voicevox($, 'off')
})

function basePrompt(on: On) {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
}
const personaOf = async ($: Engine) => (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })).sections.find(s => s.id === 'voicevox:persona')?.text

test('while reading aloud, the system prompt has Claude speak as the voice: Zundamon ends with のだ, Tsumugi says あーし', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = {}
  engine(on, store)
  api(on)
  basePrompt(on)
  expect(await personaOf($)).toBeUndefined()
  await voicevox($, 'on')
  const zunda = await personaOf($)
  expect(zunda).toContain('「ずんだもん」')
  expect(zunda).toContain('〜のだ')
  expect(zunda).toContain('一人称: ずんだもん / 僕')
  expect((await voicevox($, 'speaker つむぎ')).text).toContain('口調で話します')
  const tsumugi = await personaOf($)
  expect(tsumugi).toContain('一人称: あーし')
  expect(tsumugi).toContain('ギャル')
  expect(store.speakerName).toBe('春日部つむぎ (ノーマル)')
  await voicevox($, 'speaker 1')
  expect(await personaOf($)).toContain('スタイル「あまあま」')
  await voicevox($, 'off')
  expect(await personaOf($)).toBeUndefined()
})

test('a voice the table does not know adds nothing to the system prompt', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  basePrompt(on)
  await voicevox($, 'on')
  expect((await voicevox($, 'speaker 999')).text).toContain('口調の情報はありません')
  expect(await personaOf($)).toBeUndefined()
  await voicevox($, 'off')
})

test('spaces next to Japanese are dropped, so VOICEVOX does not pause there; one between English words stays', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['Obsidian を RPM で入れて、 Claude Code を 2 回使う。'])
  const { spoken } = speaker(on)
  await voicevox($, 'on')
  await step($)
  await until(() => spoken.length > 0)
  expect(spoken[0]!.text).toBe('ObsidianをRPMで入れて、Claude Codeを2回使う。')
  await voicevox($, 'off')
})

// prompt.edit is raised by the composer, not called on $, so the test's Engine does not type it; it dispatches all the same.
type CanEdit = { prompt: { edit: (e: PromptEditInput) => Promise<PromptEditResult> } }
const edit = ($: Engine, inputText: string, start = 0, end = start) =>
  ($ as unknown as CanEdit).prompt.edit({ origin: { kind: 'composer' }, text: 'ab', cursor: start, start, end, inputText })

test('typing in the prompt box stops the speech; a bare cursor move does not', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。'])
  const { spoken, killed } = speaker(on, 10_000)
  await voicevox($, 'on')
  await step($)
  await sleep(50) // the first clip is playing
  await edit($, '', 1) // a cursor move
  await sleep(20)
  expect(killed).toEqual([])
  await edit($, 'あ')
  await until(() => killed.length > 0)
  expect(killed).toEqual(['1000'])
  await sleep(30)
  expect(spoken.length).toBe(0)
  await voicevox($, 'off')
})

test('stopped mid-block, the rest of that block is not spoken nor read again; the next step is', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  let gate: () => void = () => undefined
  const opened = new Promise<void>(resolve => (gate = resolve))
  on('turn.step', async function* (_, e) {
    const pieces = e.index === 0 ? ['一つ目の文です。', '二つ目の文です。'] : ['ツールのあとの文です。']
    for (const [i, text] of pieces.entries()) {
      if (e.index === 0 && i === 1) await opened
      yield { kind: 'text', index: 0, text }
      await sleep(5)
    }
    return { turnId: e.turnId, index: e.index, answer: pieces.join(''), toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const { spoken, killed } = speaker(on, 60)
  await voicevox($, 'on')
  const first = (async () => {
    const stream = $.turn.step({ ...STEP })
    while (!(await stream.next()).done) {}
  })()
  await sleep(20) // the first sentence is playing
  await edit($, 'あ')
  await until(() => killed.length > 0)
  gate()
  await first
  const second = $.turn.step({ ...STEP, index: 1 })
  while (!(await second.next()).done) {}
  await until(() => spoken.length > 0)
  await sleep(100)
  expect(spoken.map(s => s.text)).toEqual(['ツールのあとの文です。'])
  await voicevox($, 'off')
})

test('a row above the prompt shows while speaking, and its button stops the speech', { options: OPTIONS }, async ($, on) => {
  engine(on)
  api(on)
  reply(on, ['一つ目の文です。', '二つ目の文です。'])
  const { spoken, killed } = speaker(on, 10_000)
  await voicevox($, 'on')
  const band = { plugin: 'voicevox', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false } as RenderPropsOf['AbovePrompt'] } as const
  let ui = await $.ui.mount(band)
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
  await step($)
  await sleep(50)
  ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /読み上げ中/ })).toBeDefined()
  await ui.press({ key: 'stop' })
  await until(() => killed.length > 0)
  await ui.unmount()
  ui = await $.ui.mount(band)
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
  expect(spoken.length).toBe(0)
  await voicevox($, 'off')
})
