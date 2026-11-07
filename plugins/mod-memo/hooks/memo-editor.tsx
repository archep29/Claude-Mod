import type { ClientKeyEvent, ClientModule, ClientPointerEvent } from 'claude-code'

import type { EditorProps } from '../types'

// 메모 편집기. 입력칸은 Tab·Backspace를 받지 못해 키를 직접 받아 그린다.
// 파일은 마크다운 목록(- 상위 / 「  - 하위」 / - [x] 완료)이고, 바뀔 때마다 줄 전체를 register.tsx로 보낸다.

type Item = { sub: boolean; done: boolean; folded: boolean; text: string }
type Snapshot = { items: Item[]; row: number; col: number }
type Position = { row: number; col: number }
// anchor: 선택을 시작한 곳. 커서까지가 선택 구간이다.
// showCursor: 키보드가 메모에 있을 때만 켠다. promptEdits: 마지막으로 본 입력창 고친 횟수.
type State = Snapshot & {
  version: number; top: number; undo: Snapshot[]; lastEdit: string; anchor: Position | null; dragging: boolean
  showCursor: boolean; promptEdits: number; clipId: number | undefined
}
type VisualRow = { row: number; start: number; chars: string[] }

const FOLD_MARK = ' <!--접음-->' // 마크다운에 접기가 없어, 보기 프로그램에서 안 보이는 주석으로 남긴다
const LINE = /^(\s*)(?:[-*+](?: |$))?(?:\[[xX]\] )?/
const UNDO_LIMIT = 100
const BUTTON_CELLS = 7 // 줄 오른쪽 「▲ ▼ ×」 칸
const FALLBACK_COLUMNS = 40 // 처음 그릴 때는 칸 수를 아직 모른다
const CURSOR_BG = '#c0c0c0'
const CURSOR_FG = '#000000'
const SELECT_BG = '#2f5f9e'
const SPECIAL_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'escape',
  'pageup', 'pagedown', 'home', 'end', 'insert',
])

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const cellWidth = (ch: string) => (WIDE.test(ch) ? 2 : 1)
const charsOf = (text: string) => [...text]

function parseLine(raw: string): Item {
  const folded = raw.endsWith(FOLD_MARK)
  const line = folded ? raw.slice(0, -FOLD_MARK.length) : raw
  const head = LINE.exec(line)?.[0] ?? ''
  return { sub: /^\s/.test(line), done: /\[[xX]\] $/.test(head), folded, text: line.slice(head.length) }
}

const formatLine = (item: Item) =>
  `${item.sub ? '  ' : ''}- ${item.done ? '[x] ' : ''}${item.text}${item.folded ? FOLD_MARK : ''}`

const emptyItem = (sub: boolean): Item => ({ sub, done: false, folded: false, text: '' })

const hasChildren = (items: Item[], row: number) => !items[row].sub && items[row + 1]?.sub === true

// 접힌 상위 아래의 하위 줄은 건너뛴다.
function visibleRows(items: Item[]): number[] {
  const rows: number[] = []
  let hidden = false
  items.forEach((item, row) => {
    if (!item.sub) hidden = item.folded
    if (!item.sub || !hidden) rows.push(row)
  })
  return rows
}

// row 줄과 그 하위 줄들이 끝나는 다음 번호
function blockEnd(items: Item[], row: number): number {
  let end = row + 1
  while (end < items.length && items[end].sub) end++
  return end
}

// 한 칸 위(-1)·아래(+1)로. 상위 줄은 하위 줄과 함께 옆 묶음과 자리를 바꾼다. 끝이면 그대로.
function movedItems(items: Item[], row: number, step: number): Item[] {
  if (items[row].sub) {
    const to = row + step
    return to < 0 || to >= items.length ? items : items.with(row, items[to]).with(to, items[row])
  }
  const end = blockEnd(items, row)
  if (step < 0) {
    if (row === 0) return items
    let start = row - 1
    while (start > 0 && items[start].sub) start--
    return [...items.slice(0, start), ...items.slice(row, end), ...items.slice(start, row), ...items.slice(end)]
  }
  if (end >= items.length) return items
  const nextEnd = blockEnd(items, end)
  return [...items.slice(0, row), ...items.slice(end, nextEnd), ...items.slice(row, end), ...items.slice(nextEnd)]
}

