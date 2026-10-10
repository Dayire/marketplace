const COLLECTION_BANNERS_BY_NAME: Record<string, string> = {
  adventurers: "/banners/adventurers.png",
  beasts: "/banners/beasts.jpg",
  cosmetics: "/banners/cosmetics.jpg",
  "golden token": "/banners/golden-token.png",
  "loot chests": "/banners/loot-chests.png",
  realms: "/banners/realms.png",
};

// Square artwork for cards and thumbnails, for collections whose banner is
// missing or unsuitable. Cosmetics uses token #1 (Legacy Keep) without its
// rarity frame.
const COLLECTION_IMAGES_BY_NAME: Record<string, string> = {
  cosmetics: "/collection-images/cosmetics.jpg",
};

function collectionKey(name: string | null | undefined) {
  return name ? name.trim().toLowerCase() : null;
}

export function getCollectionBannerImage(name: string | null | undefined) {
  const key = collectionKey(name);
  if (!key) {
    return null;
  }

  return COLLECTION_BANNERS_BY_NAME[key] ?? null;
}

export function getCollectionImage(name: string | null | undefined) {
  const key = collectionKey(name);
  if (!key) {
    return null;
  }

  return COLLECTION_IMAGES_BY_NAME[key] ?? getCollectionBannerImage(name);
}

/**
 * Downscaled JPEG copies of the banners for server-rendered share images,
 * which decode the whole file on every render (see public/share/banners).
 */
const COLLECTION_SHARE_BANNERS_BY_NAME: Record<string, string> = {
  adventurers: "/share/banners/adventurers.jpg",
  beasts: "/share/banners/beasts.jpg",
  cosmetics: "/share/banners/cosmetics.jpg",
  "golden token": "/share/banners/golden-token.jpg",
  "loot chests": "/share/banners/loot-chests.jpg",
  realms: "/share/banners/realms.jpg",
};

export const SHARE_BANNERS = Object.values(COLLECTION_SHARE_BANNERS_BY_NAME);

export function getCollectionShareBanner(name: string | null | undefined) {
  const key = collectionKey(name);
  if (!key) {
    return null;
  }

  return COLLECTION_SHARE_BANNERS_BY_NAME[key] ?? null;
}

/** Square artwork made for a collection, when it has one (not a banner). */
export function getCollectionSquareImage(name: string | null | undefined) {
  const key = collectionKey(name);
  return key ? (COLLECTION_IMAGES_BY_NAME[key] ?? null) : null;
}
