# UI fonts

Unmodified variable font files downloaded from the Google Fonts repository on
8 October 2026. Bundled locally so Next.js builds do not depend on Google's font
service or its generated font URLs. The application's existing families and CSS
variables are retained.

- Exo 2: https://github.com/google/fonts/tree/main/ofl/exo2 — `exo-2-OFL.txt`
- Geist Mono: https://github.com/google/fonts/tree/main/ofl/geistmono — `geist-mono-OFL.txt`

Both fonts are distributed under the SIL Open Font License 1.1. Keep the respective
license files with the fonts when redistributing them.

SHA-256 checksums:

- `exo-2-variable.ttf`: `205a448676a2586f9c57c25f3d5c58ca8db7e6cf5edf7506783a010c6fe2bfb5`
- `geist-mono-variable.ttf`: `d00e590b8eb3a59acc329b2d044fd143ae935090b7da33199ebee27cc7de8196`

## Static share-card instances

`next/og` (Satori) cannot parse variable fonts, so share images use static
instances derived from `exo-2-variable.ttf` with fontTools 4.60.1. They are not
used by the site itself.

```sh
fonttools varLib.instancer exo-2-variable.ttf wght=400 --static --update-name-table -o exo-2-400-static.ttf
fonttools varLib.instancer exo-2-variable.ttf wght=600 --static --update-name-table -o exo-2-600-static.ttf
```

- `exo-2-400-static.ttf`: `742821abd29d141d9d37327b012a19dfbb6ae2eab76bd379583711ff2bf4fdc0`
- `exo-2-600-static.ttf`: `877523290a192adf7de45e8a9118dfc217320876de12b03a4495af5b98eea5ea`

The display face `../im-fell-english-sc-regular.ttf` is already static.