// edit가 같으면(글자를 이어 칠 때) 되돌리기 한 번에 묶는다.
function changed(s: State, items: Item[], row: number, col: number, edit = ''): State {
  const undo = edit && edit === s.lastEdit
    ? s.undo
    : [...s.undo, { items: s.items, row: s.row, col: s.col }].slice(-UNDO_LIMIT)
  return { ...s, items, row, col, undo, lastEdit: edit, anchor: null }
}

// 선택 구간을 앞뒤 순서로. 없거나 글자가 없으면 null.
function selectionOf(s: State): { start: Position; end: Position } | null {
  const { anchor } = s
  if (!anchor || (anchor.row === s.row && anchor.col === s.col)) return null
  const cursor = { row: s.row, col: s.col }
  const anchorFirst = anchor.row < s.row || (anchor.row === s.row && anchor.col < s.col)
  return anchorFirst ? { start: anchor, end: cursor } : { start: cursor, end: anchor }
}

function selectedText(s: State): string {
  const selection = selectionOf(s)
  if (!selection) return ''
  const { start, end } = selection
  return s.items.slice(start.row, end.row + 1).map((item, index) => {
    const row = start.row + index
    const chars = charsOf(item.text)
    return chars.slice(row === start.row ? start.col : 0, row === end.row ? end.col : chars.length).join('')
  }).join('\n')
}

function deleteSelection(s: State): State {
  const selection = selectionOf(s)
  if (!selection) return s
  const { start, end } = selection
  const before = charsOf(s.items[start.row].text).slice(0, start.col).join('')
  const after = charsOf(s.items[end.row].text).slice(end.col).join('')
  const items = [
    ...s.items.slice(0, start.row),
    { ...s.items[start.row], text: before + after },
    ...s.items.slice(end.row + 1),
  ]
  return changed(s, items, start.row, start.col)
}

const setItem = (s: State, patch: Partial<Item>) => s.items.with(s.row, { ...s.items[s.row], ...patch })

function typeText(s: State, text: string): State {
  const chars = charsOf(s.items[s.row].text)
  const typed = charsOf(text.replace(/\r?\n/g, ' '))
  chars.splice(s.col, 0, ...typed)
  return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col + typed.length, 'type')
}

// 커서 뒤 글자는 다음 줄로 내려간다. 펼친 상위 줄이면 첫 하위 줄이 된다.
function pressEnter(s: State): State {
  const item = s.items[s.row]
  const chars = charsOf(item.text)
  const at = item.folded ? blockEnd(s.items, s.row) : s.row + 1
  const sub = item.sub || (hasChildren(s.items, s.row) && !item.folded)
  const next = { ...emptyItem(sub), text: chars.slice(s.col).join('') }
  const items = setItem(s, { text: chars.slice(0, s.col).join('') }).toSpliced(at, 0, next)
  return changed(s, items, at, 0)
}

function setLevel(s: State, sub: boolean): State {
  if (s.items[s.row].sub === sub || (sub && s.row === 0)) return s
  // 접힌 상위 밑으로 들어가면 안 보이게 되므로 그 상위를 펼친다.
  let parent = s.row - 1
  while (parent > 0 && s.items[parent].sub) parent--
  const items = setItem(s, sub ? { sub, folded: false } : { sub })
  return changed(s, sub ? items.with(parent, { ...items[parent], folded: false }) : items, s.row, s.col)
}

// 앞 줄 끝에 이 줄 글자를 붙이고 이 줄을 없앤다.
function mergeInto(s: State, target: number, source: number): State {
  const joinAt = charsOf(s.items[target].text).length
  const items = s.items
    .with(target, { ...s.items[target], text: s.items[target].text + s.items[source].text })
    .toSpliced(source, 1)
  return changed(s, items, target, joinAt)
}

const neighbor = (s: State, step: number) => {
  const rows = visibleRows(s.items)
  return rows[rows.indexOf(s.row) + step]
}

function pressBackspace(s: State): State {
  if (s.col > 0) {
    const chars = charsOf(s.items[s.row].text)
    chars.splice(s.col - 1, 1)
    return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col - 1, 'erase')
  }
  const before = neighbor(s, -1)
  return before === undefined ? s : mergeInto(s, before, s.row)
}

function pressDelete(s: State): State {
  const chars = charsOf(s.items[s.row].text)
  if (s.col < chars.length) {
    chars.splice(s.col, 1)
    return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col, 'erase')
  }
  const after = neighbor(s, 1)
  return after === undefined ? s : mergeInto(s, s.row, after)
}

