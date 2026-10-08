// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261008200503_retire_automatic_photo_age_flags.sql',
  'utf8',
);

const uid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

describe('retired automatic photo-age verification', () => {
  it('cleans only untouched automatic flags and preserves manual or submitted reviews', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE SCHEMA auth;
        CREATE TYPE public.app_role AS ENUM ('admin', 'user');
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
          AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
          AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
        CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean
          LANGUAGE sql STABLE AS $$ SELECT false $$;
        CREATE TABLE public.profiles (
          user_id uuid PRIMARY KEY,
          age_verified boolean NOT NULL DEFAULT false,
          age_verification_status text NOT NULL DEFAULT 'none',
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE public.parental_controls (
          user_id uuid PRIMARY KEY,
          is_active boolean NOT NULL DEFAULT true,
          is_minor boolean NOT NULL DEFAULT true,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE public.identity_verifications (
          id uuid PRIMARY KEY,
          reported_user_id uuid NOT NULL,
          reporter_id uuid NOT NULL,
          reason text,
          status text NOT NULL,
          id_document_url text,
          verified_at timestamptz,
          deadline_at timestamptz NOT NULL DEFAULT now() + interval '72 hours',
          auto_deleted boolean NOT NULL DEFAULT false,
          admin_note text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);

      for (const n of [1, 2, 3, 4]) {
        await db.query("INSERT INTO profiles(user_id,age_verification_status) VALUES($1,'flagged')", [uid(n)]);
        await db.query('INSERT INTO parental_controls(user_id) VALUES($1)', [uid(n)]);
      }
      await db.query(`INSERT INTO identity_verifications(id,reported_user_id,reporter_id,reason,status)
        VALUES($1,$2,$2,$3,'pending')`, [uid(101), uid(1), "Vérification d'âge automatique : estimation test"]);
      await db.query(`INSERT INTO identity_verifications(id,reported_user_id,reporter_id,reason,status)
        VALUES($1,$2,$3,'Signalement manuel','pending')`, [uid(102), uid(2), uid(9)]);
      await db.query(`INSERT INTO identity_verifications(id,reported_user_id,reporter_id,reason,status,id_document_url)
        VALUES($1,$2,$2,$3,'document_submitted',$4)`, [uid(103), uid(3), "Vérification d'âge automatique : estimation test", `${uid(3)}/id.jpg`]);
      await db.query(`INSERT INTO identity_verifications(id,reported_user_id,reporter_id,reason,status,id_document_url)
        VALUES($1,$2,$2,$3,'pending',$4)`, [uid(104), uid(4), "Vérification d'âge automatique : estimation test", `${uid(4)}/id.jpg`]);

      await db.exec(migration);

      const profile = async (n: number) => (await db.query(
        'SELECT age_verified,age_verification_status FROM profiles WHERE user_id=$1', [uid(n)],
      )).rows[0] as { age_verified: boolean; age_verification_status: string };
      const control = async (n: number) => (await db.query(
        'SELECT is_active,is_minor FROM parental_controls WHERE user_id=$1', [uid(n)],
      )).rows[0] as { is_active: boolean; is_minor: boolean };

      expect(await profile(1)).toEqual({ age_verified: false, age_verification_status: 'none' });
      expect(await control(1)).toEqual({ is_active: false, is_minor: false });
      expect((await db.query('SELECT status,auto_deleted FROM identity_verifications WHERE id=$1', [uid(101)])).rows[0])
        .toEqual({ status: 'deleted', auto_deleted: true });

      expect((await profile(2)).age_verification_status).toBe('flagged');
      expect((await control(2)).is_active).toBe(true);
      expect((await profile(3)).age_verification_status).toBe('flagged');
      expect((await profile(4)).age_verification_status).toBe('flagged');

      await db.query("SELECT set_config('request.jwt.claims',$1,false)", ['{"role":"service_role"}']);
      const result = await db.query(
        "SELECT admin_update_identity_verification($1,'verified',NULL,NULL) AS updated",
        [uid(103)],
      );
      expect(result.rows[0]).toEqual({ updated: true });
      expect(await profile(3)).toEqual({ age_verified: true, age_verification_status: 'verified' });
      expect(await control(3)).toEqual({ is_active: false, is_minor: false });
    } finally {
      await db.close();
    }
  });

  it('returns a neutral response before the legacy Edge Function can mutate state', () => {
    const edge = readFileSync('supabase/functions/age-verify/index.ts', 'utf8');
    const hook = readFileSync('src/hooks/useAgeVerification.ts', 'utf8');
    expect(edge.indexOf("status: 'retired'")).toBeGreaterThan(0);
    expect(edge.indexOf("status: 'retired'")).toBeLessThan(edge.indexOf('const serviceClient'));
    expect(hook).not.toContain("functions.invoke('age-verify'");
    expect(hook).toContain('flagged: false');
  });
});
