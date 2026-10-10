# Storybook component workbench

Storybook is the place to inspect the existing brand implementation and verify component interactions in isolation. It uses the production Next.js components, Tailwind v4 CSS, local assets and shared font configuration. The current foundation stories are an inventory, not a newly approved brand guideline.

## Run and test

Use the repository's Node 22.22 / pnpm 10.8.1 toolchain.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm storybook
```

Open `http://localhost:6006`. The marketplace API and a wallet extension are not required.

```sh
pnpm storybook:test        # Chromium play functions and accessibility checks
pnpm storybook:test:watch  # Watch component interactions while editing
pnpm storybook:build       # Portable static site in storybook-static/
pnpm test                 # Existing jsdom unit/integration project
pnpm test:coverage        # Combined unit + real-browser coverage, unchanged 70% gates
```

Storybook 10.6.1 uses the Next.js/Vite framework and Vitest 4.1.11 browser integration. The two Vitest projects are named `unit` and `storybook`. Accessibility uses `a11y.test: 'error'`, so violations fail tests. This was verified with a temporary unnamed-button story, which failed the button-name rule and was removed.

CI installs Chromium before coverage, runs both projects, builds Storybook, and uploads its static output as a seven-day artifact. No paid service, external publication or new backend runtime dependency is required.

When a compatible Chromium is already installed locally, set `CHROMIUM_EXECUTABLE_PATH` to its executable for `storybook:test`, `test:coverage` or `test:e2e`. Omitting it uses the pinned Playwright browser, as in CI.

## Catalog

- **Foundations:** current palette, surfaces, typography and dark/light review.
- **UI:** button variants, disabled and keyboard states; form input/select/switch; confirmation-dialog focus and dismissal; tab navigation.
- **Wallet:** disconnected/connected header, connect/disconnect, rejection, missing extension and pending approval.
- **Marketplace UX:** responsive header, wallet entry points, currency-labelled prices, mobile filters, collapsible statistics, single purchase action, activity provenance, public status and wallet identity.
- **Trading:** cart contents, disabled checkout, removal, invalid listing, wallet rejection and success; offer proceeds confirmation; listing/token/collection offers and repricing; funded/empty/partial/unavailable bids; transaction status and delayed indexing.

Use the Interactions panel to step through a story's play function, the Accessibility panel to inspect findings, and the viewport/theme controls for visual review. Automated accessibility is a useful gate, not a complete manual accessibility review.

## Add a story

Place `component.stories.tsx` alongside the production component and use typed Component Story Format:

```tsx
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn } from 'storybook/test';
import { Button } from './button';

const meta = {
  title: 'UI/Button',
  component: Button,
  args: { children: 'Continue', onClick: fn() },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Activate: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};
```

Assert observable behavior: visible errors, disabled controls, exact displayed amounts, focus, retained input and callbacks. Use `findByRole` for asynchronously added content and `waitFor` for transitions/focus restoration; do not add arbitrary sleeps. Query portalled dialogs and menus through `within(canvasElement.ownerDocument.body)`. Browser story files run serially to keep keyboard/focus checks stable.

## Fixture boundary

`.storybook/main.mts` replaces only wallet hooks, `useTrade` and the marketplace API module inside the Storybook builder. Application builds and unit tests keep the real modules. The actual header, form components, order calldata helpers, cart and status components still run.

`.storybook/scenario.ts` defines named outcomes. Set them in a story's `beforeEach`, after the global reset. `.storybook/mocks/` contains observable mock functions and explicit API responses. Unknown API paths throw instead of falling through to live services. The preview provides a fresh React Query client, resets cart/currency/scenario state, and renders docs examples in separate iframes to avoid state leaking between examples.

The signing mock records calls without contacting a wallet or chain. These stories establish UI behavior; contract settlement, wallet compatibility and actual network switching remain covered by separate unit/devnet/browser-wallet validation. The existing owned-data integration tests exercise the real React Query/API adapters so fixtures are not the sole evidence for data wiring.