function moveCursor(s: State, step: number, atEnd?: boolean): State {
  const row = neighbor(s, step)
  if (row === undefined) return s
  const length = charsOf(s.items[row].text).length
  return { ...s, row, col: atEnd ? length : Math.min(s.col, length), lastEdit: '' }
}

function moveLeftRight(s: State, step: number): State {
  const col = s.col + step
  if (col < 0) return moveCursor({ ...s, col: 0 }, -1, true)
  if (col > charsOf(s.items[s.row].text).length) return { ...moveCursor(s, 1), col: 0 }
  return { ...s, col, lastEdit: '' }
}

function moveItem(s: State, row: number, step: number): State {
  const item = s.items[row]
  const items = movedItems(s.items, row, step)
  return items === s.items ? s : changed(s, items, items.indexOf(item), s.col)
}

function removeItem(s: State, row: number): State {
  if (s.items.length === 1) return changed(s, [emptyItem(false)], 0, 0)
  const items = s.items.toSpliced(row, 1)
  return changed(s, items, Math.min(row, items.length - 1), 0)
}

const toggleDone = (s: State, row: number) =>
  changed(s, s.items.with(row, { ...s.items[row], done: !s.items[row].done }), s.row, s.col)

function toggleFold(s: State, row: number): State {
  const folded = !s.items[row].folded
  const items = s.items.with(row, { ...s.items[row], folded })
  // 접어서 커서 줄이 숨으면 상위 줄로 옮긴다.
  const hidden = folded && s.row > row && s.row < blockEnd(items, row)
  return changed(s, items, hidden ? row : s.row, hidden ? 0 : s.col)
}

function undo(s: State): State {
  const last = s.undo.at(-1)
  return last ? { ...s, ...last, undo: s.undo.slice(0, -1), lastEdit: '', anchor: null } : s
}

function moveKey(s: State, key: string): State | undefined {
  switch (key) {
    case 'up': return moveCursor(s, -1)
    case 'down': return moveCursor(s, 1)
    case 'left': return moveLeftRight(s, -1)
    case 'right': return moveLeftRight(s, 1)
    case 'home': return { ...s, col: 0, lastEdit: '' }
    case 'end': return { ...s, col: charsOf(s.items[s.row].text).length, lastEdit: '' }
    default: return undefined
  }
}

// 여러 줄이면 줄마다 같은 단계의 불렛이 된다. 커서 뒤 글자는 마지막 줄 끝으로 간다.
function pasteText(state: State, text: string): State {
  const s = deleteSelection(state)
  const lines = text.split('\n')
  if (lines.length === 1) return typeText(s, text)
  const item = s.items[s.row]
  const chars = charsOf(item.text)
  const added = lines.slice(1).map(line => ({ ...emptyItem(item.sub), text: line }))
  const last = added.length - 1
  const col = charsOf(added[last].text).length
  added[last].text += chars.slice(s.col).join('')
  const items = [
    ...s.items.slice(0, s.row),
    { ...item, text: chars.slice(0, s.col).join('') + lines[0] },
    ...added,
    ...s.items.slice(s.row + 1),
  ]
  return changed(s, items, s.row + added.length, col)
}

function pressKey(s: State, e: ClientKeyEvent): State {
  if (e.ctrl) {
    if (e.key === 'z') return undo(s)
    if (e.key === 'k') return toggleDone(s, s.row) // Ctrl+D는 Claude Code의 종료 키라 쓰지 않는다
    if (e.key === 'up') return moveItem(s, s.row, -1)
    if (e.key === 'down') return moveItem(s, s.row, 1)
    return s
  }
  if (e.meta) return s
  const moved = moveKey(s, e.key)
  if (moved) return { ...moved, anchor: e.shift ? (s.anchor ?? { row: s.row, col: s.col }) : null }
  const hasSelection = selectionOf(s) !== null
  switch (e.key) {
    case 'return':
    case 'enter': return pressEnter(deleteSelection(s))
    case 'tab': return setLevel({ ...s, anchor: null }, !e.shift)
    case 'backspace': return hasSelection ? deleteSelection(s) : pressBackspace(s)
    case 'delete': return hasSelection ? deleteSelection(s) : pressDelete(s)
    case 'space': return typeText(deleteSelection(s), ' ')
    default: return SPECIAL_KEYS.has(e.key) || /^f\d+$/.test(e.key) ? s : typeText(deleteSelection(s), e.key)
  }
}

