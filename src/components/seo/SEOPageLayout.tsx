import { Link } from 'react-router-dom';
import { SEOHead } from '@/components/SEOHead';
import BrandLogo from '@/components/BrandLogo';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReactNode } from 'react';

interface SEOPageLayoutProps {
  title: string;
  description: string;
  url?: string;
  children: ReactNode;
  jsonLd?: Record<string, unknown>;
}

const footerLinks = [
  { label: 'Réseau social sécurisé', href: '/reseau-social-securise' },
  { label: 'Messagerie chiffrée', href: '/messagerie-chiffree' },
  { label: 'Modération IA', href: '/ia-moderation' },
  { label: 'Protection des données', href: '/protection-donnees' },
  { label: 'Feed intelligent', href: '/feed-intelligent' },
];

export function SEOPageLayout({ title, description, url, children, jsonLd }: SEOPageLayoutProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SEOHead title={title} description={description} url={url} jsonLd={jsonLd} />

      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-lg border-b border-border/40">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <BrandLogo className="w-7 h-7" />
            <span className="font-bold text-lg text-foreground">Forsure</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <Link to="/reseau-social-securise" className="hover:text-foreground transition-colors">Sécurité</Link>
            <Link to="/messagerie-chiffree" className="hover:text-foreground transition-colors">Messagerie</Link>
            <Link to="/ia-moderation" className="hover:text-foreground transition-colors">Modération IA</Link>
            <Link to="/protection-donnees" className="hover:text-foreground transition-colors">Protection</Link>
            <Link to="/feed-intelligent" className="hover:text-foreground transition-colors">Feed</Link>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/login">
              <Button variant="ghost" size="sm">Connexion</Button>
            </Link>
            <Link to="/signup">
              <Button size="sm" className="gap-1">
                S'inscrire <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main>{children}</main>

      {/* Footer SEO */}
      <footer className="border-t border-border/40 bg-muted/20">
        <div className="max-w-6xl mx-auto px-4 py-12">
          <div className="grid md:grid-cols-3 gap-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <BrandLogo className="w-6 h-6" />
                <span className="font-bold text-foreground">Forsure</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Le réseau social éthique français. 100 % gratuit, sans publicité, sans tracking. Vos données restent les vôtres.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-foreground mb-3">Fonctionnalités</h3>
              <ul className="space-y-2">
                {footerLinks.map(l => (
                  <li key={l.href}>
                    <Link to={l.href} className="text-sm text-muted-foreground hover:text-foreground transition-colors">{l.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-foreground mb-3">Légal</h3>
              <ul className="space-y-2">
                <li><Link to="/legal" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Conditions d'utilisation</Link></li>
                <li><Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Politique de confidentialité</Link></li>
              </ul>
            </div>
          </div>
          <div className="mt-8 pt-6 border-t border-border/30 text-center text-xs text-muted-foreground">
            © {new Date().getFullYear()} Forsure — Réseau social éthique français. Tous droits réservés.
          </div>
        </div>
      </footer>
    </div>
  );
}
