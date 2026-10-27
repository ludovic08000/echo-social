import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('internal consoles architecture', () => {
  it('gates both internal routes with authentication and an admin authorization boundary', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('<ProtectedRoute><AdminRoute><AIEngine /></AdminRoute></ProtectedRoute>');
    expect(app).toContain('<ProtectedRoute><AdminRoute><Admin /></AdminRoute></ProtectedRoute>');
  });

  it('fails closed when the role lookup fails', () => {
    const route = read('src/components/AdminRoute.tsx');
    expect(route).toContain('if (isError || !isAdmin)');
    expect(route).toContain('<Navigate to="/feed" replace />');
  });

  it('keeps platform diagnostics and global learning actions behind the server admin gate', () => {
    const edgeFunction = read('supabase/functions/ai-engine/index.ts');
    for (const action of [
      'profile_risk',
      'detect_intrusion',
      'analyze_ip',
      'inspect_packet',
      'scan_vulnerabilities',
      'analyze_session',
      'learn_feedback',
      'get_feedback_history',
    ]) {
      expect(edgeFunction).toContain(`"${action}"`);
    }
    expect(edgeFunction).toContain('status: 403');
    expect(edgeFunction).toContain('Accès interne requis');
  });

  it('requires a valid user JWT at the Edge Function gateway', () => {
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.ai-engine\]\s+verify_jwt = true/);
  });
});