// 줄 앞 칸: 접기 2칸 + 불렛 2칸, 하위는 2칸 더 들여쓴다.
const bulletCell = (item: Item) => (item.sub ? 4 : 2)
const textStart = (item: Item) => bulletCell(item) + 2

// 칸 수에 맞춰 줄을 나눈다. 빈 줄도 화면 한 줄을 차지한다.
function wrapItem(item: Item, row: number, cells: number): VisualRow[] {
  const rows: VisualRow[] = []
  let start = 0
  let chars: string[] = []
  let used = 0
  charsOf(item.text).forEach((ch, index) => {
    const width = cellWidth(ch)
    if (used + width > cells) {
      rows.push({ row, start, chars })
      start = index
      chars = []
      used = 0
    }
    chars.push(ch)
    used += width
  })
  rows.push({ row, start, chars })
  return rows
}

function colAtCell(visual: VisualRow, cell: number): number {
  let used = 0
  for (let index = 0; index < visual.chars.length; index++) {
    used += cellWidth(visual.chars[index])
    if (cell < used) return visual.start + index
  }
  return visual.start + visual.chars.length
}

function pressPointer(s: State, rows: VisualRow[], top: number, e: ClientPointerEvent): State {
  const visual = rows[top + e.y]
  if (!visual) return s
  const item = s.items[visual.row]
  const isFirst = visual.start === 0
  if (isFirst && e.x < 2 && hasChildren(s.items, visual.row)) return toggleFold(s, visual.row)
  if (isFirst && e.x >= bulletCell(item) && e.x < textStart(item)) return toggleDone(s, visual.row)
  return { ...s, ...positionAt(s, rows, top, e), lastEdit: '', anchor: null, dragging: true }
}

// 끌다가 영역 밖으로 나가도 가장 가까운 줄로 본다.
function positionAt(s: State, rows: VisualRow[], top: number, e: ClientPointerEvent): Position {
  const visual = rows[Math.max(0, Math.min(rows.length - 1, top + e.y))]
  return { row: visual.row, col: colAtCell(visual, e.x - textStart(s.items[visual.row])) }
}

function fromProps(memo: EditorProps, old: State | undefined): State {
  const items = memo.lines.length ? memo.lines.map(parseLine) : [emptyItem(false)]
  const row = Math.min(old?.row ?? 0, items.length - 1)
  return {
    items, row, col: Math.min(old?.col ?? 0, charsOf(items[row].text).length),
    version: memo.version, top: old?.top ?? 0, undo: [], lastEdit: '', anchor: null, dragging: false,
    showCursor: old?.showCursor ?? false, promptEdits: old?.promptEdits ?? memo.promptEdits,
    clipId: old ? old.clipId : memo.clip?.id,
  }
}

