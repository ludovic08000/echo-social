import { useEffect } from 'react';

interface SEOHeadProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
  username?: string;
}

/**
 * Dynamic SEO component — updates document head meta tags.
 * Use on profile pages, channel pages, etc. for rich link previews.
 */
export function SEOHead({ title, description, image, url, type = 'website', username }: SEOHeadProps) {
  useEffect(() => {
    const siteName = 'Forsure';
    const fullTitle = title ? `${title} — ${siteName}` : siteName;
    const desc = description || 'Le réseau social éthique, sans tracking publicitaire.';

    document.title = fullTitle;

    const setMeta = (property: string, content: string) => {
      let el = document.querySelector(`meta[property="${property}"]`) || document.querySelector(`meta[name="${property}"]`);
      if (!el) {
        el = document.createElement('meta');
        if (property.startsWith('og:') || property.startsWith('twitter:')) {
          el.setAttribute('property', property);
        } else {
          el.setAttribute('name', property);
        }
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    setMeta('description', desc);
    setMeta('og:title', fullTitle);
    setMeta('og:description', desc);
    setMeta('og:type', type);
    setMeta('og:site_name', siteName);
    if (image) setMeta('og:image', image);
    if (url) setMeta('og:url', url);
    setMeta('twitter:card', image ? 'summary_large_image' : 'summary');
    setMeta('twitter:title', fullTitle);
    setMeta('twitter:description', desc);
    if (image) setMeta('twitter:image', image);

    // JSON-LD structured data
    let jsonLd = document.querySelector('#seo-jsonld');
    if (!jsonLd) {
      jsonLd = document.createElement('script');
      jsonLd.setAttribute('type', 'application/ld+json');
      jsonLd.setAttribute('id', 'seo-jsonld');
      document.head.appendChild(jsonLd);
    }

    const structuredData: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': type === 'profile' ? 'Person' : 'WebPage',
      name: title || siteName,
      description: desc,
      url: url || window.location.href,
    };
    if (username) structuredData.alternateName = `@${username}`;
    if (image) structuredData.image = image;

    jsonLd.textContent = JSON.stringify(structuredData);

    return () => {
      document.title = `${siteName} — Réseau social nouvelle génération`;
    };
  }, [title, description, image, url, type, username]);

  return null;
}
