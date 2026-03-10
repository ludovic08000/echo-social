import { Capacitor } from '@capacitor/core';
import { ContactsPlugin, type ForgeContact } from '@/plugins/contacts';

export { type ForgeContact } from '@/plugins/contacts';

export async function importDeviceContacts(): Promise<ForgeContact[]> {
  const platform = Capacitor.getPlatform();

  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Import des contacts disponible uniquement sur mobile natif');
  }

  const permission = await ContactsPlugin.requestPermission();

  if (!permission.granted) {
    throw new Error('Permission contacts refusée');
  }

  const { contacts } = await ContactsPlugin.getContacts();
  return contacts;
}

/** @deprecated Use importDeviceContacts instead */
export const importIOSContacts = importDeviceContacts;