const MemoEditor: ClientModule<EditorProps, State> = (memo, surface) => {
  const { Box, Text, Button } = surface.elements
  const old = surface.state
  const loaded = old && old.version === memo.version ? old : fromProps(memo, old)
  const s = loaded.promptEdits === memo.promptEdits
    ? loaded
    : { ...loaded, showCursor: false, promptEdits: memo.promptEdits }

  const columns = surface.columns || FALLBACK_COLUMNS
  const rowsShown = Math.max(1, (surface.rows || 12) - 2) // 맨 아래 두 줄은 여백과 되돌리기 단추

  // 한 화면이 그려지기 전에 키가 여러 번 와도 빠지지 않게 최신 상태를 따로 든다.
  let current = s
  const apply = (next: State) => {
    if (next === current) return
    const itemsChanged = next.items !== current.items
    current = next
    surface.setState(next)
    if (itemsChanged) surface.post({ lines: next.items.map(formatLine) })
  }

  // Ctrl+C는 Claude Code가 먼저 가져가므로, 고르면 바로 복사한다.
  const copySelection = () => {
    const text = selectedText(current)
    if (text) surface.post({ copy: text })
  }

  // 클립보드를 읽어 달라고 하기 전에 상태를 남겨 둬야 돌아온 글을 새 글로 알아본다.
  const requestPaste = () => {
    apply({ ...current, showCursor: true })
    surface.post({ paste: true })
  }

  if (memo.clip && memo.clip.id !== current.clipId) {
    apply({ ...pasteText(current, memo.clip.text), clipId: memo.clip.id, showCursor: true })
  }

  const rows = visibleRows(s.items).flatMap(row => {
    const cells = Math.max(4, columns - textStart(s.items[row]) - BUTTON_CELLS)
    return wrapItem(s.items[row], row, cells)
  })

  // 커서가 있는 화면 줄이 보이게 위치를 맞춘다.
  const cursorRow = rows.findLastIndex(v => v.row === s.row && v.start <= s.col)
  const top = Math.min(Math.max(s.top, cursorRow - rowsShown + 1), cursorRow)
  s.top = top

  surface.onKey(e => {
    apply({ ...pressKey(current, e), showCursor: true })
    if (e.shift) copySelection()
  })
  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'right') {
      requestPaste()
    } else if (e.type === 'down' && e.button === 'left') {
      apply({ ...pressPointer(current, rows, top, e), showCursor: true })
    } else if (e.type === 'move' && current.dragging) {
      const anchor = current.anchor ?? { row: current.row, col: current.col }
      apply({ ...current, ...positionAt(current, rows, top, e), anchor })
    } else if (e.type === 'up' && current.dragging) {
      apply({ ...current, dragging: false })
      copySelection()
    } else if (e.type === 'leave' && !current.dragging) {
      apply({ ...current, showCursor: false }) // 입력창으로 가는 길. 메모에 계속 치면 다시 켜진다.
    }
  })

  const drawText = (visual: VisualRow, index: number, item: Item) => {
    const isCursorRow = index === cursorRow
    const look = { dimColor: item.done, strikethrough: item.done }
    const selection = selectionOf(s)
    if (selection) {
      const { start, end } = selection
      if (visual.row < start.row || visual.row > end.row) return <Text {...look}>{visual.chars.join('')}</Text>
      const clamp = (at: number) => Math.max(0, Math.min(visual.chars.length, at))
      const from = visual.row === start.row ? clamp(start.col - visual.start) : 0
      const to = visual.row === end.row ? clamp(end.col - visual.start) : visual.chars.length
      return (
        <Text>
          <Text {...look}>{visual.chars.slice(0, from).join('')}</Text>
          <Text backgroundColor={SELECT_BG}>{visual.chars.slice(from, to).join('')}</Text>
          <Text {...look}>{visual.chars.slice(to).join('')}</Text>
        </Text>
      )
    }
    if (!isCursorRow || !s.showCursor) return <Text {...look}>{visual.chars.join('')}</Text>
    const at = s.col - visual.start
    return (
      <Text>
        <Text {...look}>{visual.chars.slice(0, at).join('')}</Text>
        <Text backgroundColor={CURSOR_BG} color={CURSOR_FG}>{visual.chars[at] ?? ' '}</Text>
        <Text {...look}>{visual.chars.slice(at + 1).join('')}</Text>
      </Text>
    )
  }

  const prefix = (visual: VisualRow) => {
    const item = s.items[visual.row]
    if (visual.start > 0) return ' '.repeat(textStart(item))
    const fold = hasChildren(s.items, visual.row) ? (item.folded ? '▸ ' : '▾ ') : '  '
    const bullet = item.done ? '☑ ' : item.sub ? '◦ ' : '• '
    return `${item.sub ? `${fold}  ` : fold}${bullet}`
  }

  return (
    <Box flexDirection="column">
      {rows.slice(top, top + rowsShown).map((visual, offset) => {
        const index = top + offset
        const item = s.items[visual.row]
        const showButtons = visual.row === s.row && visual.start === 0
        return (
          <Box key={`r:${visual.row}:${visual.start}`} flexDirection="row">
            <Box width={columns - BUTTON_CELLS} flexDirection="row">
              <Text>{prefix(visual)}</Text>
              {drawText(visual, index, item)}
            </Box>
            {showButtons && (
              <Box flexDirection="row" gap={1}>
                <Button key="up" plain dimColor label="▲" onPress={() => apply(moveItem(current, current.row, -1))} />
                <Button key="down" plain dimColor label="▼" onPress={() => apply(moveItem(current, current.row, 1))} />
                <Button key="del" plain dimColor label="×" onPress={() => apply(removeItem(current, current.row))} />
              </Box>
            )}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="undo" plain dimColor label="↶ 되돌리기" onPress={() => apply(undo(current))} />
        <Button key="paste" plain dimColor label="붙여넣기" onPress={requestPaste} />
        {selectionOf(s) && <Text dimColor>복사됨</Text>}
      </Box>
    </Box>
  )
}

export default MemoEditor
