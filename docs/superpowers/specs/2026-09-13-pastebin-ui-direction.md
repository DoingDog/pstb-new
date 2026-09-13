# Pastebin UI Direction

日期：2026-09-13

状态：视觉与交互方向已冻结。本文从属于 [`2026-09-12-cloudflare-pastebin-rewrite-design.md`](./2026-09-12-cloudflare-pastebin-rewrite-design.md)，只细化其 React UI 表达，不改变 paste、password、HTTP、KV、view-once、active HTML、MCP 或 `/ip-trace` contract；冲突时主规格优先。

修订记录：

* 2026-09-14：同步主规格 F01-F22 修订：`/md/:id`改为 read-only React variant；OperationStatus只显示真实 event timestamp并采用 closed ActionKey；补齐 terminal consumed/source-choice、delete root feedback、credential URL exceptions与 exact pinned `use-mobile` source/pruned skeleton要求。
* 2026-09-13：用 pinned shadcn/ui `new-york-v4/sidebar-11` 与 React 19.3.0 取代 handwritten DOM/CSS workbench；将 desktop lifecycle rail改为 Sidebar、320 px navigation改为 upstream Sheet；加入 hidden question-mark help、四类 persistent operation status和 action内联反馈；删除 visible explanatory copy、sample data、generic dashboard patterns及旧 `src/client/styles.css` ownership。

## 1．设计概念：Document Workbench

界面把 paste当作正在查看或编辑的单一 document，不是 SaaS dashboard。document/editor始终是最大 surface；Sidebar只组织真实 mode、metadata与 action。没有 account、team、workspace、analytics、recent files、fake folders或 sample documents。

唯一显著结构是 document lifecycle Sidebar与 content inset的边界。其余层级依靠 typography、Separator、spacing和 selected state，不依靠 floating cards、shadow stack或装饰。

实现来源固定为：

* `shadcn-ui/ui` commit `2b3e6d4f8d9161fe5c19340dc383aade392012dd`；
* registry style `new-york-v4`；
* block `sidebar-11`；
* `shadcn@4.21.0`只 materialize source；
* React `19.3.0`、React DOM `19.3.0`、Vite `8.3.0`。

保留 block的 SidebarProvider、SidebarInset、SidebarTrigger、SidebarRail、Breadcrumb、Separator、Collapsible与 mobile Sheet composition。`sidebar.tsx`只依赖 pinned `apps/v4/registry/new-york-v4/hooks/use-mobile.tsx`；删除未使用的 `SidebarMenuSkeleton`及其 `Skeleton` import/export，不 materialize `skeleton.tsx`。所有 sample paths、files、change badges和 links必须删除。只使用主规格第4.2节列出的 official source set，并对每个实际 copied/adapted file执行同节 provenance与 notice checks。

## 2．Visual tokens

Light theme：

| Product token | Hex | shadcn mapping | 用途 |
|---|---|---|---|
| `--canvas` | `#F3F6F8` | `--background` | page background |
| `--surface` | `#FFFFFF` | `--card`、`--popover`、`--sidebar` | document、form、Sheet、Tooltip surface |
| `--ink` | `#18212B` | `--foreground`、`--card-foreground`、`--sidebar-foreground` | content与 primary label |
| `--muted` | `#526171` | `--muted-foreground` | metadata与 inactive state |
| `--rule` | `#C8D2DC` | `--border`、`--input`、`--sidebar-border` | structure boundary |
| `--signal` | `#2855A6` | `--primary`、`--ring`、`--sidebar-primary` | selected mode、primary action、focus |
| `--on-signal` | `#FFFFFF` | `--primary-foreground`、`--sidebar-primary-foreground` | signal background上的文字/icon |
| `--positive` | `#176B4D` | product status token | saved、sync applied、diff addition |
| `--danger` | `#A9213D` | `--destructive` | delete、error、diff deletion |
| `--on-danger` | `#FFFFFF` | `--destructive-foreground` | danger background上的文字/icon |

Dark theme：

| Product token | Hex | shadcn mapping | 用途 |
|---|---|---|---|
| `--canvas` | `#121820` | `--background` | page background |
| `--surface` | `#1B2430` | `--card`、`--popover`、`--sidebar` | document、form、Sheet、Tooltip surface |
| `--ink` | `#EDF2F7` | `--foreground`、`--card-foreground`、`--sidebar-foreground` | content与 primary label |
| `--muted` | `#A8B4C2` | `--muted-foreground` | metadata与 inactive state |
| `--rule` | `#394858` | `--border`、`--input`、`--sidebar-border` | structure boundary |
| `--signal` | `#8EAEFF` | `--primary`、`--ring`、`--sidebar-primary` | selected mode、primary action、focus |
| `--on-signal` | `#101722` | `--primary-foreground`、`--sidebar-primary-foreground` | signal background上的文字/icon |
| `--positive` | `#72D2AA` | product status token | saved、sync applied、diff addition |
| `--danger` | `#FF8CA3` | `--destructive` | delete、error、diff deletion |
| `--on-danger` | `#1B0B10` | `--destructive-foreground` | danger background上的文字/icon |

