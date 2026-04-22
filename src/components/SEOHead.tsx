import { Helmet } from 'react-helmet-async';

interface SEOHeadProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
  username?: string;
  noindex?: boolean;
  jsonLd?: Record<string, unknown>;
}

const SITE_NAME = 'Forsure';
const SITE_BASE = 'https://forsure.fans';
const DEFAULT_IMAGE = `${SITE_BASE}/og-image.jpg`;
const DEFAULT_DESC = "Forsure est le réseau social éthique français 100% gratuit, sans publicité ni tracking. Messagerie privée chiffrée, live streaming, marketplace, appels vidéo et canaux TV.";

/**
 * SEO component using react-helmet-async.
 * Inject directly in any page; Helmet merges & deduplicates head tags.
 */
export function SEOHead({ title, description, image, url, type = 'website', username, noindex, jsonLd }: SEOHeadProps) {
  const fullTitle = title ? `${title} — ${SITE_NAME}` : `${SITE_NAME} — Réseau social gratuit sans pub | Alternative Facebook Instagram TikTok`;
  const desc = description || DEFAULT_DESC;
  const pageUrl = url || (typeof window !== 'undefined' ? `${SITE_BASE}${window.location.pathname}` : SITE_BASE);
  const ogImage = image || DEFAULT_IMAGE;
  const ogType = type === 'profile' ? 'profile' : type === 'video' ? 'video.other' : 'website';

  const structuredData: Record<string, unknown> | null = jsonLd ?? (username ? {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: title || SITE_NAME,
    description: desc,
    url: pageUrl,
    alternateName: `@${username}`,
    ...(image ? { image } : {}),
  } : null);

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={desc} />
      <link rel="canonical" href={pageUrl} />
      {noindex && <meta name="robots" content="noindex, follow" />}

      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={desc} />
      <meta property="og:type" content={ogType} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:url" content={pageUrl} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:alt" content={title || SITE_NAME} />
      <meta property="og:locale" content="fr_FR" />

      {/* Twitter */}
      <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:site" content="@forsure" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={desc} />
      <meta name="twitter:image" content={ogImage} />
      <meta name="twitter:image:alt" content={title || SITE_NAME} />

      {structuredData && (
        <script type="application/ld+json">{JSON.stringify(structuredData)}</script>
      )}
    </Helmet>
  );
}
