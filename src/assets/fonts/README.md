# Bundled interface fonts

Self-hosted, Latin-only woff2 subsets copied from `@fontsource-variable/*` 5.3.x.
They are loaded by `@font-face` rules at the top of `src/index.css` and selected
from **Settings → Appearance → Font**, which restyles the whole interface
(sidebar, menus, settings) as well as the document.

| File | Family | Upstream | Licence |
| --- | --- | --- | --- |
| `Inter-var.woff2` / `Inter-italic-var.woff2` | Inter (variable) | https://github.com/rsms/inter | `Inter-OFL.txt` |
| `SourceSerif4-var.woff2` / `SourceSerif4-italic-var.woff2` | Source Serif 4 (variable) | https://github.com/adobe-fonts/source-serif | `SourceSerif4-OFL.txt` |
| `JetBrainsMono-var.woff2` | JetBrains Mono (variable) | https://github.com/JetBrains/JetBrainsMono | `JetBrainsMono-OFL.txt` |

Only the `latin` unicode-range is vendored to keep the bundle small; Chinese,
Japanese and Korean text falls back to the platform font listed after each family
in `DOC_FONT_STACKS` (`src/store/ui.ts`). To refresh a file, install the matching
`@fontsource-variable` package, copy `files/<family>-latin-wght-{normal,italic}.woff2`
here (normal + italic only) and update the version above.