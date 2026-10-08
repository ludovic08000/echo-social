// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261008203014_disable_parental_controls.sql',
  'utf8',
);

const uid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

describe('global parental-control kill switch', () => {
  it('deactivates existing rows and prevents later reactivation', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE TABLE public.parental_controls (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL UNIQUE,
          pin_hash text NOT NULL,
          is_minor boolean NOT NULL DEFAULT true,
          allowed_categories text[] NOT NULL DEFAULT ARRAY[]::text[],
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);

      await db.query(
        'INSERT INTO public.parental_controls(id,user_id,pin_hash) VALUES($1,$1,$2)',
        [uid(1), 'legacy-hash'],
      );

      await db.exec(migration);

      expect((await db.query(
        'SELECT is_active,is_minor FROM public.parental_controls WHERE user_id=$1',
        [uid(1)],
      )).rows[0]).toEqual({ is_active: false, is_minor: false });

      await db.query(
        'UPDATE public.parental_controls SET is_active=true,is_minor=true WHERE user_id=$1',
        [uid(1)],
      );
      expect((await db.query(
        'SELECT is_active,is_minor FROM public.parental_controls WHERE user_id=$1',
        [uid(1)],
      )).rows[0]).toEqual({ is_active: false, is_minor: false });

      await db.query(
        'INSERT INTO public.parental_controls(id,user_id,pin_hash,is_active,is_minor) VALUES($1,$1,$2,true,true)',
        [uid(2), 'new-hash'],
      );
      expect((await db.query(
        'SELECT is_active,is_minor FROM public.parental_controls WHERE user_id=$1',
        [uid(2)],
      )).rows[0]).toEqual({ is_active: false, is_minor: false });

      expect((await db.query('SELECT public.is_user_minor($1) AS value', [uid(1)])).rows[0])
        .toEqual({ value: false });
      expect((await db.query('SELECT public.is_user_protected_minor($1) AS value', [uid(1)])).rows[0])
        .toEqual({ value: false });
      expect((await db.query(
        'SELECT public.current_viewer_parental_post_allowed($1,$2) AS value',
        [uid(10), 'contenu'],
      )).rows[0]).toEqual({ value: true });
    } finally {
      await db.close();
    }
  });

  it('removes PIN collection and parental network calls from signup', () => {
    const signup = readFileSync('src/pages/Signup.tsx', 'utf8');
    const onboarding = readFileSync('src/pages/Onboarding.tsx', 'utf8');
    const storage = readFileSync('src/lib/signupIntegrity.ts', 'utf8');

    expect(signup).not.toContain('parentalPin');
    expect(signup).not.toContain('Protection parentale');
    expect(onboarding).not.toContain("functions.invoke('verify-parental-pin'");
    expect(storage).not.toContain('parentalPin');
  });
});
