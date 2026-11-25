# voicevox

Claude Code の応答を、ローカルで動かしている [VOICEVOX](https://voicevox.hiroshiba.jp/) エンジンで読み上げるプラグインです (ずんだもんモード)。
もとは plamo-ja の `/plamo voice` だった機能を、独立したプラグインに分けました。

## 使い方

```
/voicevox on               # 読み上げを始める (引数なしも同じ)
/voicevox off              # 読み上げをやめ、再生中の発話も止める
/voicevox speaker          # エンジンの話者 (スタイル ID) を一覧する。* が今の話者
/voicevox speaker 1        # ID で切り替える
/voicevox speaker めたん   # 名前の一部で切り替える (最初に一致したスタイル)
```

選んだ話者はプラグインの store に保存されるので、次のセッションでも使われます。

- Claude が日本語で書いている応答を、書いている途中から 1 文ずつ読み上げます
- plamo-ja の `/plamo on` が有効なときは英語の本文は読まず、plamo-ja が `$.state` に流す訳 (`plamo-ja.speech`) を、訳しながら読み上げます。plamo-ja が入っていなくても動きます
- 読み上げは 1 つのキューに積み、1 発話ずつ順に再生します。1 つを再生している間に次の発話を合成しておくので、文と文の間に合成待ちの無音ができません (先読みは 2 つまで、合成は 1 つずつ)。次の入力を送ったときと `/voicevox off` のときは、再生中の発話を止めてキューを空にします
- 読み上げは途中で止められます。プロンプト欄に何か打つ (入力・削除・ペースト。カーソル移動だけでは止まりません) か、読み上げ中だけプロンプトの上に出る「🔊 読み上げ中 止める」のボタンを押します (クリック、または ctrl+x tab で行に移って `s`)。止めたとき書かれていた段落の残りは読みませんが、Claude がツールを実行したあとに書いた新しい文はまた読み上げます
- コードブロック、URL、Markdown の記号、日本語を含まない文は読みません

### エンジンの自動起動 (任意)

`startCommand` を設定しておくと、`/voicevox on` のときに `url` が応答しなければ、そのコマンドを `bash -c` で実行します。`$1` には `url` のポートが入ります。
起動中に届いた応答は、エンジンが応答するようになってから読み上げます (最大 60 秒待ちます)。
`startCommand` が空 (デフォルト) のときと、`url` がこのマシン (127.0.0.1 / localhost) を指していないときは何も起動しません。

podman の例:

```
podman start voicevox || podman run -d --rm --name voicevox -p 127.0.0.1:$1:50021 docker.io/voicevox/voicevox_engine:cpu-0.26.1
```

Docker なら `podman` を `docker` に置き換えます。

### キャラクターの話し方

読み上げがオンの間は、選んだ話者のキャラクターの話し方で Claude が返事を書くよう、システムプロンプトに 1 節 (`voicevox:persona`) を足します。

- 一人称・二人称・紹介文は、VOICEVOX 公式サイトのソース ([VOICEVOX/voicevox_blog](https://github.com/VOICEVOX/voicevox_blog) の `src/constants/characterInfos/`) から取った 44 キャラ分です (`hooks/characters.ts`)
- 語尾や口調がはっきり決まっているキャラは、それも伝えます。ずんだもん「〜のだ / 〜なのだ」、あんこもん「〜だもん」、東北イタコ「ですわ口調」、四国めたん (タメ口・若干ツンデレ・中二病)、春日部つむぎ (ギャル口調)、里石ユカ (つぼみ: 語尾なし)。それ以外のキャラは紹介文に合う自然な口調にさせ、語尾は作り込ませません
- スタイルが「ノーマル」以外 (あまあま、ツンツンなど) なら、その雰囲気も少し出させます
- コード、コマンド、コミットメッセージ、ファイルに書く文章は口調を変えさせません
- plamo-ja の `/plamo on` が有効なときは足しません (Claude は英語で書き、PLaMo の訳を読み上げるため)

公式サイトのデータが増えたら `scripts/gen-characters.sh` で `hooks/characters.ts` を作り直します (`gh`、`curl`、`python3` が必要)。手で足した語尾は `scripts/gen-characters.py` の `SPEECH` にあります。

### 長い応答

1 回の合成は 120 字までに区切ります。文末 (。！？) で区切り、1 文が長いときは読点か空白で、それもなければ 120 字で切ります。
VOICEVOX エンジンは合成する文が長いほどメモリを大きく使います (CPU 版 0.26.1 で、100 字で約 0.35GB、1200 字で 20GB 超)。以前の実装は待っている文を全部つないで 1 回で合成していたため、長い応答で OOM killer にエンジンが止められ、読み上げが途中で途切れていました。

## 設定

| 項目 | デフォルト | 内容 |
| --- | --- | --- |
| `url` | `http://127.0.0.1:50021` | VOICEVOX エンジンの URL |
| `speaker` | `3` | `/voicevox speaker` で選ぶまで使うスタイル ID (`3` はずんだもんのノーマル) |
| `speed` | `1.0` | 速さ (VOICEVOX の `speedScale`)。例: `1.3` |
| `playCommand` | `aplay -q -` | WAV を標準入力から読んで再生するコマンド。例: `paplay`、`pw-play -`、`ffplay -nodisp -autoexit -loglevel quiet -` |
| `startCommand` | (空) | エンジンが応答しないときに実行するコマンド。`$1` はポート。空なら起動しない |

設定は `~/.claude/settings.json` の `pluginConfigs["voicevox@kat0h-agent-skills"].options` に保存されます。

## 必要なもの

- VOICEVOX エンジン (`/audio_query` と `/synthesis`。0.26.1 で確認)
- `bash`、`curl`、GNU `mktemp`、`sed`
- WAV を標準入力から再生できるプレイヤー (デフォルトは `aplay`)。Linux で確認しています

## インストール

```
/plugin install voicevox --marketplace kat0h/agent-skills
```
