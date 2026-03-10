import { Contacts } from '@capacitor-community/contacts';
import { Capacitor } from '@capacitor/core';

export interface ForgeContact {
  givenName: string;
  familyName: string;
  fullName: string;
  phoneNumbers: string[];
  emails: string[];
}

export async function importDeviceContacts(): Promise<ForgeContact[]> {
  const platform = Capacitor.getPlatform();

  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Import des contacts disponible uniquement sur mobile natif');
  }

  const permission = await Contacts.requestPermissions();

  if (permission.contacts !== 'granted') {
    throw new Error('Permission contacts refusée');
  }

  const { contacts } = await Contacts.getContacts({
    projection: {
      name: true,
      phones: true,
      emails: true,
    },
  });

  return contacts.map(c => {
    const givenName = c.name?.given?.trim() || '';
    const familyName = c.name?.family?.trim() || '';
    const fullName = c.name?.display?.trim() || `${givenName} ${familyName}`.trim();

    const phoneNumbers = (c.phones || [])
      .map(p => (p.number || '').replace(/[^+0-9]/g, ''))
      .filter(p => p.length >= 6);

    const emails = (c.emails || [])
      .map(e => (e.address || '').trim().toLowerCase())
      .filter(e => e.length > 0);

    return { givenName, familyName, fullName, phoneNumbers, emails };
  }).filter(c => c.phoneNumbers.length > 0 || c.emails.length > 0);
}

/** @deprecated Use importDeviceContacts instead */
export const importIOSContacts = importDeviceContacts;