`src/client/index.css`只包含 Tailwind import、pinned shadcn variables、上表 product mapping、Crepe/prose/diff必须规则和 reduced-motion override。layout、spacing和 state优先使用 materialized component utilities，不保留 `src/client/styles.css`的 selector tree。

所有实际 foreground/background/state组合在 light与dark下实测 WCAG 2.2 AA。focus ring为2 CSS px且有至少2 CSS px offset或等效不被相邻颜色吞没的 ring；状态不能只靠颜色。radius固定最大6 CSS px。document与 Sidebar无 decorative shadow；Dialog和 mobile Sheet只保留 upstream辨识层级所需 shadow，overlay不 blur。

## 3．Typography

不加载 external font，也不以 asset内 font模拟品牌。

* UI family：`system-ui, -apple-system, "Segoe UI", sans-serif`。body `16px/1.55`，Label `14px/1.4`，metadata/status `13px/1.45`。
* Text family：`ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`。editor、snapshot、diff、ID和 version使用 `15px/1.62`。
* document title：UI family，`clamp(1.35rem, 2.5vw, 1.9rem)`，weight 650，line-height 1.2。没有 oversized hero。
* prose与 form目标行长72ch；editor可占完整 content inset。
* 不使用全大写 eyebrow、letter-spacing branding、单词 accent或 marketing subtitle。

## 4．Desktop layout

### 4.1 Create

```plaintext
┌────────────────────────────────────────────────────────────────────┐
│ [Sidebar]  Paste > New                         EN   Theme           │
├────────────┬───────────────────────────────────────────────────────┤
│ New paste  │ Title          Format          Expiration             │
│ Create     ├───────────────────────────────────────────────────────┤
│ Network    │                                                       │
│ Last action│                    Content                            │
│            │                                                       │
│            ├───────────────────────────────────────────────────────┤
│            │ Password   Custom ID   View once   Create paste       │
│            ├───────────────────────────────────────────────────────┤
│            │ Operation status / created resource                  │
└────────────┴───────────────────────────────────────────────────────┘
```

Sidebar采用 upstream desktop宽度16rem；content inset最宽76rem并可在较宽 viewport居中。Content Textarea至少占初始可用高度一半。created result在同一 flow中替换或跟随 submit区域，不 modal、不 navigate。

Create Sidebar只含 New paste destination和适用的 Network、Last action state。没有虚构 autosave/autosync record，没有 static product feature list。

### 4.2 Ordinary paste

```plaintext
┌────────────────────────────────────────────────────────────────────┐
│ [Sidebar]  Paste > <id>                        Actions   EN Theme   │
├────────────┬───────────────────────────────────────────────────────┤
│ View       │ View  Edit  Markdown  History  Settings               │
│ Edit       ├───────────────────────────────────────────────────────┤
│ Markdown   │                                                       │
│ History    │              Document / editor / preview              │
│ Settings   │                                                       │
│────────────│                                                       │
│ ID         ├───────────────────────────────────────────────────────┤
│ Protected  │ Autosave | Autosync | Network | Last action          │
│ Expires    │                                                       │
│ Revision   │                                                       │
└────────────┴───────────────────────────────────────────────────────┘
```

Breadcrumb表达当前 resource，不充当第二套 tabs。Sidebar mode item与 Tabs共享同一个 React selected state。raw、HTML、md、file、copy、wrap、new和 delete依宽度放在 header action group或 Sidebar action group，保持一个 DOM action source，不复制 hidden desktop/mobile controls。

Lifecycle metadata只显示真实 value。每条 explanation由相邻 `?` HelpTrigger提供。OperationStatus紧邻 document工作面且始终可见，不进入 Tooltip、toast或 footer。

History在 desktop使用15rem revision list和剩余 detail区域。diff每行有 `+`、`-`或 space prefix；背景色只辅助。Settings使用连续 Field sections与 Separator，不把每组包成 card。

### 4.3 Password、error 与 consumed

Password和 application error仍使用相同 SidebarInset/header proportions，但只有实际 field、action、error和适用 status。不得用 generic illustration、empty-state slogan或 marketing copy填充空间。

Consumed page是独立 local-only composition。Sidebar不实例化 ordinary server destinations；只列 View与 copy、wrap、raw/source toggle、safe preview、exact UTF-8 download、top-level Blob HTML和 create-new local actions。autosync或 explicit reload收到 `viewOnce:true`时，先移除 ordinary controls/URLs/status hooks，再呈现结果；ordering不确定时在同一 local-only composition中提供 current与 consumed response两个 exact source选择，不能恢复 server action。Consumed是允许直接显示的 document state；其 distributed limitation只在相邻 HelpTrigger。

