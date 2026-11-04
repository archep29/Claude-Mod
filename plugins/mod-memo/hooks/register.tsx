import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MemoData } from '../types'

// 오른쪽 패널에 메모 탭을 띄운다. 모든 창이 메모 하나를 같이 쓴다. /mod-memo로 열고 닫는다.
// 편집은 memo-editor.tsx가 맡고, 여기서는 파일을 읽고 쓴다.

const PANE = 'memo'
const TITLE = '메모'
// 마크다운 목록. 두 계정이 같이 쓰고, .claude 동기화로 다른 PC에도 간다.
const MEMO_FILE = '.claude/plugins/mod-memo.md'
const OLD_MEMO_FILE = '.claude/plugins/mod-memo.txt' // .md가 없을 때만 읽는다
const REFRESH_MS = 2_000
// 탭은 연 순서대로 놓이고 순서를 정하는 기능이 없어, 세션목록이 열린 뒤에 열어 맨 뒤에 오게 한다.
const OPEN_DELAY_MS = 1_000
const HINT_ROWS = 5 // 편집기 아래 여백·안내문과 위 여백

// null이면 파일을 못 읽은 것: 편집기를 내지 않아 빈 메모로 덮어쓰는 일을 막는다.
const memoAtom = atom({ plugin: 'mod-memo', key: 'memo' } as const, null as MemoData | null)

let knownText: string | null = null // 이 탭이 마지막으로 읽거나 쓴 파일 내용
let queue: Promise<void> = Promise.resolve() // 읽기·쓰기가 뒤섞이지 않게 차례로

const inTurn = (work: () => Promise<void>) => (queue = queue.then(work))

const homePath = async ($: EngineInterface, file: string) => `${await $.env.get('USERPROFILE')}/${file}`

async function readMemo($: EngineInterface): Promise<string> {
  for (const file of [MEMO_FILE, OLD_MEMO_FILE]) {
    const path = await homePath($, file)
    if (await $.fs.exists(path)) return $.fs.read(path)
  }
  return ''
}

function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop() // 마지막 줄바꿈 뒤는 줄이 아니다
  return lines
}

// 파일 내용을 편집기에 새로 넣는다. version이 바뀌어야 편집기가 받아들인다.
async function showText($: EngineInterface, text: string) {
  knownText = text
  await update($, memoAtom, memo => ({ lines: toLines(text), version: (memo?.version ?? 0) + 1 }))
}

const refresh = ($: EngineInterface) =>
  inTurn(async () => {
    try {
      const text = await readMemo($)
      if (text !== knownText) await showText($, text)
    } catch (error) {
      $.ui.log(`메모 읽기 실패: ${error}`, { to: 'debug' })
    }
  })

// 다른 탭이 먼저 고쳤으면 덮어쓰지 않고 그 내용을 불러온다.
const save = ($: EngineInterface, lines: string[]) =>
  inTurn(async () => {
    try {
      const text = await readMemo($)
      if (text !== knownText) {
        await showText($, text)
        $.ui.toast('다른 창에서 메모가 바뀌어 다시 불러왔습니다.')
        return
      }
      const next = lines.map(line => `${line}\n`).join('')
      await $.fs.write(await homePath($, MEMO_FILE), next)
      knownText = next
      await update($, memoAtom, memo => ({ lines, version: memo?.version ?? 0 }))
    } catch (error) {
      $.ui.toast(`메모를 저장하지 못했습니다: ${error}`)
    }
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mod-memo', description: '[mod] 메모 탭 열기' })
    await refresh($)
    $.clock.after(OPEN_DELAY_MS, () => void $.ui.open({ id: PANE, title: TITLE }))
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

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    await save($, (e.data as { lines: string[] }).lines)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Client } = $.ui.resolve(e)
    const memo = await read($, memoAtom)
    if (memo === null) return <Text dimColor>메모를 읽지 못했습니다.</Text>
    return (
      <Box flexDirection="column" marginTop={1}>
        <Client
          key="editor"
          module="./memo-editor.tsx"
          props={memo}
          width="100%"
          height={Math.max(4, e.props.scroll.bodyRows - HINT_ROWS)}
        />
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Enter 다음 · Tab 하위 · Shift+Tab 상위</Text>
          <Text dimColor>Ctrl+Z 되돌리기 · Ctrl+K 완료</Text>
          <Text dimColor>Ctrl+↑↓ 이동 · ▾ 누르면 접기</Text>
        </Box>
      </Box>
    )
  })
}
