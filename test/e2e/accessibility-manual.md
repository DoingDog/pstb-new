# Manual accessibility evidence

Each category requires a separate tracked JSON receipt in `test/e2e/evidence/accessibility/` and a real tool or device. Set exact OS, browser, assistive-tool, and device versions. A missing preferred platform does not satisfy a category. Record `failed` when the check fails; release verification accepts only all four `passed` rows.

## `screen-reader`

Use an actual screen reader, such as NVDA on Windows or VoiceOver on macOS or iOS. Check heading and landmark announcements, every field/error/help relationship, Tabs/Sheet/Dialog focus behavior, polite status announcements, and the non-color diff prefixes.

## `contrast`

Measure light and dark normal text, large text, non-text controls, and focus indicators against WCAG 2.2 AA. Put the measured ratios, colors, and tool result in the receipt notes.

## `zoom-reflow-200`

Use browser zoom at 200%. Check reflow, all content availability, focus visibility, and the absence of page-level horizontal scrolling.

## `physical-touch`

Use real touch hardware. Exercise the 44px Help, Sheet, Dialog, Create, and Edit flows. Mouse emulation is not physical-touch evidence.

Use `node scripts/browser-evidence.mjs record-accessibility --release-date <YYYY-MM-DD> --category <category> --evidence <in-tree receipt>` only after the matching receipt is complete. The command validates and copies the receipt row into `test/e2e/accessibility-manual.json` under a lock.
