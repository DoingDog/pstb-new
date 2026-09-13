# React template selection for a static Document Workbench

**Decision date:** 2026-09-13

**Scope:** Open-source React templates, blocks, and their first-party component ecosystems

**Decision:** Adopt shadcn/ui `new-york-v4/sidebar-11`, pinned to source commit `2b3e6d4f8d9161fe5c19340dc383aade392012dd`, and compose only the required shadcn/ui primitives around it.

## Executive decision

**Verified fact.** The official `sidebar-11` registry item describes itself as “A sidebar with a collapsible file tree.” It contains exactly two block files, `page.tsx` and `components/app-sidebar.tsx`, and declares only `sidebar`, `breadcrumb`, `separator`, and `collapsible` as registry dependencies. Its source is available in the shadcn/ui repository at the selected commit from 2026-09-12. The block's recursive sample data models files and folders, not dashboard metrics or charts ([official registry item, S1](https://ui.shadcn.com/r/styles/new-york-v4/sidebar-11.json), [pinned page source, S2](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/apps/v4/registry/new-york-v4/blocks/sidebar-11/page.tsx), [pinned sidebar source, S3](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx)).

**Inference.** Of the reviewed upstream artifacts, `sidebar-11` has the smallest semantic gap to a Document Workbench. Its file disclosure hierarchy maps directly to document navigation, while its content inset can hold an editor, preview, and document metadata. Starting from an admin dashboard would require deleting charts, cards, tables, auth, routes, and data clients before adding the same file-oriented structure.

**Recommendation.** Use `sidebar-11` as the shell, not as a complete visual specification. Preserve its responsive Sidebar, recursive disclosure structure, Breadcrumb, Separator, and Collapsible composition. Replace all sample data, links, and page copy. Add the official Dialog, Tooltip, Tabs, Field, Input, and Textarea components only where the workbench needs them. Do not install a router, charting package, query client, auth SDK, or dashboard template.

