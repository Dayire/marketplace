import type { CollectionShareData, TokenShareData } from "@/lib/marketplace/seo-data";
import { groupDigits, type SharePrice, type ShareTraitSummary } from "./share-card-model";

/** Text that accompanies share images: social titles, descriptions and alt text. */

const SITE = "Realms.market";

const amount = (price: SharePrice) => `${price.display} ${price.symbol}`;

function traitSentence(traits: ShareTraitSummary) {
  if (traits.items.length === 0) return null;
  if (traits.layout === "resources") {
    return `Resources: ${traits.items.map((trait) => trait.value).join(", ")}.`;
  }
  return traits.items.map((trait) => `${trait.label}: ${trait.value}.`).join(" ");
}

const PRICE_PHRASES: Record<SharePrice["kind"], { sentence: string; alt: string }> = {
  listing: { sentence: "Listed for", alt: "listed for" },
  offer: { sentence: "Top offer:", alt: "top offer" },
  sale: { sentence: "Last sale:", alt: "last sale" },
  floor: { sentence: "Floor", alt: "floor" },
};

export function tokenShareCopy(card: TokenShareData) {
  const identity = `${card.tokenName} from ${card.collectionName}`;

  if (!card.exists) {
    return {
      socialTitle: card.tokenName,
      description: `${card.tokenName} is unavailable on ${SITE}.`,
      imageAlt: `${card.tokenName} on ${SITE}`,
    };
  }

  const price = card.price;
  const lead =
    price?.kind === "listing"
      ? `${identity} is listed for ${amount(price)} on ${SITE}.`
      : `${identity} on ${SITE}.${price ? ` ${PRICE_PHRASES[price.kind].sentence} ${amount(price)}.` : ""}`;

  return {
    socialTitle: price?.kind === "listing" ? `${card.tokenName} for ${amount(price)}` : card.tokenName,
    description: [lead, traitSentence(card.traits)].filter(Boolean).join(" "),
    imageAlt: price ? `${identity}, ${PRICE_PHRASES[price.kind].alt} ${amount(price)}` : identity,
  };
}

export function collectionShareCopy(card: CollectionShareData) {
  if (!card.exists) {
    return {
      title: `Collection ${card.name}`,
      description: `Collection ${card.name} is unavailable on ${SITE}.`,
      imageAlt: `Collection ${card.name} on ${SITE}`,
    };
  }

  const listed = card.listedCount
    ? `${groupDigits(card.listedCount)} listed${card.supply ? ` of ${groupDigits(card.supply)}` : ""}`
    : null;
  const market = [card.floor ? `Floor ${amount(card.floor)}` : null, listed]
    .filter(Boolean)
    .join(", ");

  return {
    title: card.name,
    description: [
      card.description ?? `Explore listings and activity for ${card.name}.`,
      market ? `${market}.` : null,
    ]
      .filter(Boolean)
      .join(" "),
    imageAlt: card.floor
      ? `${card.name} on ${SITE}, floor ${amount(card.floor)}`
      : `${card.name} on ${SITE}`,
  };
}
