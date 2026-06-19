# Bundled fonts — attribution & license

MeetingSpace self-hosts two typefaces for the **generated-document** render and
export (white paper, minutes), so the designed typography renders with **zero
network** — the render iframe is `sandbox=""` (an opaque origin), so the fonts ride
as base64 `data:` URIs in an injected `@font-face` block (see ADR-0013). The app's
own UI is unaffected.

Both fonts are licensed under the **SIL Open Font License, Version 1.1** (OFL-1.1).
The full license text (with each project's copyright and any Reserved Font Name) is
in this directory:

| Font | Weights bundled (latin subset) | Copyright | License file |
|---|---|---|---|
| **Inter** | 400, 600, 700 | © 2016 The Inter Project Authors (https://github.com/rsms/inter) | `Inter-LICENSE.txt` |
| **Merriweather** | 400, 700 | © 2016 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather), with Reserved Font Name "Merriweather" | `Merriweather-OFL.txt` |

The `.woff2` files are the latin-subset builds (the weights the generation prompts
use), sourced from the [Fontsource](https://fontsource.org) distribution of the
upstream OFL projects. Subsetting/format-conversion is permitted under OFL-1.1 §1.

**OFL-1.1 obligations honored here:** the fonts are bundled with this license and
copyright notice; they are not sold by themselves; and neither font is distributed
under a Reserved Font Name other than as licensed (we do not rename Merriweather).
