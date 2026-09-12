# Pastebin UI Direction

日期：2026-09-13

适用范围：`src/render.ts`、`src/client/app.ts`、`src/client/styles.css` 和 Playwright visual acceptance。本文只约束视觉与交互表达，不改变 paste、password、HTTP、MCP 或 KV contract。

## 1．设计概念：Document Workbench

界面把 paste 当作正在校阅的文本工件，而不是一个 SaaS dashboard。主要视觉结构是 document workbench：正文占据最大区域，左侧或顶部的 lifecycle rail 显示 ID、protected、view-once、expiry、revision 和 save state。rail 中每一项都对应真实状态，不使用装饰性编号或无意义 badge。

唯一的高识别度元素是 lifecycle rail。其他区域保持平整、克制，不使用渐变、成组浮空 cards、玻璃效果、装饰性插图或普遍阴影。

## 2．Color tokens

Light theme：

| Token | Hex | 用途 |
|---|---|---|
| `--canvas` | `#F3F6F8` | 页面背景，冷灰纸面。 |
| `--surface` | `#FFFFFF` | 正文和 form 工作面。 |
| `--ink` | `#18212B` | 正文与主要 label。 |
| `--muted` | `#526171` | metadata 与次要说明。 |
| `--rule` | `#C8D2DC` | 结构边界和分隔线。 |
| `--signal` | `#2855A6` | 当前 mode、主要 action、focus。 |
| `--positive` | `#176B4D` | saved、success、addition。 |
| `--danger` | `#A9213D` | delete、error、deletion。 |

Dark theme：

| Token | Hex | 用途 |
|---|---|---|
| `--canvas` | `#121820` | 页面背景。 |
| `--surface` | `#1B2430` | 正文和 form 工作面。 |
| `--ink` | `#EDF2F7` | 正文与主要 label。 |
| `--muted` | `#A8B4C2` | metadata 与次要说明。 |
| `--rule` | `#394858` | 结构边界和分隔线。 |
| `--signal` | `#8EAEFF` | 当前 mode、主要 action、focus。 |
| `--positive` | `#72D2AA` | saved、success、addition。 |
| `--danger` | `#FF8CA3` | delete、error、deletion。 |

所有 foreground/background 组合必须实测达到 WCAG 2.2 AA。focus ring 使用 `2px solid var(--signal)` 加 `2px` offset，不依赖颜色表达状态。

## 3．Typography

不加载外部 font，避免启动请求并符合 `font-src 'self' data:`。

- UI family：`system-ui, -apple-system, "Segoe UI", sans-serif`。正文 `16px/1.55`，label `14px/1.4`，metadata `13px/1.45`。
- Text family：`ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`。editor、snapshot、diff、ID 和 version 使用 `15px/1.62`。
- 页面 title 使用 UI family、`clamp(1.45rem, 3vw, 2.15rem)`、weight 650、紧凑 line-height；不使用超大 hero headline。
- 不使用全大写 eyebrow、不对 headline 中单个词做 accent、不用 letter-spacing 模拟品牌。
- prose 与 form line length 以 `72ch` 为目标，editor 工作面可更宽。

## 4．Layout

### 4.1 Desktop create

```plaintext
┌──────────────────────────────────────────────────────────────────┐
│ Paste                                               EN  Light    │
├───────────────┬──────────────────────────────────────────────────┤
│ New document  │ Title     Format      Expiration                 │
│               ├──────────────────────────────────────────────────┤
│ Exact text    │                                                  │
│ UTF-8         │                 Content editor                   │
│ 10 MiB max    │                                                  │
│               ├──────────────────────────────────────────────────┤
│               │ Password   Custom ID   View once      Create     │
└───────────────┴──────────────────────────────────────────────────┘
```

左 rail 固定 `12rem`，右工作面流式增长，总宽不超过 `76rem`。Content editor 是页面主角，至少占初始 viewport 可用高度的一半。create success 在同一工作面下方替换 submit status 区，不弹 modal，不自动跳转。

### 4.2 Desktop paste

```plaintext
┌──────────────────────────────────────────────────────────────────┐
│ Paste / example-id                          Copy  Raw  File  ⋯   │
├───────────────┬──────────────────────────────────────────────────┤
│ protected     │ View  Edit  Markdown  History  Settings          │
│ expires       ├──────────────────────────────────────────────────┤
│ revision      │                                                  │
│ save status   │             Document / editor / preview          │
│ byte size     │                                                  │
│               ├──────────────────────────────────────────────────┤
│               │ Context actions and aria-live status             │
└───────────────┴──────────────────────────────────────────────────┘
```