`/md/:id`使用独立 read-only React composition和同一 pinned shell/primitives。它显示 server-produced safe article，并提供 local copy、download和 source/preview toggle；不显示 ordinary modes、representation links、Autosave/Autosync或 server controls，也不发 prefetch、API或第二次 content read。

## 5．Mobile and 320 CSS px

小于48rem时，permanent Sidebar完全移出 layout，由 upstream Sheet承载，宽度 `min(18rem, 100vw)`。header保留44×44 SidebarTrigger、可截断 Breadcrumb和 locale/theme controls。Sheet关闭后 content inset使用100% available viewport，不保留16rem gap。

```plaintext
┌────────────────────────┐
│ Menu  Paste > id  EN ◐ │
├────────────────────────┤
│ View Edit Markdown ... │
├────────────────────────┤
│                        │
│ document / editor      │
│                        │
├────────────────────────┤
│ Autosave   Autosync    │
│ Network    Last action │
├────────────────────────┤
│ actions wrap           │
└────────────────────────┘
```

Tabs可以在自己的 list内横向滚动，但 page不能横向滚动。actions按完整44 px targets换行。History先显示 revision list；选择后显示 detail与 Back action。Tooltip content最大宽度为 `min(22rem, calc(100vw - 2rem))`，touch click后不超出 viewport。Sheet选择 destination后关闭并把 focus移到目标 heading或返回 trigger，取决于 action是否改变 content view。

## 6．Component mapping

| Need | Official source | Product adaptation |
|---|---|---|
| Workbench shell | Sidebar、Sheet、Breadcrumb、Separator、Collapsible | real modes、metadata、actions；mobile off-canvas；`/md`只使用 read-only subset |
| Modes与 history detail | Tabs | automatic activation、roving focus、single React state owner |
| Forms | Field、Label、Input、Textarea、Button | visible labels、inline validation、no explanatory paragraph |
| Context help | Tooltip + Button | controlled hover/focus/click/touch `HelpTrigger`，`?` glyph |
| Destructive confirmation | Dialog + Button | delete/discard/reload only；explicit final action |
| Operation feedback | React semantic status markup + Separator | four persistent records；不新增 component package |

primary Button每个 active form最多一个。secondary action使用 outline或 ghost variant，danger只用于 destructive action。button不全部变成 pills。icon-only button必须有 accessible name；能显示短动词时优先 icon加文字。

`Tooltip`不能代替 accessible name。`Dialog`不能承载 save/sync/network/copy反馈。Sheet不能变成 persistent overlay。Collapsible只用于 Sidebar grouping和 progressive navigation，不隐藏操作必需字段。

## 7．Help and visible-copy policy

页面常态可见文本仅包括：

1. content Field labels与当前 values；
2. document metadata与 modes；
3. actions；
4. validation/errors；
5. live operation state和 localized timestamps。

所有 explanation、warning、limitation、encoding/storage/limit prose和 common-knowledge hint放在 question-mark HelpTrigger。具体包括 view-once semantics、KV eventual consistency、exact plaintext/UTF-8 storage、10 MiB limit、password query exposure、relative expiration计算、active HTML能力、Markdown normalization、autosave和 autosync行为、large diff threshold。

HelpTrigger遵守主规格17.3：hover/focus打开，click/touch toggle pinned，Escape/outside关闭，44 px target，stable relationship和本地化 accessible name。Help内容不能包含唯一必需 control或 value。关闭全部 HelpTrigger后，automated visible-text scan不得找到以上 prose或 upstream sample copy。

validation/error直接靠近 control显示，并提供明确 recovery action。不要用 placeholder说明格式；使用 Label、value choice和 invalid state。destructive Dialog中的 consequence copy属于 required confirmation，可以在 Dialog打开后直接显示。

## 8．Persistent operation status

ordinary paste的 OperationStatus是一个平整区域，由 Separator与四个 records构成：Autosave、Autosync、Network、Last action。desktop单行四列；中等宽度2×2；320 px可2×2或单列，以不截断 state/action为准。

每个 record显示 Label、localized current state，并且只在主规格为当前 state定义的 exact event timestamp存在时显示 `<time>`。initial Autosave clean、initial Autosync waiting和 Last action idle没有 timestamp；不得以 load/current time补齐。Autosync unchanged显示 `checkedAt`，remote-applied显示 `appliedAt`，其余 transition显示本次 `stateChangedAt`，因此 success后 failure显示 failure time。Autosave remote/reload clean不生成 `confirmedAt`。没有 relative countdown、spinner-only state或每秒更新。Autosave与Autosync不能合并成一个 Sync badge。Network不把 HTTP error称为 offline。Last action不显示 password、body或 protected URL。