## Visual foundations

- Production tokens and typography rules: `src/app/globals.css`.
- Shared Next.js font loaders and semantic font bindings: `src/lib/fonts.ts` (used by the app layout and preview). Typography stories verify Exo 2, Geist Mono and the local display face.
- Current local imagery and logo: `public/`.
- Storybook manager/docs chrome: `.storybook/theme.ts`.

Keep app tokens authoritative. Change brand choices through a separate, reviewed brand-guideline task; do not quietly redesign production colors to make a story pass. Use real components rather than duplicated mock screens.

## Coverage boundaries and next work

The catalog is a starting set, not exhaustive verification of all marketplace journeys. Add authenticated inbox/report/moderation, dashboard pagination, wallet network changes, recovery/retry and mobile-specific states as those components are developed. Before calling a workflow verified, distinguish a simulated story, a full-app browser test and a real signed transaction.

Coverage combines unit and browser tests. The upgrade from Vitest 2 changed coverage accounting; the 70% thresholds remain unchanged. Story files, fixture wrappers and font-loader configuration are excluded from application coverage; production interaction code remains included.

References: [Next.js/Vite framework](https://storybook.js.org/docs/get-started/frameworks/nextjs-vite), [Vitest integration](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon), [interaction testing](https://storybook.js.org/docs/writing-tests/interaction-testing).

## Marketplace spacing

Use `.market-page` for one page-level inset: 16px below 640px, 24px above.
Do not add a second page gutter inside a route wrapper. Collection banners bleed
through that inset; their minimum height is 128px on mobile and 160px above 640px,
and long titles can grow the banner rather than overlap its statistics.

Use 16px between collection sections, 12px between assets, 12px for card text
insets and 8px for card action insets. `AssetGrid` sizes columns from available
content width: 192px minimum in compact mode and 160px in dense mode, with two
columns on phones. Keep media aspect ratios collection-specific. Asset action
buttons retain 44px touch targets and wrap when their labels need more room.

`Marketplace/Asset layout` → `Comfortable` and `Dense` exercise real cards,
the collection banner and filter layout, including long names, missing artwork
and unlisted assets. The spacing pass checked 320, 390, 639, 640, 768, 1024,
1279, 1280, 1440 and 1920px, including button clipping, focus and overflow.

## Collection discovery without a navigation rail

`Marketplace/Full width navigation` → `Collection` and `Mobile` compose the
production header, server-renderable page shell, trait filters and asset cards.
The header's Explore link goes to `/`; global search remains
available beside it on desktop and in a focused panel on mobile. Collection-specific traits remain in the browsing view.
The global shell must not mount collection-list queries or thumbnail fallbacks.
The removed desktop collection rail and mobile collection drawer should not be
reintroduced as a second navigation system.

Reference: [OpenSea's collection page](https://opensea.io/collection/azuki),
inspected 7 October 2026. OpenSea currently separates compact global navigation
and search from collection-specific filters. Our implementation removes the
collection rail completely while retaining the existing Realms branding.

## Unknown submission recovery

`Trading/Unknown submission recovery` covers verified-hash confirmation,
wallet-confirmed non-submission, lookup failure, busy and mobile states.
`Trading/Saved transaction toolbar` verifies that the real toolbar exposes the
same component and hides it after successful reconciliation without signing.
The form was checked at 320, 768 and 1440px, including keyboard checkbox operation,
wrapped buttons and retained input after errors. Hash recovery checks the current
chain, transaction hash and wallet sender; the user must confirm that the hash
belongs to the attempted action. Non-submission requires explicit wallet confirmation;
recovery never automatically replays a trade. Real wallet-provider rehearsal remains
separate from these component and adapter tests.

## Offer review and transaction feedback

`Marketplace/Asset offers` covers populated, owner, empty, loading, failed,
paginated and long-value layouts. The multiple-offer review story uses the actual
acceptance component and checks that only one transaction dialog appears without
moving the offer list.

`Trading/Transaction modal` covers preparation, wallet approval, submission,
index updates, delayed indexing, completion, rejection, reversion and unknown
submission. `Trading/Order composer` checks that content below the form stays in
place while the modal is open, preserves entered terms after rejection, and checks
keyboard focus after dismissal. `Trading/Offer review` verifies the proceeds/fee
breakdown and focus after the review-to-transaction handoff.

The toolbar owns one `TransactionFeedback` instance. Trade controls must not mount
additional transaction dialogs or inline copies of the shared transaction state.
The active dialog remains open while the coordinator is busy. When tracking stops,
it can be dismissed and reopened from the toolbar; delayed transactions expose a
read-only status check. Dismissal never clears or resubmits a saved transaction.
These stories simulate wallet responses; they do not sign real transactions.

`Trading/Price input` checks decimal entry without floating-point conversion,
currency switching, long values, validation and disabled states. The
composer has no editable royalty cap. Realms uses zero; reviewed royalty-bearing
collections use the registry ceiling, display "up to" that percentage and show
minimum seller proceeds. `CreatorRoyalty` and `CreatorRoyaltyMobile` cover a 5%
ceiling and exact calldata. Mixed selections conservatively use the highest
reviewed ceiling. Layouts were checked at 390, 768 and 1440px.

Exo 2 and Geist Mono are bundled under `public/brand/fonts` with their OFL licenses.
This removes the Google font-service dependency from production builds. The preview
uses the same font files through public URLs because its local-font adapter emits
invalid unquoted filesystem URLs when the workspace path contains spaces. Font
stories verify that the declared faces load rather than silently using a fallback.

## Marketplace navigation

`Marketplace/Navigation` develops the same two-tier header used by the app. The
top bar is the Realms.World chrome shared with the rest of the site: the
Realms.World mark, the Home, Games, Account, Marketplace and Scroll sections
(Marketplace is the current one) and the X, Discord and GitHub links. Below it
the sticky marketplace toolbar carries the Realms Market wordmark, Explore,
Portfolio and Trading, global search, the market-status dot, notifications,
the cart and the wallet control. Below 1024px the ecosystem links, marketplace
destinations, wallet and community links move into the menu opened from the
top bar, and search opens in a focused sheet. The banner is 108px tall on
desktop. The footer repeats the ecosystem and community links.

`MarketToolbar` remains the single transaction-feedback host. It renders an
alert only for unavailable trading or demo data, with transaction recovery in
a fixed control that does not shift page content. The header's market-status
indicator links to `/ops` for detailed freshness and renders a neutral
"Checking market" label until hydration so server and client markup agree.
Checkout gating is unchanged. Navigation stories cover wallet connection and
disconnection, search focus and escape, active routes, populated cart, market
errors, demo mode and pending transactions.

## Market currency

`Marketplace/Currency switcher` is the segmented control that replaced the
bare currency select. Every option shows its token mark, the active choice is
checked, arrow keys move between options and an explainer says what the
currency scopes (floors, listings, offers, statistics and the default for new
orders). The choice is remembered per browser; `MarketplaceProvider`
rehydrates it after mount so server and client markup match. The wallet
balance menu in the header doubles as the same picker. Stories cover the
default, connected wallet balance, the explainer tooltip, a single currency
and the 320px viewport.

## Collection market header, tabs and analytics

The collection banner carries the currency switcher and
`Marketplace/Collection stats`: floor, top offer, 7-day volume and sales,
listed share and supply, each label explaining its source on hover and focus.
The page splits into Items, Offers, Activity and Analytics tabs kept in the
URL (`tab=`), alongside `trait`, `sort`, `q` (search within the collection)
and `listed=1`.

`Marketplace/Collection toolbar` covers in-collection search, the listed-only
switch, the sort select (per-collection options such as Resources for Realms)
and the comfortable, dense and list layouts, with removable filter chips
underneath. `Marketplace/Collection offers` lists open collection and token
offers and opens the collection-offer composer inline.
`Marketplace/Collection activity` is the event feed with Sales, Listings,
Offers and Transfers filters, a table on md+ and stacked cards below.

`Marketplace/Collection analytics` draws floor history, volume, sales and
listing depth as plain SVG with a crosshair or per-mark tooltip, a period
filter that scopes every tile and chart, and a table twin for each chart so no
value depends on hover. Charts use the brass accent only; identity never
depends on colour alone. Stories cover populated, empty, error and mobile
states; the fixture backend (`pnpm backend:demo`) now seeds thirty days of
sales so the same screens can be checked against the running app.

## Token page

`Marketplace/Token market summary` and `Marketplace/Trait grid` are the pure
pieces of the restructured token page: price, top offer and last sale tiles
with explainers, and trait cards that link to the filtered collection, show
how rare each value is and render Realm resources with the in-game artwork
from `public/resources`. The page itself keeps the order and listing forms
collapsed until asked for.

## Link previews and sharing

`Share/Link previews` develops the 1200×630 cards that `next/og` renders for
link unfurls: listed Realm (resources as icons, rarest first), top offer in
LORDS, last sale, unlisted Cosmetic with a long name, Loot Chest, Golden
Token, unavailable asset, collection, collection without listings and the
site-wide default. The cards are inline-styled components because the
renderer supports a CSS subset (every element with several children sets
`display: flex`; no style key may be `undefined`). Stories register the same
static Exo 2 instances the server uses and scale the card to the viewport,
as unfurlers do. `render-share-image.test.tsx` renders every state through
the real renderer, so a layout the renderer rejects fails `pnpm test`.

`Share/Share actions` covers the asset page's Share menu (copy link, post on
X, system share sheet when the browser has one, copy failure, keyboard use)
and the owner's "Your listing is live" prompt, including a long price and a
failed copy. Both were checked at 320, 375, 768 and 1280px for wrapping,
44px touch targets and horizontal overflow, and on the running app's token
page against the fixture backend. Clipboard and share-sheet calls are stubbed
in stories; the owner prompt has not been exercised with a real wallet.

## Artwork and resource icons

`TokenMedia` renders NFT artwork lazily, falls through alternate IPFS
gateways on error and ends in a labelled placeholder; `tokenMediaSources`
turns cached assets, `imageSourceUri`, legacy `image_url` and inline SVG into
candidate URLs. Realm resource icons are the Eternum game catalogue, keyed by
the game's resource names (`src/components/marketplace/resource-icon.tsx`).

`CollectionNotEnabled` verifies indexed-but-not-allowlisted collections cannot submit orders or show a misleading proceeds quote. The configuration endpoint supplies the indexed collection policy; live config polling updates the form after administrator activation.

## Loading states

Use `Skeleton` for the shared muted surface, corner radius and reduced-motion-safe
pulse. Group decorative placeholders in `LoadingRegion` so each section has one
accessible status announcement. Use `AssetGridSkeleton` for card grids (pass the
same density and media aspect ratio as the populated view), `ListSkeleton` for
orders/activity, and `TokenDetailSkeleton` for the token page. Limit placeholder
counts; do not render a skeleton for every NFT in a large wallet.

Route `loading.tsx` files and Suspense fallbacks reuse these components. Keep
existing data and controls visible during background refetches; skeletons represent
initial pending data. Price, offer and sale summaries must not display an empty
result before their respective request completes. Action progress stays on the
button or in the existing transaction modal. Artwork pulses within its reserved
media area until loaded, then stops, including when a browser-cached image is used.

`Marketplace/Loading states` covers assets, density, portrait media, orders,
activity, token details, collection and home shells. `Marketplace/Artwork loading`,
`Marketplace/Operator loading` and `Marketplace/Token market summary/Loading`
cover image completion/failure, disabled actions during a report request and
pending prices. Browser review includes 390, 768 and 1440px layouts; a delayed
local fixture API verifies home → collection → token and portfolio loading to
content transitions. Wallet-only data states use isolated stories/tests; no live
wallet transaction is required for this presentation change.