header 的 `Paste / <id>` 表达当前位置。lifecycle rail 垂直排列真实状态，save state 与 revision 靠近 editor，不隐藏在 toast。tabs 是工作面上边界的一部分，不做独立 pill navigation。

History 使用实际两栏：左侧 revision rows 宽 `15rem`，右侧 diff/snapshot 占剩余区域。diff 每行固定有 `+`、`-` 或空格 prefix，背景色只是辅助。

### 4.3 Mobile，320 px

```plaintext
┌──────────────────────┐
│ Paste / id     EN ◐  │
│ protected · expires  │
├──────────────────────┤
│ horizontally scrollable tabs │
├──────────────────────┤
│                      │
│ document / editor    │
│                      │
├──────────────────────┤
│ actions wrap to rows │
└──────────────────────┘
```

在小于 `48rem` 时，lifecycle rail 变成 header 下的 compact status strip，metadata 以换行 list 呈现，不使用中点拼接字符串。History 先显示 revision list，选择后显示 detail，并提供明确 Back。页面本身不得横向 overflow，只有 code、editor 或 diff viewport 可局部滚动。

## 5．Components and states

- Buttons 分为 primary、quiet、danger 三种。primary 每个 view 最多一个；quiet action 用文字和结构边界，不全部装进圆角 pills。
- Border radius 只用于输入框、button 和 dialog，范围 `3px..6px`。document 工作面和 rail 使用直线边界，不加 card shadow。
- Input error 紧跟对应 control，并由 `aria-describedby` 关联。blocking error 使用 `role="alert"`。
- Save state 常驻 editor 附近：Editing、Saving、Saved、Retry、Conflict。加载状态同时显示文字，不只显示 animation。
- password reveal 是独立 button，有动态 accessible name。password input 不复制到任何 decorative node。
- view-once restricted page 用 compact notice 解释已消费和跨地域限制，只显示 local copy、wrap、preview、download 与 Blob HTML actions。
- delete dialog 是唯一允许 modal elevation 的元素；背景 overlay 不做 blur。focus trap、Escape 和 explicit Delete button 按主 spec。
- Empty history 给出“正文实际修改并保存后，prior revision 会出现在这里”，不使用情绪化空状态。

## 6．Motion

不做 page-load entrance、section fade-up 或持续 pulse。允许的 motion 只有：

- tab indicator 在 `120ms` 内移动或直接切换；
- dialog 打开关闭使用 opacity `120ms`；
- save status 在 text change 时使用一次 `120ms` color transition。

`prefers-reduced-motion: reduce` 时全部取消。任何功能不依赖 motion。

## 7．Bilingual copy

English 使用 sentence case 和直接动词，例如 Create paste、Save settings、Delete paste、Retry save。简体中文使用创建剪贴板、保存设置、删除剪贴板、重试保存。technical identifiers 保持 raw、HTML、Markdown、MCP、ID、version。

同一个 action 的 button、success status 和 error recovery 使用相同动词。错误说明包含下一步，例如“保存失败。草稿仍在此页面，可重试或下载。”，不使用“Something went wrong”。

## 8．Self-critique and revision

初稿曾考虑使用米白纸张、serif title 和编辑批注红色，这与常见生成式 editorial theme 过于接近，因此改为冷灰技术工作面和系统 UI typography。初稿还考虑把 settings 放入多个 rounded cards，但这会形成通用 SaaS-card kit，因此改为由 rule 分隔的连续 form sections。

最终方向只在 lifecycle rail 上使用明显身份，其余布局由文本编辑、版本比较和状态反馈的真实结构决定。该方向不依赖外部字体、illustration、gradient 或 decorative animation，可在 hashed CSS 和 server-rendered semantic HTML 中直接实现。

## 9．Acceptance

Task 9 implementer 和 reviewer必须检查：

1. desktop 与 320 px layout 符合以上结构，页面级 horizontal overflow 为 0；
2. light/dark 颜色组合达到 AA；
3. initial app 没有额外 font/image request；
4. lifecycle rail 的每个 item 都来自真实 paste state；
5. tabs、dialog、password、status 和 diff 满足主 spec 的 keyboard/ARIA 要求；
6. 没有 gradient、glass、decorative card grid、全大写 eyebrow、无意义编号或通用 hero；
7. view-once restricted UI 不出现 server edit、history、settings 或 delete。
