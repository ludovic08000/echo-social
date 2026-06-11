/**
 * Centralised builders for OpenGraph / Twitter / JSON-LD metadata.
 * Used by SEOHead consumers across Feed, Profile, PostDetail, etc.
 */

const SITE_BASE = 'https://forsure.fans';
const DEFAULT_IMAGE = `${SITE_BASE}/og-image.jpg`;

function clamp(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
}

function absUrl(maybeUrl?: string | null): string | undefined {
  if (!maybeUrl) return undefined;
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  if (maybeUrl.startsWith('/')) return `${SITE_BASE}${maybeUrl}`;
  return undefined;
}

export interface FeedMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  jsonLd: Record<string, unknown>;
}

export function buildFeedMeta(): FeedMeta {
  return {
    title: 'Fil d\'actualité — Réseau social éthique sans pub',
    description: "Découvrez le fil d'actualité Forsure : publications, lives, vidéos et marketplace. 100% sans publicité ni tracking, alternative française à Facebook et Instagram.",
    url: `${SITE_BASE}/feed`,
    image: DEFAULT_IMAGE,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Fil d\'actualité Forsure',
      url: `${SITE_BASE}/feed`,
      isPartOf: { '@type': 'WebSite', name: 'Forsure', url: SITE_BASE },
      inLanguage: 'fr-FR',
    },
  };
}

export interface ProfileMetaInput {
  username?: string | null;
  name?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  city?: string | null;
}

export function buildProfileMeta(input: ProfileMetaInput): FeedMeta {
  const display = input.name || input.username || 'Utilisateur';
  const handle = input.username ? `@${input.username}` : '';
  const title = `${display}${handle ? ` (${handle})` : ''} sur Forsure`;
  const description = clamp(
    input.bio ||
      `Découvrez le profil de ${display}${input.city ? ` à ${input.city}` : ''} sur Forsure, le réseau social éthique français sans publicité ni tracking.`,
    160,
  );
  const url = input.username ? `${SITE_BASE}/@${input.username}` : SITE_BASE;
  const image = absUrl(input.avatarUrl) || DEFAULT_IMAGE;

  return {
    title,
    description,
    url,
    image,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      mainEntity: {
        '@type': 'Person',
        name: display,
        ...(input.username ? { alternateName: `@${input.username}` } : {}),
        ...(input.bio ? { description: clamp(input.bio, 250) } : {}),
        ...(image ? { image } : {}),
        url,
      },
    },
  };
}

export interface PostMetaInput {
  postId: string;
  body?: string | null;
  imageUrl?: string | null;
  authorName?: string | null;
  authorUsername?: string | null;
  createdAt?: string | null;
}

export function buildPostMeta(input: PostMetaInput): FeedMeta {
  const author = input.authorName || (input.authorUsername ? `@${input.authorUsername}` : 'Forsure');
  const snippet = clamp(input.body, 140) || `Publication de ${author}`;
  const title = `${author} — ${clamp(input.body, 60) || 'Publication'}`;
  const description = clamp(
    `${snippet}${input.body && input.body.length > 140 ? '' : ''} · Lire la publication sur Forsure, réseau social éthique sans publicité.`,
    160,
  );
  const url = `${SITE_BASE}/post/${input.postId}`;
  const image = absUrl(input.imageUrl) || DEFAULT_IMAGE;

  return {
    title,
    description,
    url,
    image,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'SocialMediaPosting',
      headline: clamp(input.body, 110) || 'Publication Forsure',
      url,
      ...(input.imageUrl ? { image } : {}),
      ...(input.createdAt ? { datePublished: input.createdAt } : {}),
      author: {
        '@type': 'Person',
        name: author,
        ...(input.authorUsername ? { alternateName: `@${input.authorUsername}` } : {}),
      },
      publisher: { '@type': 'Organization', name: 'Forsure', url: SITE_BASE },
    },
  };
}
