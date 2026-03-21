import { useEffect } from 'react';

interface SEOHeadProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
  username?: string;
  noindex?: boolean;
}

/**
 * Dynamic SEO component — updates document head meta tags.
 * Use on profile pages, channel pages, etc. for rich link previews.
 * 
 * Twitter tags use `name` attribute (not `property`) per spec.
 */
export function SEOHead({ title, description, image, url, type = 'website', username, noindex }: SEOHeadProps) {
  useEffect(() => {
    const siteName = 'Forsure';
    const siteBase = 'https://forsure.fans';
    const fullTitle = title
      ? `${title} — ${siteName}`
      : 'Forsure — Réseau social éthique sans pub | Alternative Facebook & Instagram';
    const desc = description || 'Forsure est le réseau social éthique français sans publicité ni tracking. Messagerie privée, live streaming, marketplace et canaux TV.';
    const pageUrl = url || `${siteBase}${window.location.pathname}`;
    const ogImage = image || `${siteBase}/og-image.png`;

    document.title = fullTitle;

    const setMeta = (attr: 'property' | 'name', key: string, content: string) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    // Canonical link
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', pageUrl);

    // Robots
    if (noindex) {
      setMeta('name', 'robots', 'noindex, nofollow');
    } else {
      const robotsEl = document.querySelector('meta[name="robots"]');
      if (robotsEl) robotsEl.remove();
    }

    // Standard meta
    setMeta('name', 'description', desc);

    // Open Graph (use property)
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', desc);
    setMeta('property', 'og:type', type === 'profile' ? 'profile' : type === 'video' ? 'video.other' : 'website');
    setMeta('property', 'og:site_name', siteName);
    setMeta('property', 'og:image', ogImage);
    setMeta('property', 'og:image:alt', title || siteName);
    setMeta('property', 'og:url', pageUrl);
    setMeta('property', 'og:locale', 'fr_FR');

    // Twitter Card (use name, NOT property — per Twitter spec)
    setMeta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
    setMeta('name', 'twitter:site', '@forsure');
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', desc);
    setMeta('name', 'twitter:image', ogImage);
    setMeta('name', 'twitter:image:alt', title || siteName);

    // JSON-LD structured data
    let jsonLd = document.querySelector('#seo-jsonld');
    if (!jsonLd) {
      jsonLd = document.createElement('script');
      jsonLd.setAttribute('type', 'application/ld+json');
      jsonLd.setAttribute('id', 'seo-jsonld');
      document.head.appendChild(jsonLd);
    }

    const schemaType = type === 'profile' ? 'Person' : type === 'video' ? 'VideoObject' : 'SocialMediaPosting';
    const structuredData: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': schemaType,
      name: title || siteName,
      description: desc,
      url: pageUrl,
    };
    if (username) structuredData.alternateName = `@${username}`;
    if (image) structuredData.image = image;
    if (schemaType === 'SocialMediaPosting') {
      structuredData.author = { '@type': 'Person', name: title?.split(' —')[0] || siteName };
      structuredData.datePublished = new Date().toISOString();
      structuredData.publisher = { '@type': 'Organization', name: siteName, url: 'https://forsure.fans' };
    }
    if (schemaType === 'Person') {
      structuredData.sameAs = pageUrl;
    }

    jsonLd.textContent = JSON.stringify(structuredData);

    return () => {
      document.title = 'Forsure — Réseau social éthique sans pub | Alternative Facebook & Instagram';
    };
  }, [title, description, image, url, type, username, noindex]);

  return null;
}
