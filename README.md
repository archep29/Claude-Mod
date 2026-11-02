# Claude-Mod

Claude Code 터미널에 붙여 쓰는 모드 2개입니다.

윈도우는 TMUX 같은거 잘 되는 것도 없고 에러도 많고, ORCA는 raidrive연결이 안되고..... 클로드코드앱은 클로드코드랑 연동도 잘 안되고. 
클로드코드 쓰면서 제가 불편했던 것 중 두 가지만 만들어봤습니다. 이것만 돼도 너무 편하고 살거 같네요.  

1. 내가 만들고 있는 여러가지 프로젝트들 목록 일목요연하게 보기
2. 현재 대화창에서 내가 했던 대화 빨리 찾아가기. 중요 대화 표시해두기.

| 모드 | 하는 일 | 여는 명령 |
|---|---|---|
| `mod-session-list` | 최근 30일 세션을 프로젝트별로 보여 주는 패널. 누르면 새 탭에서 그 세션을 엽니다. | `/mod-session-list` |
| `mod-prompt-toc` | 이 대화에서 내가 적은 질문만 모아 목차로 보여 줍니다. 누르면 그 질문으로 이동합니다. | `/mod-prompt-toc` |

## 어떻게 쓰나요

아래 그림은 쓰는 법을 보여 주는 예시 화면입니다. 내용은 지어낸 것입니다.

### 세션 목록 (`mod-session-list`)

![세션 목록 패널 예시](docs/session-list.png)

![최소화했을 때 예시](docs/session-list-minimized.png)

### 내 질문 목차 (`mod-prompt-toc`)

![내 질문 목차 예시](docs/prompt-toc.png)

## 설치

Claude Code 입력창에서:

```
/plugin install mod-session-list --marketplace archep29/Claude-Mod
/plugin install mod-prompt-toc --marketplace archep29/Claude-Mod
```

`Add marketplace?`가 나오면 `y`, 범위는 Enter로 고릅니다.

명령창(셸)에서:

```
claude plugin install mod-session-list --marketplace archep29/Claude-Mod
claude plugin install mod-prompt-toc --marketplace archep29/Claude-Mod
```

데스크톱 앱에서는 입력창 옆 + → Plugins → Add marketplace에 `archep29/Claude-Mod`를 넣고 Add plugin을 누릅니다.

## mod-session-list 필요 조건

- Windows, Windows 터미널(`wt`)
- Python(`py` 명령)
- 세션을 누르면 새 탭에서 `claude --resume <세션 id>`로 엽니다.
