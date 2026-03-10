import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';

export interface ImportedContact {
  user_id: string;
  name: string;
  avatar_url: string | null;
  phone_number: string;
  is_friend: boolean;
  contact_name: string;
}

interface ImportResult {
  matches: ImportedContact[];
  total_contacts: number;
  total_emails: number;
  total_phones: number;
}

// Google OAuth config
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/contacts.readonly';

// Microsoft OAuth config  
const MICROSOFT_SCOPES = 'Contacts.Read';

export function useOAuthContactsImport() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<ImportedContact[]>([]);
  const [imported, setImported] = useState(false);
  const [stats, setStats] = useState<{ total: number; emails: number; phones: number } | null>(null);

  const importGoogleContacts = useCallback(async (clientId: string) => {
    if (!user) return;
    setLoading(true);

    try {
      // Use Google Identity Services tokenClient
      const accessToken = await getGoogleAccessToken(clientId);
      if (!accessToken) {
        setLoading(false);
        return;
      }

      // Send to edge function
      const result = await callImportFunction(accessToken, 'google');
      handleResult(result);
    } catch (err: any) {
      console.error('Google import error:', err);
      toast({
        title: 'Erreur',
        description: err.message || 'Impossible d\'importer les contacts Google',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [user]);

  const importMicrosoftContacts = useCallback(async (clientId: string) => {
    if (!user) return;
    setLoading(true);

    try {
      const accessToken = await getMicrosoftAccessToken(clientId);
      if (!accessToken) {
        setLoading(false);
        return;
      }

      const result = await callImportFunction(accessToken, 'microsoft');
      handleResult(result);
    } catch (err: any) {
      console.error('Microsoft import error:', err);
      toast({
        title: 'Erreur',
        description: err.message || 'Impossible d\'importer les contacts Outlook',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [user]);

  const callImportFunction = async (accessToken: string, provider: string): Promise<ImportResult> => {
    const { data, error } = await supabase.functions.invoke('import-google-contacts', {
      body: { access_token: accessToken, provider },
    });

    if (error) throw error;
    return data as ImportResult;
  };

  const handleResult = (result: ImportResult) => {
    setMatches(result.matches);
    setStats({
      total: result.total_contacts,
      emails: result.total_emails,
      phones: result.total_phones,
    });
    setImported(true);

    if (result.matches.length > 0) {
      toast({
        title: `🎉 ${result.matches.length} contact(s) trouvé(s) sur Forsure !`,
        description: `${result.total_contacts} contacts analysés`,
      });
    } else {
      toast({
        title: 'Aucun contact trouvé',
        description: `${result.total_contacts} contacts analysés, aucun n'est sur Forsure`,
      });
    }
  };

  return {
    loading,
    matches,
    imported,
    stats,
    importGoogleContacts,
    importMicrosoftContacts,
  };
}

// ---------- Google OAuth via popup ----------
function getGoogleAccessToken(clientId: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Load Google Identity Services if not already loaded
    const scriptId = 'google-gsi-script';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => initGoogleToken(clientId, resolve);
      document.head.appendChild(script);
    } else {
      initGoogleToken(clientId, resolve);
    }
  });
}

function initGoogleToken(clientId: string, resolve: (token: string | null) => void) {
  const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_SCOPES,
    callback: (response: any) => {
      if (response.error) {
        console.error('Google OAuth error:', response);
        resolve(null);
      } else {
        resolve(response.access_token);
      }
    },
  });

  tokenClient.requestAccessToken({ prompt: 'consent' });
}

// ---------- Microsoft OAuth via popup ----------
function getMicrosoftAccessToken(clientId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const redirectUri = window.location.origin + '/friends';
    const state = 'ms_contacts_' + Math.random().toString(36).slice(2);
    
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(MICROSOFT_SCOPES)}` +
      `&state=${state}` +
      `&response_mode=fragment`;

    const popup = window.open(authUrl, 'msauth', 'width=500,height=700,popup=yes');

    if (!popup) {
      toast({ title: 'Popup bloqué', description: 'Autorisez les popups pour importer vos contacts', variant: 'destructive' });
      resolve(null);
      return;
    }

    const interval = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(interval);
          resolve(null);
          return;
        }
        const hash = popup.location.hash;
        if (hash && hash.includes('access_token')) {
          clearInterval(interval);
          popup.close();
          const params = new URLSearchParams(hash.substring(1));
          resolve(params.get('access_token'));
        }
      } catch {
        // Cross-origin - wait for redirect
      }
    }, 500);

    // Timeout after 2 minutes
    setTimeout(() => {
      clearInterval(interval);
      if (!popup.closed) popup.close();
      resolve(null);
    }, 120000);
  });
}
