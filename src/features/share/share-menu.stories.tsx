import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import { ListingSharePrompt } from "./listing-share-prompt";
import { ShareMenu } from "./share-menu";

const target = {
  url: "https://market.realms.world/collections/0x07ae27a31bb6526e3de9cf02f081f6ce0615ac12a6d7b85ee58b8ad7947a2809/4",
  title: "Realms #4 | Realms | Realms.market",
  text: "Realms #4 for 27.16 STRK on Realms.market",
};

const writeText = fn<(text: string) => Promise<void>>();
const nativeShare = fn<(data: ShareData) => Promise<void>>();

/** Replaces browser sharing APIs so stories never touch the real clipboard. */
function stubSharing({ clipboard = "ok", native = false }: { clipboard?: "ok" | "fail"; native?: boolean }) {
  writeText.mockReset();
  writeText.mockImplementation(() =>
    clipboard === "ok" ? Promise.resolve() : Promise.reject(new Error("denied")),
  );
  nativeShare.mockReset();
  nativeShare.mockResolvedValue(undefined);
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: native ? nativeShare : undefined,
  });
  return () => {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    if (shareDescriptor) Object.defineProperty(navigator, "share", shareDescriptor);
    else delete (navigator as { share?: unknown }).share;
  };
}

/** Radix hides the page behind an open menu; wait until it is restored. */
async function menuClosed(trigger: HTMLElement) {
  await waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-hidden");
  });
}

const meta = {
  title: "Share/Share actions",
  component: ShareMenu,
  args: { target },
  beforeEach: () => stubSharing({}),
} satisfies Meta<typeof ShareMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CopyLink: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    await userEvent.click(trigger);
    const menu = within(canvasElement.ownerDocument.body);
    await userEvent.click(await menu.findByRole("menuitem", { name: "Copy link" }));

    await expect(writeText).toHaveBeenCalledWith(target.url);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Link copied");
    await menuClosed(trigger);
    await expect(trigger).toHaveFocus();
  },
};

export const PostOnX: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    await userEvent.click(trigger);
    const link = await within(canvasElement.ownerDocument.body).findByRole("menuitem", {
      name: "Post on X",
    });
    const href = new URL(link.getAttribute("href")!);

    await expect(href.origin + href.pathname).toBe("https://x.com/intent/post");
    await expect(href.searchParams.get("url")).toBe(target.url);
    await expect(href.searchParams.get("text")).toBe(target.text);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.keyboard("{Escape}");
    await menuClosed(trigger);
  },
};

export const KeyboardCopy: Story = {
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(within(document.body).getByRole("menuitem", { name: "Copy link" })).toHaveFocus(),
    );
    await userEvent.keyboard("{Enter}");

    await expect(writeText).toHaveBeenCalledWith(target.url);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Link copied");
    await menuClosed(trigger);
    await expect(trigger).toHaveFocus();
  },
};

export const CopyFails: Story = {
  beforeEach: () => stubSharing({ clipboard: "fail" }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    await userEvent.click(trigger);
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("menuitem", { name: "Copy link" }),
    );

    await expect(await canvas.findByRole("status")).toHaveTextContent("Couldn't copy");
    await menuClosed(trigger);
  },
};

export const SystemShareSheet: Story = {
  beforeEach: () => stubSharing({ native: true }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    await userEvent.click(trigger);
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("menuitem", { name: "More options…" }),
    );

    await expect(nativeShare).toHaveBeenCalledWith({
      title: target.title,
      text: target.text,
      url: target.url,
    });
    await menuClosed(trigger);
  },
};

export const WithoutSystemShareSheet: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share" });
    await userEvent.click(trigger);
    const menu = within(canvasElement.ownerDocument.body);
    await menu.findByRole("menuitem", { name: "Copy link" });

    await expect(menu.queryByRole("menuitem", { name: "More options…" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await menuClosed(trigger);
  },
};

export const ListingLivePrompt: StoryObj<typeof ListingSharePrompt> = {
  render: (args) => (
    <div className="max-w-xl">
      <ListingSharePrompt {...args} />
    </div>
  ),
  args: { target, price: "27.16 STRK", onDismiss: fn() },
  play: async ({ canvas, args, userEvent }) => {
    await expect(canvas.getByRole("heading", { name: "Your listing is live" })).toBeVisible();
    await expect(canvas.getByText("27.16 STRK")).toBeVisible();
    await expect(canvas.getByText(/usually within a minute of listing/)).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Copy link" }));
    await expect(writeText).toHaveBeenCalledWith(target.url);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Link copied");

    await expect(canvas.getByRole("link", { name: "Post on X" })).toHaveAttribute("target", "_blank");

    await userEvent.click(canvas.getByRole("button", { name: "Dismiss share suggestion" }));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const ListingPromptLongPrice: StoryObj<typeof ListingSharePrompt> = {
  render: (args) => (
    <div className="max-w-xl">
      <ListingSharePrompt {...args} />
    </div>
  ),
  args: { target, price: "1085.123456789012345678 LORDS", onDismiss: fn() },
  beforeEach: () => stubSharing({ clipboard: "fail" }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Copy link" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("Couldn't copy");
  },
};
