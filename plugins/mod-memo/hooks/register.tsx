import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// 오른쪽 패널에 메모 탭을 띄운다. 모든 창이 메모 하나를 같이 쓴다. /mod-memo로 열고 닫는다.
// 글자를 치다 멈추면 저절로 저장하고, 몇 초마다 파일을 다시 읽어 다른 탭에서 고친 것을 따라온다.

const PANE = 'memo'
const TITLE = '메모'
// 두 계정이 같이 쓰고, .claude 동기화로 다른 PC에도 간다.
const MEMO_FILE = '.claude/plugins/mod-memo.txt'
const SAVE_DELAY_MS = 1_000 // 치는 도중에 입력칸을 다시 그리면 방금 친 글자가 지워져서, 멈춘 뒤에 저장한다.
const REFRESH_MS = 5_000

// null이면 파일을 못 읽은 것: 입력칸을 내지 않아 빈 메모로 덮어쓰는 일을 막는다.
const textAtom = atom({ plugin: 'mod-memo', key: 'text' } as const, null)

let typedCount = 0 // 친 횟수. 멈췄는지 알아보는 데 쓴다.
let unsaved = false

const memoPath = async ($: EngineInterface) => `${await $.env.get('USERPROFILE')}/${MEMO_FILE}`

async function refresh($: EngineInterface) {
  if (unsaved) return
  try {
    const path = await memoPath($)
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    if (!unsaved && text !== (await read($, textAtom))) await update($, textAtom, () => text)
  } catch (error) {
    $.ui.log(`메모 읽기 실패: ${error}`, { to: 'debug' })
  }
}

async function save($: EngineInterface, text: string) {
  unsaved = false
  try {
    await $.fs.write(await memoPath($), text)
    await update($, textAtom, () => text)
  } catch (error) {
    $.ui.toast(`메모를 저장하지 못했습니다: ${error}`)
  }
}

async function saveWhenStopped($: EngineInterface, text: string) {
  unsaved = true
  const mine = ++typedCount
  await $.clock.sleep(SAVE_DELAY_MS)
  if (mine === typedCount) await save($, text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mod-memo', description: '[mod] 메모 탭 열기' })
    await refresh($)
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'mod-memo' }, async $ => {
    // 열려 있으면 닫고, 닫혀 있으면 연다.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '메모 탭을 닫았습니다.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '메모 탭을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const text = await read($, textAtom)
    if (text === null) return <Text dimColor>메모를 읽지 못했습니다.</Text>
    return (
      <Box flexDirection="column">
        <Input
          key="memo"
          value={text}
          rows={Math.max(3, e.props.scroll.bodyRows - 1)}
          placeholder="여기를 눌러 메모를 적으세요"
          submitLabel="저장"
          autoFocus
          onInput={value => void saveWhenStopped($, value)}
          onSubmit={value => {
            typedCount++
            void save($, value)
          }}
        />
        <Text dimColor>저절로 저장됨 · 줄바꿈은 Shift+Enter</Text>
      </Box>
    )
  })
}
