import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'prompt-toc'
const TITLE = '질문내역'
const MARK_BG = '#5c5000' // 체크한 질문 배경(어두운 노랑)
// 탭은 연 순서대로 놓여서, 세션목록이 열린 뒤에 연다(세션목록 → 질문내역 → 메모).
const OPEN_DELAY_MS = 500

// 체크한 질문들(질문 글 앞 200자로 구별). 세션마다 $.store에 남겨 창을 닫거나 다시 열어도 유지된다.
const marksAtom = atom({ plugin: 'mod-prompt-toc', key: 'marks' } as const, [] as string[])
const markKey = (text: string) => text.slice(0, 200)
const storeKey = async ($: EngineInterface) => `marks:${await $.session.id()}`
const idsKey = async ($: EngineInterface) => `ids:${await $.session.id()}`

async function toggleMark($: EngineInterface, key: string) {
  await update($, marksAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
  await $.store.set(await storeKey($), await read($, marksAtom))
}

// 대화에 그려진 내 질문 줄: 줄 id → 글자. 줄의 id가 있어야 그 줄로 이동할 수 있다.
// 그리는 도중에는 저장(state)이 막혀 있어 모듈 안에 둔다. 다시 불러오면 줄들이 다시 그려지며 채워진다.
// 모드를 다시 불러오면 지워지므로, 1초 타이머가 세션별 저장소(ids:<세션id>)에 적어 두고 시작할 때 되살린다.
const seen = new Map<string, string>()
let seenCount = 0 // 창을 마지막으로 그릴 때의 seen 개수
let savedCount = 0 // 저장소에 마지막으로 적은 seen 개수

// 공백을 하나로 모은 글자: 대화 기록과 화면 줄을 맞대 보는 기준
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

// 질문 번호를 원문자로: ①~⑳, ㉑~㉟, ㊱~㊿, 그 뒤는 (51)
const circled = (n: number) =>
  n <= 20 ? String.fromCodePoint(0x2460 + n - 1)
  : n <= 35 ? String.fromCodePoint(0x3251 + n - 21)
  : n <= 50 ? String.fromCodePoint(0x32b1 + n - 36)
  : `(${n})`

// 대화 기록 속 사용자 글에서 시스템이 덧붙인 부분을 뺀다
const cleanStored = (text: string) =>
  squash(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mod-prompt-toc',
      description: '[mod] 내가 적은 질문내역 창 열기',
    })
    const saved = (await $.store.get(await storeKey($))) as string[] | undefined
    if (saved) await update($, marksAtom, () => saved)
    const savedIds = (await $.store.get(await idsKey($))) as [string, string][] | undefined
    for (const [id, text] of savedIds ?? []) if (!seen.has(id)) seen.set(id, text)
    savedCount = savedIds?.length ?? 0
    // 새로 기억한 질문 줄이 있으면 저장소에 적고 창을 다시 그린다
    $.clock.every(1000, async () => {
      if (seen.size !== savedCount) {
        savedCount = seen.size
        await $.store.set(await idsKey($), [...seen])
      }
      if (seen.size !== seenCount) $.ui.invalidate('ui.render')
    })
    const started = await next(e)
    $.clock.after(OPEN_DELAY_MS, () => void $.ui.open({ id: PANE, title: TITLE }))
    return started
  })

  on('command.run', { command: 'mod-prompt-toc' }, async $ => {
    // 열려 있으면 닫고, 닫혀 있으면 연다.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '질문내역 창을 닫았습니다.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '질문내역 창을 열었습니다.' }
  })

  // 사용자 글이 대화 기록에 들어간 직후 목차를 다시 그린다.
  // 질문 줄이 기록보다 먼저 그려지면 마지막 질문이 짝을 못 찾은 채 남기 때문.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type === 'user' && e.agentId === undefined) $.ui.invalidate('ui.render')
    return stored
  })

  // 내 질문 줄이 그려질 때 그 줄의 id를 기억해 둔다 (그림은 그대로)
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const kind = e.props.origin.kind
    const text = squash(e.props.text)
    if ((kind === 'composer' || kind === 'bridge') && text !== '') {
      seen.set(e.requestId, text)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    seenCount = seen.size
    const marks = await read($, marksAtom)

    // 순서는 대화 기록을 따른다. 시스템 글(<...>로 시작), 중단 알림([Request interrupted...]), 도구 결과는 뺀다.
    const stored = (await $.session.messages())
      .filter(m => m.role === 'user' && !m.toolResults?.length)
      .map(m => cleanStored(m.text))
      .filter(text => text !== '' && !text.startsWith('<') && !text.startsWith('[Request interrupted'))

    // 각 질문에 화면 줄 id를 앞에서부터 하나씩 짝짓는다
    const used = new Set<string>()
    const items = stored.map(text => {
      let id: string | undefined
      for (const [rowId, rowText] of seen) {
        if (!used.has(rowId) && text.includes(rowText.slice(0, 60))) {
          id = rowId
          break
        }
      }
      if (id) used.add(id)
      return { text, id }
    })

    if (items.length === 0) {
      return <Text dimColor>아직 적은 질문이 없습니다.</Text>
    }

    return (
      <Box flexDirection="column">
        {items.map((item, i) => {
          const id = item.id
          // 번호는 단추 밖에, 단추에는 질문 글만(선택했을 때 한 색으로 칠해지게).
          // 번호 칸은 3칸으로 고정하고 줄어들지 않게 한다. 원문자(두 칸) 뒤에 늘 한 칸이 빈다.
          // gap만 두면 긴 질문이 번호 칸을 밀어 붙여 사이 공백이 없어지는 줄이 생겼다.
          const label = circled(i + 1)
          const key = markKey(item.text)
          const isMarked = marks.includes(key)
          const style = isMarked ? { bold: true, backgroundColor: MARK_BG } : {}
          // 체크 단추는 줄 오른쪽 끝에 숨겨 두고, 이 줄에 마우스를 올릴 때만 보인다. 체크한 질문은 색으로 늘 표시.
          return (
            <Box key={`r:${i}`} flexDirection="row">
              <Box width={label.length === 1 ? 3 : label.length + 1} flexShrink={0}>
                <Text>{label}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                {id ? (
                  <Button
                    key={`q:${i}`}
                    plain
                    onPress={() => void $.ui.scroll({ to: { requestId: id }, block: 'start' })}
                  >
                    <Text wrap="truncate-end" {...style}>{item.text}</Text>
                  </Button>
                ) : (
                  <Text dimColor={!isMarked} wrap="truncate-end" {...style}>{item.text}</Text>
                )}
              </Box>
              <Box flexShrink={0} paddingLeft={1} display="none" hover={{ display: 'flex' }}>
                <Button
                  key={`m:${i}`}
                  plain
                  dimColor={!isMarked}
                  label={isMarked ? '[✓]' : '[ ]'}
                  onPress={() => void toggleMark($, key)}
                />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
