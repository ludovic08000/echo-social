import logoSrc from "@/assets/forsure-logo.jpg";

/**
 * Official Forsure brand logo (yin-yang "fs" mark + wordmark + tagline).
 * Used across Landing, Login, Signup, loading screens, headers, OG/SEO.
 */
export default function BrandLogo({ className = "h-12" }: { className?: string }) {
  return (
    <img
      src={logoSrc}
      alt="Forsure — Connecter · Partager · Avancer"
      className={`${className} object-contain select-none`}
      draggable={false}
      loading="eager"
      decoding="async"
    />
  );
}
