import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TokenDetailView } from "./token-detail-view";

const { detail, listings, collection, ownership, trade, request, add } =
  vi.hoisted(() => ({
    detail: vi.fn(),
    listings: vi.fn(),
    collection: vi.fn(),
    ownership: vi.fn(),
    trade: vi.fn(),
    request: vi.fn(),
    add: vi.fn(),
  }));

vi.mock("@/lib/marketplace/hooks", () => ({
  useTokenDetailQuery: detail,
  useCollectionListingsQuery: listings,
  useCollectionQuery: collection,
}));
vi.mock("./use-token-ownership", () => ({ useTokenOwnership: ownership }));
vi.mock("@/lib/marketplace/use-trade", () => ({ useTrade: trade }));
vi.mock("@/lib/marketplace/api-client", () => ({
  marketplaceRequest: request,
}));
vi.mock("@/lib/marketplace/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketplace/config")>();
  return {
    ...actual,
    getMarketplaceRuntimeConfig: () =>
      actual.getMarketplaceRuntimeConfigFromEnv({
        NEXT_PUBLIC_MARKETPLACE_CHAIN_ID: "LOCAL",
        NEXT_PUBLIC_MARKETPLACE_COLLECTIONS: "0xa|Seed Realms|realms",
      }),
  };
});
vi.mock("@/features/cart/hooks/use-add-to-cart-feedback", () => ({
  useAddToCartFeedback: () => ({ addListingToCart: add }),
}));
vi.mock("@/features/trading/best-bid", () => ({ BestBid: () => null }));
vi.mock("@/features/trading/order-composer", () => ({
  OrderComposer: ({ kind }: { kind: string }) => <div>{kind} composer</div>,
}));
vi.mock("@/features/trading/accept-offer", () => ({
  AcceptOffer: () => <button>Review offer</button>,
}));
vi.mock("@/features/trading/report-token", () => ({
  ReportToken: () => <button>Report token</button>,
}));

const STRK =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ETH = 10n ** 18n;
const offer = (
  id: string,
  kind: string,
  tokenId: string | null,
  buyerDebit: string,
) => ({
  id,
  kind,
  tokenId,
  buyerDebit,
  currency: STRK,
  maker: "0x3",
  expiry: "4000000000",
});

function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TokenDetailView address="0xa" tokenId="1" />
    </QueryClientProvider>,
  );
}

function respond(overrides: Record<string, unknown> = {}) {
  request.mockImplementation((path: string) => {
    const match = Object.keys(overrides).find((suffix) => path.endsWith(suffix));
    if (match) return Promise.resolve(overrides[match]);
    if (path === "/collections/0xa/traits") return Promise.resolve([]);
    if (path === "/collections/0xa")
      return Promise.resolve({ address: "0xa", name: "Realms", tokenCount: "8000" });
    return Promise.resolve({ items: [], nextCursor: null });
  });
}

beforeEach(() => {
  detail.mockReturnValue({
    data: {
      token: {
        contract_address: "0xa",
        token_id: "1",
        image: "https://cdn.example/1.png",
        metadata: {
          name: "Realm One",
          description: "A realm",
          attributes: [
            { trait_type: "Power", value: 42 },
            { trait_type: "Resource", value: "Wood" },
          ],
        },
      },
    },
    refetch: vi.fn(),
  });
  listings.mockReturnValue({ data: [] });
  collection.mockReturnValue({ data: { metadata: { name: "Realms" } } });
  ownership.mockReturnValue({ effectiveIsOwner: false, holderAddress: "0x2" });
  trade.mockReturnValue({
    address: "0x3",
    config: { chain: "LOCAL", demo: false },
    busy: false,
    state: { stage: "idle", message: "" },
    execute: vi.fn(),
  });
  respond();
  add.mockReset();
});

it("retains token identity, traits, ownership and reporting", async () => {
  show();
  expect(screen.getByTestId("token-detail")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Realm One" })).toBeInTheDocument();
  expect(screen.getByText("#1")).toBeInTheDocument();
  expect(screen.getByText("ERC-721")).toBeInTheDocument();
  expect(screen.getByText("A realm")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Realm One" })).toHaveAttribute(
    "src",
    "https://cdn.example/1.png",
  );
  expect(screen.getByText("Power")).toBeInTheDocument();
  expect(screen.getByText("42")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "0x2" })).toHaveAttribute(
    "href",
    "/profile/0x2",
  );
  expect(screen.queryByText("You")).toBeNull();
  await waitFor(() =>
    expect(screen.getByText("Report token")).toBeInTheDocument(),
  );
});

it("links back to the collection by name", () => {
  show();
  expect(screen.getByRole("link", { name: "Realms" })).toHaveAttribute(
    "href",
    "/collections/0xa",
  );
});

