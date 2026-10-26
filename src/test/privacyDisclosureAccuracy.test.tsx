import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/components/SEOHead', () => ({ SEOHead: () => null }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock('@/pages/Feed', () => ({ default: () => <div>Feed unchanged</div> }));

import PrivacyPolicy from '@/pages/PrivacyPolicy';
import LegalTerms from '@/pages/LegalTerms';
import Landing from '@/pages/Landing';

afterEach(cleanup);

it.each([PrivacyPolicy, LegalTerms])('explains actual browser storage and the limits of deletion', Component => {
  const { container } = render(<MemoryRouter><Component /></MemoryRouter>);
  expect(container.textContent).toContain('localStorage');
  expect(container.textContent).toContain('JavaScript');
  expect(container.textContent).toMatch(/coffre.*chiffré/);
  expect(container.textContent).toContain('sauvegardes');
  expect(container.textContent).not.toContain('Suppression immédiate');
  expect(container.textContent).not.toContain('effective immédiatement');
  expect(container.textContent).not.toContain('Secure, HttpOnly');
  expect(container.textContent).not.toContain('jamais votre appareil');
});

it('names the actual Cloud/Aegis hosts and does not invent EU-only hosting', () => {
  const { container } = render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
  for (const supplier of ['Lovable Cloud', 'Vercel', 'Cloudflare R2', 'Stripe', 'LiveKit', 'DB-IP']) {
    expect(container.textContent).toContain(supplier);
  }
  expect(container.textContent).not.toContain("Les données sont hébergées au sein de l'Union Européenne");
});

it('keeps the parental PIN disabled and private messages out of ad profiling', () => {
  const { container } = render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
  expect(container.textContent).toContain('Le contrôle parental par code PIN est désactivé');
  expect(container.textContent).toContain('Aucun message privé, audio privé ou journal intime');
  expect(container.textContent).toContain('Vous ne verrez jamais de publicité basée sur vos messages privés');
});

it('shows accurate FAQ answers without loading the authenticated feed', () => {
  const { container } = render(<MemoryRouter><Landing /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Comment Forsure protège ma vie privée ?' }));
  expect(container.textContent).toContain('localStorage');
  fireEvent.click(screen.getByRole('button', { name: 'Comment mes messages sont-ils protégés ?' }));
  expect(container.textContent).toContain('coffre chiffré');
  expect(container.textContent).not.toContain('100% sans pub');
  expect(screen.queryByText('Feed unchanged')).toBeNull();
});

it('grounds the storage disclosure in the existing adapter, without replacing it', () => {
  const adapter = readFileSync('src/integrations/supabase/previewAuthStorage.ts', 'utf8');
  expect(adapter).toContain('return localStorage');
});

it('does not advertise an ad-free service in the static HTML or shared SEO defaults', () => {
  for (const file of ['index.html', 'src/components/SEOHead.tsx']) {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/zéro pub|zero publicité|sans pub/i);
  }
});
