import json, sys
cs = json.load(open(sys.argv[1]))
# 語尾・口調がはっきり決まっているキャラだけ手で足す（出典をコメントに残す）
SPEECH = {
  'ずんだもん': ('文末に「〜のだ」「〜なのだ」を付ける', 'ピクシブ百科事典・Wikipedia「ずんだもん」'),
  'あんこもん': ('文末に「〜だもん」を付ける', '公式プロフィールの「語尾」'),
  '東北イタコ': ('「〜ですわ」口調', '公式プロフィールの「口調」'),
  '四国めたん': ('誰にでも遠慮しないタメ口。若干ツンデレで、ときどき中二病っぽい言い回しが出る', '公式プロフィール'),
  '春日部つむぎ': ('ギャルっぽい、くだけたタメ口', '公式プロフィール'),
  '里石ユカ': ('つぼみ（VOICEVOX のスタイル）は引っ込み思案で語尾は特になし。開花すると「〜なのです」', '公式プロフィールの「性格」「語尾」'),
}
KEEP = ('性格', '口調', '語尾', '種族', '年齢')
out = {}
for c in cs:
    labels = [f'{l}: {v}' for l, v in c['labels'] if l in KEEP and l not in ('口調', '語尾')]
    e = {'me': c['me'], 'you': c['you'], 'profile': ' '.join([c['description']] + labels)}
    if c['name'] in SPEECH: e['speech'] = SPEECH[c['name']][0]
    out[c['name']] = e
missing = set(SPEECH) - set(out)
assert not missing, missing
body = json.dumps(out, ensure_ascii=False, indent=2)
print('''// VOICEVOX の話者名ごとの話し方。エンジンの /speakers が返す名前 (「ずんだもん」「†聖騎士 紅桜†」など) で引く。
// me / you / profile は VOICEVOX 公式サイトのソース (github.com/VOICEVOX/voicevox_blog の
// src/constants/characterInfos/*.ts と callNameInfo.ts) から取ったもの。
// speech は語尾や口調がはっきり決まっているキャラだけ手で足したもの。ないキャラは profile から口調を決める。
// 再生成: scripts/gen-characters.sh (README の「キャラクターの話し方」)

export type Character = {
  /** 一人称 (公式) */
  me: readonly string[]
  /** 二人称 (公式) */
  you: readonly string[]
  /** 公式の紹介文と、性格・種族・年齢 */
  profile: string
  /** 語尾・口調の決まり。決まっているキャラだけ */
  speech?: string
}

export const CHARACTERS: Record<string, Character> = ''' + body)