This recommendation is for a client-rendered React application that produces ordinary static assets. Vite documents `index.html` as its build entry and `vite build` as producing a bundle suitable for static hosting. React documents `createRoot` for mounting a client application ([Vite build guide, S12](https://vite.dev/guide/build), [React `createRoot`, S11](https://react.dev/reference/react-dom/client/createRoot)). No selected block capability requires a Node server, React Server Components, Next.js, or Vercel.

## Method and evidence rules

**Verified fact** means the statement is directly supported by an official repository, registry item, package manifest, license, release record, maintainer documentation, or an official-library documentation snapshot retrieved through Context7.

**Inference** means the statement follows from those facts but is not promised by an upstream maintainer. Bundle conclusions are qualitative because no candidate was integrated and built in this research task.

**Recommendation** means the proposed decision or implementation constraint.

The review applied these gates before comparative fit:

1. A reusable artifact needed an explicit open-source license with compatible redistribution terms.
2. Maintenance needed a current commit or release history that could be verified.
3. Critical interactive behavior needed documented or source-verifiable accessibility foundations.
4. The package or copied-source model needed a credible tree-shaking or selective-adoption path.
5. The frontend needed to build without a server runtime.

Context7 snapshots were consulted for React, Vite, Tailwind CSS, Radix UI, React Router, Mantine, Flowbite React, and shadcn-admin. Registry and release metadata controlled version selection when Context7 lagged. For example, the indexed Vite documentation snapshot exposed 8.0.10 while npm exposed 8.3.0; the React Router snapshot exposed 7.9.4 while npm exposed 8.3.1; the Mantine snapshot exposed 9.0.0 while the official packages and release record exposed 9.6.1. Documentation behavior and current package versions are therefore cited separately.

No local application source was inspected. The assessment is based only on the public upstream evidence listed in the final source table.

## Eligibility and outcome

| Candidate | License and maintenance | Static build and selective adoption | Outcome |
|---|---|---|---|
| **shadcn/ui `new-york-v4/sidebar-11`** | MIT. `shadcn@4.21.0` released 2026-09-04; selected source commit is from 2026-09-12 ([release record, S4](https://github.com/shadcn-ui/ui/releases/tag/shadcn%404.21.0), [license, S5](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/LICENSE.md)). | Official Vite setup; copied source; exact registry dependencies; no router or backend package in the block. | **Select.** Closest workbench structure and smallest removal burden. |
| **shadcn-admin 2.2.1** | MIT. Releases 2.0.0 through 2.2.1 landed between 2025-08-16 and 2025-11-06; its default branch has continued to advance ([releases, S18](https://github.com/satnaing/shadcn-admin/releases), [license, S18](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/LICENSE)). | Vite, but the application includes TanStack Router and Query, Axios, Clerk, Recharts, Zustand, and a generated route tree ([manifest, S18](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/package.json)). | Eligible, but loses on removal cost and domain fit. |
| **Flowbite React 0.12.17 plus official Vite template** | Component library and Vite template are MIT. Library releases 0.12.14 through 0.12.17 ran from 2025-12-15 through 2026-02-09 ([releases, S19](https://github.com/themesberg/flowbite-react/releases), [template license, S20](https://github.com/themesberg/flowbite-react-template-vite/blob/0242bc1d2104108d7c2df487124bdb6edb00cc41/LICENSE)). | Library is ESM, declares `sideEffects: false`, and exports component subpaths. Official Vite template is static but minimal ([npm metadata, S19](https://registry.npmjs.org/flowbite-react/0.12.17), [template manifest, S20](https://github.com/themesberg/flowbite-react-template-vite/blob/0242bc1d2104108d7c2df487124bdb6edb00cc41/package.json)). | Library eligible; Vite template lacks a workbench shell. Separate admin template excluded. |
| **Flowbite React admin dashboard** | Repository has an MIT LICENSE, but its `package.json` declares `UNLICENSED`; default branch last changed 2023-01-12 ([license, S21](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/LICENSE), [manifest, S21](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/package.json)). | Vite 3, React 18, TypeScript 4.9, Tailwind 3, Flowbite React 0.3.7, and route-oriented admin pages. | **Exclude.** Conflicting license metadata and stale stack. |
| **TailAdmin React 2.4.0** | MIT. Its README records releases from 1.0.0 in 2023 through 2.4.0 on 2026-09-13 ([README and history, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/README.md), [license, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/LICENSE.md)). | Current Vite build, but the application manifest includes charts, calendars, maps, DnD, sliders, syntax highlighting, routing, and two map stacks ([manifest, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/package.json)). | **Exclude for this replacement.** Critical custom dialog accessibility is not verifiable to the required level, and removal cost is high. |
| **Mantine 9.6.1 plus official Vite template** | Mantine core is MIT and released 9.6.1 on 2026-09-09. The separate Vite template at the reviewed commit has no license file and no license field ([core release, S23](https://github.com/mantinedev/mantine/releases/tag/9.6.1), [core license, S23](https://github.com/mantinedev/mantine/blob/edd42fa2962473fc7addf1dbd1317a4ea1588743/LICENSE), [template tree, S24](https://github.com/mantinedev/vite-template/tree/d10122b96a277ddea6a53774da6bd1cb1125e85e)). | Core supports Vite. Template adds React Router DOM, Storybook, Mantine PostCSS, and tests, but contains no workbench layout ([template manifest, S24](https://github.com/mantinedev/vite-template/blob/d10122b96a277ddea6a53774da6bd1cb1125e85e/package.json)). | Core library eligible; reviewed Vite template source **excluded** for unverified licensing and poor domain fit. |
| **Mantine dashboard templates** | `mantine-dashboard` is unlicensed and last changed 2023-06-14. `mantine-analytics-dashboard` is MIT and current enough to evaluate ([old repository, S25](https://github.com/reboottime/mantine-dashboard), [analytics license, S26](https://github.com/design-sparx/mantine-analytics-dashboard/blob/14279e801a4f74d9cdcce67d9b3830b3c51b0f68/LICENSE)). | Old template uses Create React App 5 and Mantine 6. Analytics template uses Next 16.1.7, Clerk, auth, charts, maps, calendars, TipTap, DnD, and Mantine 7 packages ([analytics manifest, S26](https://github.com/design-sparx/mantine-analytics-dashboard/blob/14279e801a4f74d9cdcce67d9b3830b3c51b0f68/package.json)). | Old template excluded; analytics template loses on Next coupling, age of its Mantine major, size, and admin focus. |

## Technical comparison

| Criterion | shadcn/ui `sidebar-11` | shadcn-admin | Flowbite React | TailAdmin | Mantine candidates |
|---|---|---|---|---|---|
| **React and TypeScript** | Host-selected. Pin React 19.3.0 and TypeScript 7.0.2. React 19.3.0 is the stable release dated 2026-09-09 ([React versions, S11](https://react.dev/versions)). | React `^19.2.5`; TypeScript `~6.0.3`. | Library peers React 18 or 19. Vite template uses React `^19.1.0`, TypeScript `~5.8.3`; stale admin uses React 18.2, TypeScript 4.9.4. | React `^19.2.7`; TypeScript `^5.8`. | Core peers React `^19.2.0`; Vite template uses TypeScript 7.0.2. Analytics template uses React 19, TypeScript 5.6, and Mantine 7.14.3. |
| **Build system** | Vite 8.3.0 with `@vitejs/plugin-react` and `@tailwindcss/vite`. | Vite `^8.0.8`. | Official template Vite `^7.0.5`; admin Vite `^3.2.5`. | Vite `^8.2.2`. | Vite template `^8.0.0`; analytics template Next 16.1.7. |
| **CSS control** | Copied component source, project-controlled Tailwind classes, and project-controlled CSS variables. No component CSS runtime. | Copied and modified shadcn source plus local theme CSS; divergence from current upstream must be maintained. | Packaged theme objects and Tailwind plugin; customizable, but the project does not own component implementation by default. | Large template stylesheet and custom component styles are local, but tied to broad admin markup. | Required core style imports and `MantineProvider`; granular CSS imports exist, but the package owns component styling. |
| **Dialog** | Radix-backed Dialog with focus management, inert underlay behavior, Escape handling, labels, and descriptions when composed as documented ([Dialog docs, S7](https://ui.shadcn.com/docs/components/base/dialog), [Radix accessibility, S10](https://www.radix-ui.com/primitives/docs/overview/accessibility)). | Modified shadcn/Radix Dialog. | `Modal` uses Floating UI's `FloatingFocusManager`, `useDismiss`, and `useRole`; source-verifiable baseline ([Modal source, S19](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Modal/Modal.tsx)). | Custom Modal handles Escape and body scroll, but its pinned source has no dialog role, `aria-modal`, focus trap, initial focus, or focus return ([Modal source, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/src/components/ui/modal/index.tsx)). | Mantine Modal documents WAI-ARIA labeling and focus behavior, but no qualifying workbench template was found ([Modal docs, S23](https://mantine.dev/core/modal/)). |
| **Tooltip** | Radix-backed; opens on hover and keyboard focus ([Tooltip docs, S8](https://ui.shadcn.com/docs/components/base/tooltip)). | Modified Radix Tooltip. | Floating UI source uses `role: "tooltip"` and focus interaction as well as hover/click triggers ([Floating source, S19](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Floating/Floating.tsx)). | Custom implementation and claims were not sufficient to verify a consistent primitive contract across the template. | Core Tooltip is documented and maintained; no selected template advantage. |
| **Tabs** | Radix-backed horizontal/vertical tabs, disabled state, keyboard behavior, and RTL ([Tabs docs, S9](https://ui.shadcn.com/docs/components/base/tabs)). | Modified Radix Tabs. | Source assigns `tablist`, `tab`, and `tabpanel` roles and implements left/right arrow and Enter handling ([Tabs source, S19](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Tabs/Tabs.tsx)). | Custom tabs do not establish a template-wide accessibility primitive contract that can be verified from maintainer documentation. | Core Tabs are documented; no qualifying workbench template uses them as a shell. |
| **Forms** | Native controls plus Field composition. Official guide shows labels, descriptions, errors, `aria-invalid`, React Hook Form, and Zod ([form guide, S6](https://ui.shadcn.com/docs/forms/react-hook-form)). | Includes React Hook Form, Zod, form wrappers, and many finished forms. | Provides inputs and helper text; form state and schema validation remain application choices. | Many custom controls and authentication forms; accessibility varies by control and requires component-by-component audit. | Mantine core inputs have integrated labels/errors; analytics template adds `@mantine/form` 7.x. |
| **Dark mode** | Class-based dark mode and editable CSS variables; no runtime theme dependency is required ([Vite dark-mode guide, S14](https://ui.shadcn.com/docs/dark-mode/vite)). | ThemeProvider, theme switch, and local persistence. | Dark variants and theme customization supported. | ThemeContext persists mode and toggles the document `dark` class. | `MantineProvider` and color-scheme hooks. |
| **i18n and RTL** | No translation catalog. Radix Direction provider and shadcn RTL guidance support `ltr`/`rtl`; application owns strings, `lang`, and locale selection ([RTL guide, S15](https://ui.shadcn.com/docs/rtl), [Radix direction docs, S10](https://www.radix-ui.com/primitives/docs/utilities/direction-provider)). | DirectionProvider and RTL layout support; no general translation catalog. | RTL support exists, including recent modal fixes; no general translation catalog. | 2.4.0 adds i18next, react-i18next, locale data, and RTL. | `useDirection`, provider direction, and localizable labels; application still owns translations. |
| **Bundle cost** | Lowest expected cost for this scope because source and primitives are selected individually. `cn`, `radix-ui`, and `lucide-react` declare `sideEffects: false`; Tailwind emits classes found in project sources ([package metadata, S16](https://registry.npmjs.org/radix-ui/1.6.7), [Tailwind detection, S13](https://tailwindcss.com/docs/detecting-classes-in-source-files)). | High initial dependency surface; pruning is possible only after removing routes and features. | Library is tree-shakeable and has component subpath exports, but its packaged theme/plugin surface is broader than copied shadcn primitives. | Highest irrelevant application surface in this comparison. | Core ESM is tree-shakeable, while CSS is intentionally marked as a side effect and baseline styles must be imported. Analytics app is much broader. |
| **Router/backend removal** | No router, API client, auth provider, or backend assumption in the block. | Remove TanStack Router/Query, generated route tree, Axios, Clerk, route-bound layouts, and providers. | Minimal Vite template has none; admin template and its documented deployment expect routes. | `AppLayout` uses `Outlet`; sidebar uses `Link` and `useLocation`; remove route data and many feature dependencies. | Vite template's React Router is removable but offers no layout to retain. Analytics template is structurally coupled to Next and Clerk. |
| **320 px workbench fit** | File hierarchy is directly useful. Sidebar already switches to a Sheet on mobile; editor can remain the only persistent pane. | Generic admin navigation, team/user menus, search, and dashboard surfaces need replacement. | Components can build the UI, but the Vite template supplies no file-oriented structure; admin template is ecommerce-oriented. | Generic admin navigation and dashboard catalog dominate the source. | Neither reviewed template starts with a file tree plus document editor. |

### Bundle evidence limitation

**Verified fact.** `flowbite-react@0.12.17` reports an unpacked npm size of about 3.8 MB and a release note about reducing its published package bundle from 42 MB to 8.38 MB. `@mantine/core@9.6.1` reports an unpacked npm size of about 9.2 MB. These are package-distribution measurements, not browser chunks ([Flowbite npm metadata, S19](https://registry.npmjs.org/flowbite-react/0.12.17), [Mantine npm metadata, S23](https://registry.npmjs.org/@mantine/core/9.6.1)).

**Inference.** Browser cost depends on imports, CSS, minification, and the final application graph. It would be misleading to convert unpacked package sizes into client bundle sizes. The reliable comparison here is structural: `sidebar-11` copies only selected files and imports only selected primitives; complete admin applications begin with many unrelated runtime dependencies.

**Recommendation.** Establish a compressed JavaScript and CSS budget during implementation and measure the actual production build. Do not use the package sizes above as that budget.

## Why `sidebar-11` fits the workbench

### It begins with the right information architecture

**Verified fact.** The block uses a recursive `TreeItem` shape and recursively renders Folder and File entries through Collapsible and Sidebar menu components. Its sibling `dashboard-01` is explicitly a dashboard containing a sidebar, charts, a data table, and metric cards ([sidebar block catalog, S1](https://ui.shadcn.com/blocks/sidebar), [dashboard block catalog, S1](https://ui.shadcn.com/blocks)).

**Inference.** A document application needs document discovery, current-document context, editing, preview, and destructive-action confirmation. `sidebar-11` supplies the first two without importing ecommerce or analytics metaphors. `dashboard-01` would make generic SaaS cards the starting abstraction and then require their removal.

### It has an appropriate narrow-screen behavior

**Verified fact.** The current Sidebar source defines desktop width `16rem` and mobile width `18rem`. On mobile, it renders the navigation through the Sheet component and exposes `openMobile`, `setOpenMobile`, and `isMobile`. It also supports left/right placement, `sidebar`, `floating`, and `inset` variants, and `offcanvas`, `icon`, and `none` collapse modes ([Sidebar documentation, S6](https://ui.shadcn.com/docs/components/base/sidebar), [Sidebar registry source, S6](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)).

**Recommendation.** At a 320 px viewport, keep the editor/content area full width. Open document navigation as the existing modal Sheet, at no more than `18rem` or the viewport width, instead of placing a permanent sidebar beside the editor. Keep the trigger in the header and close navigation after selecting a document. The block's 18rem default is 288 px at a 16 px root size, leaving the work area unobstructed once the sheet closes.

### It preserves CSS and component control

**Verified fact.** shadcn/ui distributes component source into the consuming project. The current `sidebar` registry entry names its exact source dependencies and CSS variables. Official Vite installation uses Tailwind CSS through `@tailwindcss/vite` and a project stylesheet that imports Tailwind ([Vite installation, S6](https://ui.shadcn.com/docs/installation/vite), [Sidebar registry source, S6](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)).

**Inference.** Compact row height, editor density, focus treatment, mobile behavior, and workbench-specific states can be changed without overriding a packaged admin theme. This control does not remove upstream copyright or license obligations; it removes runtime styling indirection.

### It uses verified primitives without claiming automatic accessibility

**Verified fact.** Current shadcn Dialog, Tooltip, Tabs, Collapsible, Separator, Label, Sheet, and Slot components are backed by the `radix-ui` package. Radix says its complex primitives follow WAI-ARIA authoring practices and handle roles, focus management, and keyboard navigation where appropriate. The official form guide still requires the application to connect labels, errors, descriptions, and `aria-invalid` correctly ([registry components, S6](https://ui.shadcn.com/r/styles/new-york-v4/dialog.json), [Radix accessibility, S10](https://www.radix-ui.com/primitives/docs/overview/accessibility), [form guide, S6](https://ui.shadcn.com/docs/forms/react-hook-form)).

**Inference.** The block's collapsible list is a disclosure navigation pattern, not automatically a full ARIA `tree` widget. Radix Collapsible manages disclosure state, but the application must still give every document action an accessible name, expose selection, preserve focus after mutation, and decide whether disclosure-list keyboard behavior or a true tree keyboard model is required.

**Recommendation.** Treat accessibility as an acceptance criterion, not a library property. Test keyboard-only navigation, focus order and return, screen-reader naming, 320 px reflow, reduced motion, visible focus, dialog labeling, validation announcement, and light/dark contrast after composing the app.

## Exact adoption specification

### Source pin

Use this source identity:

- Repository: `shadcn-ui/ui`
- Commit: `2b3e6d4f8d9161fe5c19340dc383aade392012dd`
- Registry style: `new-york-v4`
- Registry block: `sidebar-11`
- CLI used only to materialize source: `shadcn@4.21.0`

The commit is the durable provenance pin. A later invocation against the live registry can return changed source even when the CLI version is pinned. Preserve the copied source in the application repository and rely on the committed lockfile for package resolution.

### Upstream files and components to reuse

**From the exact block:**

1. `apps/v4/registry/new-york-v4/blocks/sidebar-11/page.tsx`
   - Reuse `SidebarProvider`, `SidebarInset`, header trigger, Breadcrumb, and Separator composition.
   - Adapt its page JSX into the Vite application's `src/App.tsx`; the filename `page.tsx` is not a required Next.js capability.
2. `apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx`
   - Reuse the recursive file/folder disclosure and `SidebarRail`.
   - Replace sample changes and filesystem data with document-domain data and local selection callbacks.

**Registry dependencies materialized by the block:**

- `sidebar.tsx`: `Sidebar`, `SidebarContent`, `SidebarGroup`, `SidebarGroupContent`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuButton`, `SidebarMenuItem`, `SidebarMenuSub`, `SidebarMenuBadge`, `SidebarProvider`, `SidebarInset`, `SidebarRail`, and `SidebarTrigger`.
- `collapsible.tsx`: `Collapsible`, `CollapsibleTrigger`, and `CollapsibleContent`.
- `breadcrumb.tsx`: Breadcrumb composition for the current document path.
- `separator.tsx`.
- Transitive Sidebar support: `button.tsx`, `sheet.tsx`, `tooltip.tsx`, `input.tsx`, `skeleton.tsx`, and `hooks/use-mobile.tsx` ([exact registry dependency graph, S1](https://ui.shadcn.com/r/styles/new-york-v4/sidebar-11.json), [Sidebar registry item, S6](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)).

**Additional first-party components for the complete frontend:**

- `dialog.tsx` for delete, discard, and destructive confirmations.
- `tabs.tsx` for Edit/Preview or content/metadata modes when both are needed.
- `field.tsx`, `label.tsx`, `input.tsx`, and `textarea.tsx` for document metadata and content forms.
- The existing `tooltip.tsx` for icon-only toolbar actions. A tooltip does not replace an accessible name.

Do not copy chart, data-table, auth, account, team switcher, command-menu, or dashboard blocks.

### Exact dependency pins available on 2026-09-13

**Verified fact.** The versions below were available from their npm registry records on the decision date ([runtime package metadata, S16](https://registry.npmjs.org/radix-ui/1.6.7), [build package metadata, S27](https://registry.npmjs.org/vite/8.3.0)).

Use exact versions, not ranges:

```json
{
  "dependencies": {
    "@hookform/resolvers": "5.9.1",
    "class-variance-authority": "0.7.1",
    "cn": "0.3.0",
    "lucide-react": "1.45.0",
    "radix-ui": "1.6.7",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-hook-form": "7.88.0",
    "tw-animate-css": "1.4.0",
    "zod": "4.6.4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/node": "26.4.1",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.3.0"
  }
}
```

`react-hook-form`, `@hookform/resolvers`, and `zod` are required only for forms that need managed state and schema validation. If the replacement has only a native textarea and simple metadata fields, omit all three and use native React and browser validation.

`shadcn@4.21.0` is a source-generation tool, not a production dependency. Its 4.21.0 release changed current registry output to import `cn` from the `cn` package, and the 4.20.0 migration replaced direct `clsx` and `tailwind-merge` use in Tailwind v4 projects. Therefore this pin set intentionally includes `cn@0.3.0` and does not declare `clsx` or `tailwind-merge` directly ([shadcn releases, S4](https://github.com/shadcn-ui/ui/releases/tag/shadcn%404.21.0), [`cn` metadata, S16](https://registry.npmjs.org/cn/0.3.0)). `class-variance-authority` still declares `clsx` as its own dependency; the lockfile will pin that transitive package ([CVA metadata, S16](https://registry.npmjs.org/class-variance-authority/0.7.1)).

`radix-ui`, `lucide-react`, `cn`, and React Hook Form declare `sideEffects: false`. `@mantine/core`, by comparison, marks CSS files as side effects. These fields support tree shaking but do not prove a final bundle size ([package metadata collection, S16](https://registry.npmjs.org/radix-ui/1.6.7), [Mantine manifest, S23](https://github.com/mantinedev/mantine/blob/edd42fa2962473fc7addf1dbd1317a4ea1588743/packages/%40mantine/core/package.json)).

### Build and runtime constraints

**Recommendation.** Use a plain Vite client entry with React `createRoot`, a root `index.html`, and `vite build`. Use Node `>=22.12.0` for the build environment, satisfying Vite 8's documented `^20.19.0 || >=22.12.0` requirement and the selected tooling. Commit the generated source and package lock; use the package manager's frozen/clean-install mode in repeatable builds ([Vite guide, S12](https://vite.dev/guide/), [React client API, S11](https://react.dev/reference/react-dom/client/createRoot)).

The block contains `"use client"` directives because the same source can be consumed in React frameworks. It does not import a Next.js API. Vite can compile it as ordinary client React source.

Do not add React Router for a single workbench screen. If URL-addressable screens become a real requirement, add exact `react-router@8.3.1` and configure the static host to return `index.html` for application deep links. React Router documents the fallback requirement for static SPA hosting ([React Router SPA deployment, S17](https://reactrouter.com/how-to/spa)).

### Required adaptation, and nothing more

1. Replace the sample recursive data with documents and folders.
2. Replace placeholder links with local selection actions. Keep URL routing absent unless multiple addressable screens are required.
3. Make the content inset the document editor. Add Preview or Metadata through Tabs only if those modes exist.
4. Keep Sidebar as an off-canvas Sheet at narrow widths; do not leave a persistent side-by-side layout at 320 px.
5. Use Dialog for destructive confirmation, Tooltip for supplementary toolbar help, and labeled native fields for editing.
6. Implement dark mode with the documented class strategy. Set both `lang` and `dir` at the document root; use Radix Direction provider when runtime direction changes.
7. Delete all sample breadcrumbs, repository paths, change counts, and decorative data.

## Why each alternative loses

### shadcn-admin

**Verified fact.** The maintainer explicitly says, “This is not a starter project (template) though.” The current application includes more than ten pages, TanStack Router and Query, Axios, Clerk, Recharts, Zustand, data tables, auth flows, a generated route tree, and five global concerns documented through Theme, Direction, Font, Layout, and Search providers ([README, S18](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/README.md), [manifest, S18](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/package.json)).

**Inference.** Its components are useful examples, and its Radix basis is credible, but adopting the application would make deletion the first major implementation phase. Its modified copies also create an additional upstream-diff burden. `sidebar-11` provides the useful file-oriented shell without those providers or features.

### Flowbite React

**Verified fact.** The maintained component package is MIT, React 18/19 compatible, ESM, `sideEffects: false`, and provides component subpath exports. Its Modal, Tooltip, and Tabs have source-verifiable accessibility mechanisms. The official Vite template has a clear MIT license and a normal static build, but is only a minimal starter. The separate admin dashboard uses old packages, is ecommerce-oriented, and has conflicting MIT/`UNLICENSED` metadata ([library metadata and source, S19](https://registry.npmjs.org/flowbite-react/0.12.17), [Vite template, S20](https://github.com/themesberg/flowbite-react-template-vite/tree/0242bc1d2104108d7c2df487124bdb6edb00cc41), [admin manifest, S21](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/package.json)).

**Inference.** Flowbite React could implement the workbench, but no qualifying first-party template supplies the file-tree/editor information architecture. Selecting its minimal Vite template would still require hand-authoring the shell. Selecting its admin dashboard is not acceptable under the license and maintenance gates.

### TailAdmin React

**Verified fact.** TailAdmin is the most recently released full application reviewed, and 2.4.0 adds i18n and RTL. Its manifest also includes ApexCharts, FullCalendar, Leaflet, MapLibre, vector maps, drag and drop, Dropzone, Swiper, Prism, React Router, and other unrelated dependencies. Its `AppLayout` is router-coupled and its large sidebar enumerates dashboards, ecommerce, AI, forms, tables, charts, maps, auth, and support pages ([release history, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/README.md), [manifest, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/package.json), [sidebar source, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/src/layout/AppSidebar.tsx)).

**Verified fact.** The 2.4.0 README claims accessibility fixes, but its custom Modal at the same commit only implements Escape close, backdrop close, and body-scroll locking. It does not implement a dialog role, `aria-modal`, focus containment, initial focus, or focus restoration ([Modal source, S22](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/src/components/ui/modal/index.tsx)).

**Recommendation.** Exclude it for this task. This conclusion does not label the whole template inaccessible; it means a required critical primitive failed the stated verification gate, while the application also carries the largest deletion burden.

### Mantine-based templates

**Verified fact.** Mantine core 9.6.1 is maintained, MIT, ESM, React 19 compatible, and has credible documented accessibility, color scheme, direction, form, modal, tooltip, and tabs APIs. Its official Vite template is technically static-compatible and pins Mantine 9.6.1, but the reviewed template repository has no explicit license. The older `mantine-dashboard` has no detected license, uses Create React App 5 and Mantine 6, and stopped in 2023. The MIT `mantine-analytics-dashboard` is a broad Next 16 admin app using Clerk, auth, charts, calendars, maps, TipTap, DnD, and Mantine 7.14.3 packages ([Mantine release and package, S23](https://github.com/mantinedev/mantine/releases/tag/9.6.1), [Vite template, S24](https://github.com/mantinedev/vite-template/tree/d10122b96a277ddea6a53774da6bd1cb1125e85e), [analytics manifest, S26](https://github.com/design-sparx/mantine-analytics-dashboard/blob/14279e801a4f74d9cdcce67d9b3830b3c51b0f68/package.json)).

**Recommendation.** Do not select a Mantine template. Core Mantine is a sound component-library alternative, but none of the reviewed templates clears all license, maintenance, static-build, and workbench-fit gates. The analytics template's Next.js layer provides no required workbench capability. Even if individual routes could later be made static, removing Next, Clerk, and the admin feature graph would be more work than adopting the Vite-native shadcn block.

## License and attribution obligations

**Verified fact.** shadcn/ui uses the MIT License, copyright 2023 shadcn. The license requires the copyright and permission notice to be included in copies or substantial portions of the software ([shadcn license, S5](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/LICENSE.md)). Radix UI, React, React DOM, `cn`, React Hook Form, `@hookform/resolvers`, Zod, `tw-animate-css`, Tailwind CSS, Vite, and the React Vite plugin are MIT. Lucide is ISC. `class-variance-authority` and TypeScript are Apache-2.0 ([runtime package metadata, S16](https://registry.npmjs.org/class-variance-authority/0.7.1), [build package metadata, S27](https://registry.npmjs.org/typescript/7.0.2)).

**Recommendation.** Keep a third-party notices or licenses file in the distributed project that includes:

- The shadcn/ui MIT copyright and permission notice for copied substantial source.
- The applicable MIT and ISC notices for direct dependencies.
- The Apache-2.0 licenses for `class-variance-authority` and TypeScript, plus any upstream NOTICE content if a distributed dependency supplies one.

An in-product badge, footer credit, or link to shadcn/ui is not required by the MIT text. Retaining notices in third-party license documentation is the relevant obligation. This is an engineering reading of upstream license text, not legal advice.

## Final recommendation

Adopt only `new-york-v4/sidebar-11` at commit `2b3e6d4f8d9161fe5c19340dc383aade392012dd`, plus the named official primitives. Pin the dependency set above and commit the generated/copied source and lockfile. Keep the application as one Vite client screen, keep document state local to that screen, and use the existing mobile Sheet behavior at 320 px.

This option wins because it is the only reviewed artifact that simultaneously provides a verified license, current maintenance, accessible primitive foundation, selective source control, static Vite compatibility, no backend/router assumptions, and a file-oriented shell. The alternatives either start from generic admin concepts, require substantial dependency removal, fail a licensing or accessibility verification gate, or supply only a component library without a relevant template.

## Source table

| ID | Primary source | Evidence used |
|---|---|---|
| S1 | [shadcn/ui `sidebar-11` registry item](https://ui.shadcn.com/r/styles/new-york-v4/sidebar-11.json), [official Sidebar blocks](https://ui.shadcn.com/blocks/sidebar), [official block catalog](https://ui.shadcn.com/blocks) | Exact block description, files, registry dependencies, file-tree fit, comparison with dashboard blocks. |
| S2 | [Pinned `sidebar-11/page.tsx`](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/apps/v4/registry/new-york-v4/blocks/sidebar-11/page.tsx) | Shell composition and absence of required Next.js APIs. |
| S3 | [Pinned `sidebar-11/components/app-sidebar.tsx`](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx) | Recursive file/folder model and exact components to retain. |
| S4 | [shadcn/ui releases](https://github.com/shadcn-ui/ui/releases), [`shadcn@4.21.0` release](https://github.com/shadcn-ui/ui/releases/tag/shadcn%404.21.0), [`shadcn@4.21.0` npm metadata](https://registry.npmjs.org/shadcn/4.21.0) | Release cadence, CLI pin, and migration to the `cn` package. |
| S5 | [Pinned shadcn/ui MIT license](https://github.com/shadcn-ui/ui/blob/2b3e6d4f8d9161fe5c19340dc383aade392012dd/LICENSE.md) | Source reuse and notice obligation. |
| S6 | [shadcn/ui Vite installation](https://ui.shadcn.com/docs/installation/vite), [Sidebar docs](https://ui.shadcn.com/docs/components/base/sidebar), [Sidebar registry item](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json), [Field registry item](https://ui.shadcn.com/r/styles/new-york-v4/field.json), [React Hook Form guide](https://ui.shadcn.com/docs/forms/react-hook-form) | Vite/Tailwind setup, mobile Sheet behavior, widths, variants, controlled state, transitive source graph, and accessible form structure. Context7 official-library snapshots were also consulted. |
| S7 | [shadcn/ui Dialog docs](https://ui.shadcn.com/docs/components/base/dialog), [Dialog registry item](https://ui.shadcn.com/r/styles/new-york-v4/dialog.json) | Dialog semantics, composition, and Radix dependency. |
| S8 | [shadcn/ui Tooltip docs](https://ui.shadcn.com/docs/components/base/tooltip), [Tooltip registry item](https://ui.shadcn.com/r/styles/new-york-v4/tooltip.json) | Hover/focus behavior and Radix dependency. |
| S9 | [shadcn/ui Tabs docs](https://ui.shadcn.com/docs/components/base/tabs), [Tabs registry item](https://ui.shadcn.com/r/styles/new-york-v4/tabs.json) | Orientation, disabled state, RTL, and Radix dependency. |
| S10 | [Radix accessibility overview](https://www.radix-ui.com/primitives/docs/overview/accessibility), [Direction Provider](https://www.radix-ui.com/primitives/docs/utilities/direction-provider), [`radix-ui@1.6.7` metadata](https://registry.npmjs.org/radix-ui/1.6.7) | WAI-ARIA approach, direction support, React peers, license, dependencies, and `sideEffects: false`. Context7 `/radix-ui/primitives` snapshot was consulted. |
| S11 | [React versions](https://react.dev/versions), [`createRoot` reference](https://react.dev/reference/react-dom/client/createRoot), [`react@19.3.0` metadata](https://registry.npmjs.org/react/19.3.0), [`react-dom@19.3.0` metadata](https://registry.npmjs.org/react-dom/19.3.0) | Stable React version, release date, client mounting, and licenses. Context7 official React snapshot was consulted. |
| S12 | [Vite guide](https://vite.dev/guide/), [Vite production build](https://vite.dev/guide/build), [`vite@8.3.0` metadata](https://registry.npmjs.org/vite/8.3.0) | Static build model, entry point, Node requirement, and exact version. Context7 `/vitejs/vite` snapshot was consulted. |
| S13 | [Tailwind Vite installation](https://tailwindcss.com/docs/installation/using-vite), [source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files), [dark mode](https://tailwindcss.com/docs/dark-mode), [`tailwindcss@4.3.3` metadata](https://registry.npmjs.org/tailwindcss/4.3.3) | Vite plugin, generated CSS, source scanning, responsive/dark utilities, and exact version. Context7 official Tailwind snapshot was consulted. |
| S14 | [shadcn/ui Vite dark mode](https://ui.shadcn.com/docs/dark-mode/vite) | Class-based theme control and persistence pattern. |
| S15 | [shadcn/ui RTL guide](https://ui.shadcn.com/docs/rtl) | Direction setup and RTL component guidance. |
| S16 | [`cn@0.3.0`](https://registry.npmjs.org/cn/0.3.0), [`class-variance-authority@0.7.1`](https://registry.npmjs.org/class-variance-authority/0.7.1), [`lucide-react@1.45.0`](https://registry.npmjs.org/lucide-react/1.45.0), [`react-hook-form@7.88.0`](https://registry.npmjs.org/react-hook-form/7.88.0), [`@hookform/resolvers@5.9.1`](https://registry.npmjs.org/%40hookform%2fresolvers/5.9.1), [`zod@4.6.4`](https://registry.npmjs.org/zod/4.6.4), [`tw-animate-css@1.4.0`](https://registry.npmjs.org/tw-animate-css/1.4.0) | Exact dependency versions, licenses, peers, and side-effect metadata. |
| S17 | [React Router SPA deployment guide](https://reactrouter.com/how-to/spa), [`react-router@8.3.1` metadata](https://registry.npmjs.org/react-router/8.3.1) | Optional router pin and static deep-link fallback requirement. Context7 official React Router snapshot was consulted. |
| S18 | [shadcn-admin repository at reviewed commit](https://github.com/satnaing/shadcn-admin/tree/e16c87f213a5ba5e45964e9b67c792105ec74d26), [manifest](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/package.json), [README](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/README.md), [releases](https://github.com/satnaing/shadcn-admin/releases), [license](https://github.com/satnaing/shadcn-admin/blob/e16c87f213a5ba5e45964e9b67c792105ec74d26/LICENSE) | License, releases, “not a starter” statement, Vite stack, providers, routes, and broad dependencies. Context7 `/satnaing/shadcn-admin` snapshot was consulted. |
| S19 | [Flowbite React repository at reviewed commit](https://github.com/themesberg/flowbite-react/tree/85319bd067822f7aa9670688780aeb58cc187aa5), [npm metadata](https://registry.npmjs.org/flowbite-react/0.12.17), [releases](https://github.com/themesberg/flowbite-react/releases), [Modal source](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Modal/Modal.tsx), [Tabs source](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Tabs/Tabs.tsx), [Floating source](https://github.com/themesberg/flowbite-react/blob/85319bd067822f7aa9670688780aeb58cc187aa5/packages/ui/src/components/Floating/Floating.tsx) | MIT license metadata, React peers, ESM exports, tree-shaking declaration, release history, Modal focus/role behavior, Tooltip focus/role behavior, and Tabs ARIA/keyboard source. Context7 official Flowbite React snapshot was consulted. |
| S20 | [Official Flowbite React Vite template](https://github.com/themesberg/flowbite-react-template-vite/tree/0242bc1d2104108d7c2df487124bdb6edb00cc41), [manifest](https://github.com/themesberg/flowbite-react-template-vite/blob/0242bc1d2104108d7c2df487124bdb6edb00cc41/package.json), [MIT license](https://github.com/themesberg/flowbite-react-template-vite/blob/0242bc1d2104108d7c2df487124bdb6edb00cc41/LICENSE) | Legally clear static starter and exact but older package stack; absence of workbench structure. |
| S21 | [Flowbite React admin dashboard at reviewed commit](https://github.com/themesberg/flowbite-react-admin-dashboard/tree/ce3afeb2149ad5a91e59c8e98c85e9220224c744), [manifest](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/package.json), [repository license](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/LICENSE), [README](https://github.com/themesberg/flowbite-react-admin-dashboard/blob/ce3afeb2149ad5a91e59c8e98c85e9220224c744/README.md) | Conflicting license metadata, stale dependencies, admin/ecommerce scope, and routing assumptions. |
| S22 | [TailAdmin repository at reviewed commit](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/tree/046b73be65c7ec41b2d961d4aaa445236de49aad), [manifest](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/package.json), [README and release history](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/README.md), [license](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/LICENSE.md), [custom Modal](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/src/components/ui/modal/index.tsx), [AppSidebar](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/046b73be65c7ec41b2d961d4aaa445236de49aad/src/layout/AppSidebar.tsx) | MIT, current release history, exact dependency breadth, i18n/RTL claims, router coupling, admin navigation, and direct Modal accessibility check. |
| S23 | [Mantine repository at reviewed commit](https://github.com/mantinedev/mantine/tree/edd42fa2962473fc7addf1dbd1317a4ea1588743), [9.6.1 release](https://github.com/mantinedev/mantine/releases/tag/9.6.1), [MIT license](https://github.com/mantinedev/mantine/blob/edd42fa2962473fc7addf1dbd1317a4ea1588743/LICENSE), [core manifest](https://github.com/mantinedev/mantine/blob/edd42fa2962473fc7addf1dbd1317a4ea1588743/packages/%40mantine/core/package.json), [Modal docs](https://mantine.dev/core/modal/) | Maintenance, license, React peers, CSS side effects, provider/style model, and accessibility. Context7 `/mantinedev/mantine` snapshot was consulted. |
| S24 | [Official Mantine Vite template at reviewed commit](https://github.com/mantinedev/vite-template/tree/d10122b96a277ddea6a53774da6bd1cb1125e85e), [manifest](https://github.com/mantinedev/vite-template/blob/d10122b96a277ddea6a53774da6bd1cb1125e85e/package.json) | Mantine 9.6.1, Vite 8, TypeScript 7, router/test stack, no workbench shell, and no license file or manifest license at the pin. |
| S25 | [Legacy Mantine dashboard](https://github.com/reboottime/mantine-dashboard/tree/0fcd0b44d3cc5662809d33b6a5bfbed1234827e9) | 2023 maintenance cutoff, Create React App 5/Mantine 6 stack, and absent license. |
| S26 | [Mantine analytics dashboard at reviewed commit](https://github.com/design-sparx/mantine-analytics-dashboard/tree/14279e801a4f74d9cdcce67d9b3830b3c51b0f68), [manifest](https://github.com/design-sparx/mantine-analytics-dashboard/blob/14279e801a4f74d9cdcce67d9b3830b3c51b0f68/package.json), [MIT license](https://github.com/design-sparx/mantine-analytics-dashboard/blob/14279e801a4f74d9cdcce67d9b3830b3c51b0f68/LICENSE) | Clear license, Next/Clerk coupling, Mantine 7 dependency set, and broad admin features. |
| S27 | [`vite@8.3.0`](https://registry.npmjs.org/vite/8.3.0), [`@vitejs/plugin-react@6.1.1`](https://registry.npmjs.org/%40vitejs%2fplugin-react/6.1.1), [`typescript@7.0.2`](https://registry.npmjs.org/typescript/7.0.2), [`@tailwindcss/vite@4.3.3`](https://registry.npmjs.org/%40tailwindcss%2fvite/4.3.3), [`@types/node@26.4.1`](https://registry.npmjs.org/%40types%2fnode/26.4.1), [`@types/react@19.3.0`](https://registry.npmjs.org/%40types%2freact/19.3.0), [`@types/react-dom@19.3.0`](https://registry.npmjs.org/%40types%2freact-dom/19.3.0) | Exact build-time package availability and license metadata on the decision date. |