it("falls back to the configured collection name, then the address", () => {
  collection.mockReturnValue({ data: undefined });
  const { unmount } = show();
  expect(screen.getByRole("link", { name: "Seed Realms" })).toHaveAttribute(
    "href",
    "/collections/0xa",
  );
  unmount();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TokenDetailView address="0x0123456789abcdef0123" tokenId="1" />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("link", { name: "0x0123...0123" })).toHaveAttribute(
    "href",
    "/collections/0x0123456789abcdef0123",
  );
});

it("marks the connected wallet as the owner", () => {
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  show();
  expect(screen.getByRole("link", { name: "0x3" })).toHaveAttribute(
    "href",
    "/profile/0x3",
  );
  expect(screen.getByText("You")).toBeInTheDocument();
});

it("says when the owner is not indexed yet", () => {
  ownership.mockReturnValue({ effectiveIsOwner: false, holderAddress: null });
  show();
  expect(screen.getByText("Not indexed")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /profile/ })).toBeNull();
});

it("keeps the offer composer collapsed until a visitor asks for it", () => {
  show();
  expect(screen.queryByText("token_offer composer")).toBeNull();
  const toggle = screen.getByRole("button", { name: "Make offer" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(screen.getByText("token_offer composer")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("token_offer composer")).toBeNull();
  expect(screen.queryByText("listing composer")).toBeNull();
});

it("offers a listing composer only to the owner", () => {
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  show();
  expect(screen.queryByRole("button", { name: "Make offer" })).toBeNull();
  expect(screen.queryByText("listing composer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "List for sale" }));
  expect(screen.getByText("listing composer")).toBeInTheDocument();
  expect(screen.queryByText("token_offer composer")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel listing" })).toBeNull();
});

it("lets the owner cancel a live listing in one transaction", () => {
  const execute = vi.fn();
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  trade.mockReturnValue({
    address: "0x3",
    config: { chain: "LOCAL", demo: false },
    busy: false,
    state: { stage: "idle", message: "" },
    execute,
  });
  listings.mockReturnValue({
    data: [
      {
        id: "LOCAL:0x900:0x3:7",
        owner: "0x3",
        tokenId: "1",
        price: (2n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
    ],
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Cancel listing" }));
  expect(execute).toHaveBeenCalledWith(expect.any(Function), "cancel");
  expect(screen.getByText("You own this item")).toBeDisabled();
});

it("summarizes the market at a glance", async () => {
  listings.mockReturnValue({
    data: [
      {
        id: "LOCAL:0x900:0x9:1",
        owner: "0x9",
        tokenId: "1",
        price: (18n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
      {
        id: "LOCAL:0x900:0x9:2",
        owner: "0x9",
        tokenId: "1",
        price: (20n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
    ],
  });
  respond({
    "/offers": {
      items: [
        offer("a", "collection_offer", null, (15n * ETH).toString()),
        offer("b", "token_offer", "1", (16n * ETH).toString()),
        offer("c", "token_offer", "2", (99n * ETH).toString()),
      ],
      nextCursor: null,
    },
    "/activity": {
      items: [
        {
          id: "s1",
          type: "order_filled",
          buyerDebit: (21n * ETH).toString(),
          currency: STRK,
          buyer: "0x2",
          seller: "0x1",
          provenance: { timestamp: 1_760_000_000, transactionHash: "0xabc" },
        },
      ],
      nextCursor: null,
    },
  });
  show();
  expect(screen.getByTestId("market-summary-price")).toHaveTextContent("18 STRK");
  expect(screen.getByText("2 open listings")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByTestId("market-summary-top-offer")).toHaveTextContent(
      "16 STRK",
    ),
  );
  await waitFor(() =>
    expect(screen.getByTestId("market-summary-last-sale")).toHaveTextContent(
      "21 STRK",
    ),
  );
  expect(screen.getByText("Sale")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add to cart" })).toBeEnabled();
});

it("shows trait rarity and in-game resource artwork", async () => {
  respond({
    "/traits": [
      { name: "Power", kind: "number", values: [{ value: 42, count: "80" }] },
      { name: "Resource", kind: "string", values: [{ value: "Wood", count: "2000" }] },
    ],
  });
  const { container } = show();
  await waitFor(() =>
    expect(screen.getByText("1.0% have this")).toBeInTheDocument(),
  );
  expect(screen.getByText("25% have this")).toBeInTheDocument();
  expect(container.querySelector('img[src="/resources/wood.png"]')).not.toBeNull();
  expect(screen.getByRole("link", { name: /Wood/ })).toHaveAttribute(
    "href",
    "/collections/0xa?trait=Resource%3AWood",
  );
});

it("renders loading before offering trades", () => {
  detail.mockReturnValue({ isLoading: true });
  show();
  expect(screen.getByRole("status", { name: "Loading token" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Make offer" })).toBeNull();
});

it("offers retry without fake token content on failure", () => {
  const refetch = vi.fn();
  detail.mockReturnValue({ isError: true, refetch });
  show();
  expect(screen.getByRole("alert")).toHaveTextContent("Unable to load this token");
  fireEvent.click(screen.getByText("Retry"));
  expect(refetch).toHaveBeenCalled();
});

it("surfaces listing failures inline with a retry", () => {
  const refetch = vi.fn();
  listings.mockReturnValue({ isError: true, refetch });
  show();
  expect(screen.getByRole("alert")).toHaveTextContent("Listing prices are unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalled();
});

it("requires a proceeds review for matching collection and token offers", async () => {
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  respond({
    "/offers": {
      items: [
        offer("a", "collection_offer", null, "100"),
        offer("b", "token_offer", "1", "200"),
        offer("c", "token_offer", "2", "300"),
      ],
      nextCursor: null,
    },
  });
  show();
  await waitFor(() => expect(screen.getAllByText("Review offer")).toHaveLength(2));
});

it("lets any visitor share the asset with its listed price", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://market.realms.world";
  ownership.mockReturnValue({ effectiveIsOwner: false, holderAddress: "0x9" });
  listings.mockReturnValue({
    data: [
      {
        id: "LOCAL:0x900:0x9:1",
        owner: "0x9",
        tokenId: "1",
        price: (27n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
    ],
  });
  show();

  await userEvent.setup().click(screen.getByRole("button", { name: "Share" }));
  const post = await screen.findByRole("menuitem", { name: "Post on X" });
  const intent = new URL(post.getAttribute("href")!);
  expect(intent.searchParams.get("url")).toBe("https://market.realms.world/collections/0xa/1");
  expect(intent.searchParams.get("text")).toBe("Realm One for 27 STRK on Realms.market");
  expect(screen.queryByRole("heading", { name: "Your listing is live" })).toBeNull();
});

it("leaves a previous owner's listing out of the share text, as the preview does", async () => {
  ownership.mockReturnValue({ effectiveIsOwner: false, holderAddress: "0x2" });
  listings.mockReturnValue({
    data: [
      {
        id: "LOCAL:0x900:0x9:1",
        owner: "0x9",
        tokenId: "1",
        price: (10n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
    ],
  });
  show();

  await userEvent.setup().click(screen.getByRole("button", { name: "Share" }));
  const post = await screen.findByRole("menuitem", { name: "Post on X" });
  expect(new URL(post.getAttribute("href")!).searchParams.get("text")).not.toContain("STRK");
});

it("prompts the owner to share once their listing is indexed, until dismissed", () => {
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  listings.mockReturnValue({
    data: [
      {
        id: "LOCAL:0x900:0x3:7",
        owner: "0x3",
        tokenId: "1",
        price: (2n * ETH).toString(),
        currency: STRK,
        status: "placed",
      },
    ],
  });
  show();

  const prompt = screen.getByRole("region", { name: "Your listing is live" });
  expect(prompt).toHaveTextContent("your price of 2 STRK");
  expect(screen.getByRole("link", { name: "Post on X" })).toHaveAttribute("target", "_blank");

  fireEvent.click(screen.getByRole("button", { name: "Dismiss share suggestion" }));
  expect(screen.queryByRole("region", { name: "Your listing is live" })).toBeNull();
});

it("keeps a dismissed share prompt hidden after the page reloads", () => {
  window.localStorage.clear();
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  const placed = {
    id: "LOCAL:0x900:0x3:8",
    owner: "0x3",
    tokenId: "1",
    price: (2n * ETH).toString(),
    currency: STRK,
    status: "placed",
  };
  listings.mockReturnValue({ data: [placed] });
  const first = show();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss share suggestion" }));
  first.unmount();

  show();
  expect(screen.queryByRole("region", { name: "Your listing is live" })).toBeNull();

  cleanup();
  listings.mockReturnValue({ data: [{ ...placed, id: "LOCAL:0x900:0x3:9" }] });
  show();
  expect(screen.getByRole("region", { name: "Your listing is live" })).toBeInTheDocument();
  window.localStorage.clear();
});

it("does not prompt the owner to share before a listing is indexed", () => {
  ownership.mockReturnValue({ effectiveIsOwner: true, holderAddress: "0x3" });
  show();
  expect(screen.queryByRole("region", { name: "Your listing is live" })).toBeNull();
});