state change通过一个 polite live region增量宣布。视觉状态使用文字加 icon，再辅以颜色。只有主规格 closed `ActionKey`中的 request或 fallible browser operation同时更新 originating Button和 Last action；结果保持到下一次同 key或明确 page transition，不在数秒后消失。HelpTrigger、Sidebar、mode/tab、locale/theme、password reveal、wrap、raw/source等 pure state toggles和无法在 origin document观察结果的 navigation不产生 pending/success/failure。delete 204在清除 sensitive references并 `history.replaceState`到 `/`后，把 query-independent success保留在 root Last action；refresh不 replay。

## 9．Motion

不做 page-load entrance、fade-up、pulse、skeleton shimmer、decorative parallax或 status bounce。允许：

* Tabs selected indicator最多120 ms；
* upstream Sheet/Dialog open-close最多120 ms；
* operation state color最多120 ms，文字立即更新。

`prefers-reduced-motion: reduce`时全部 transition和 animation取消。loading仍以文字和 busy semantics表达。

## 10．Locale、theme 与 content boundaries

所有 visible text、Tooltip content、accessible names、Button outcome和 status state在 `en`与 `zh-CN` dictionary中 parity。locale切换不改变 IDs、technical names或 timestamps的 RFC3339 `datetime`值。

Theme只有 system、light和dark document-local状态，不写 storage。系统变更与 override规则按主规格17.12。theme不得改变 user `/html/:id` representation。

React以 normal text children或 controlled value显示 source、title、snapshot和 diff。只有 fixed micromark renderer output进入 trusted safe-Markdown boundary；`/md/:id`的 wrapper也由 read-only React branch生成，server只提供 inert exact source与 safe fragment。active HTML只通过 direct route或 consumed page Blob navigation，不 iframe、不 preview card、不 sanitizer替代。

protected representation anchor `href`、明确复制的 representation link和 current location是 plaintext query password的仅有 URL-transport exceptions。bootstrap links始终 credential-free；visible text、status、inert data、unrelated attributes、application-authored logs和 errors不得包含 password或 protected URL。允许的 URL request仍可能进入主规格第9.3节所列 infrastructure logs。

## 11．Accessibility and browser acceptance

* 每个 input有visible Label和 inline error relationship；HelpTrigger提供 explanation relationship。
* Tabs覆盖 Left/Right、Home/End、automatic activation、roving focus和正常 Tab exit。
* SidebarTrigger、Sheet、Dialog与 Tooltip覆盖 initial focus、Escape、outside interaction、focus return和 nested ownership。
* 全部 target至少44×44 CSS px；focus visible；200% zoom和320 px reflow无 page overflow。
* state/error/loading/diff不只依赖颜色或 motion；diff保留 prefix。
* source Textarea在 Crepe失败、offline、403、404、409或503后仍可操作；draft不被 layout remount清除。
* light/dark normal text与 controls达到 WCAG 2.2 AA；manual screen-reader与 touch smoke补充 automated checks。
* Chromium、Firefox、WebKit自动 journey与 current stable Edge/Safari smoke按主规格current-two-major matrix执行。

## 12．Visual acceptance gates

1. `FE01`：create、paste、password、application error和 read-only `/md`的 visible DOM均由 React `createRoot`产生；server shell没有旧 workbench或 Markdown wrapper markup；`/md`没有 ordinary controllers。
2. `FE04`：old `src/client/app.ts`、`src/client/styles.css`、imperative visible binders和 unintegrated tabs candidate均未保留。
3. `FE05`：source provenance exact；Sidebar没有 sample data；320 px使用 Sheet且 editor full width；无 dashboard/card/gradient/glass/external-font pattern。
4. `FE06`：关闭 HelpTrigger时无 explanation、warning、limitation、storage/encoding/limit prose；keyboard、pointer和 touch均可打开与关闭 help。
5. `FE07`：Autosave、Autosync、Network、Last action各自常驻；fresh clean/waiting/idle无 fabricated timestamp，后续 state选择主规格规定的 event time，failure不显示旧 success time。
6. `FE08`：closed ActionKey operation的 Button与 status同步显示 persistent outcome；pure toggles与不可观测 navigation不改 Last action；operation feedback没有 Dialog、toast、snackbar、`alert()`或额外 request。
7. `FE09`：en/zh-CN、system/light/dark、reduced motion、44 px、focus、WCAG 2.2 AA、320 px和 browser matrix全部通过。
8. `FE10`：每个实际 adapted/materialized source及 pinned `use-mobile.tsx`有 exact provenance；`SidebarMenuSkeleton`/`skeleton.tsx`不存在；`THIRD_PARTY_NOTICES.md`只枚举 resulting source set并包含主规格要求的 notices/licenses。
